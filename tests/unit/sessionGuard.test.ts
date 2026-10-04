import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { AuthError, type Verifier } from "../../src/auth/core/verifier.js";
import { SessionGuard, VERIFICATIONS_PER_MINUTE_PER_IP } from "../../src/auth/session.guard.js";
import { createMemoryQuotaStore, type QuotaStore } from "../../src/common/core/quota.js";
import { ApiRefusal } from "../../src/common/http/refusal.js";
import type { Config } from "../../src/config/core/config.js";

const config = { trustedProxyHops: 0 } as Config;

type FakeRequest = {
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  session?: unknown;
};

function guardWith(options: { isPublic?: boolean; verify?: Verifier; quotas?: QuotaStore }) {
  const reflector = { getAllAndOverride: () => options.isPublic ?? false } as unknown as Reflector;
  const verify: Verifier =
    options.verify ?? (async () => ({ sessionId: "session-1", startedAt: null }));
  return new SessionGuard(reflector, config, options.quotas ?? createMemoryQuotaStore(), verify);
}

function contextOf(req: FakeRequest): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const request = (authorization?: string): FakeRequest => ({
  headers: authorization === undefined ? {} : { authorization },
  socket: { remoteAddress: "198.51.100.7" },
});

async function refusalOf(guard: SessionGuard, req: FakeRequest) {
  try {
    await guard.canActivate(contextOf(req));
  } catch (error) {
    if (error instanceof ApiRefusal) {
      return {
        status: error.answer.status,
        body: JSON.parse(error.answer.body!),
        headers: error.answer.headers,
      };
    }
    throw error;
  }
  return null;
}

describe("the session guard", () => {
  it("lets a request with a valid token through and attaches its session", async () => {
    const req = request("Bearer aaa.bbb.ccc");
    expect(await guardWith({}).canActivate(contextOf(req))).toBe(true);
    expect(req.session).toEqual({ sessionId: "session-1", startedAt: null });
  });

  it("refuses a request with no token, without asking the verifier", async () => {
    let asked = 0;
    const guard = guardWith({
      verify: async () => {
        asked += 1;
        return { sessionId: "s", startedAt: null };
      },
    });
    for (const header of [undefined, "", "Basic abc", "Bearer", "Bearer not-a-jwt"]) {
      expect(await refusalOf(guard, request(header))).toEqual({
        status: 401,
        body: { code: "unauthorized", error: "A valid session token is required." },
        headers: { "WWW-Authenticate": "Bearer" },
      });
    }
    expect(asked).toBe(0);
  });

  it("answers 401 to a token that does not verify, and to a session past its age", async () => {
    const failing = (failure: "unauthorized" | "session_expired") =>
      guardWith({
        verify: async () => {
          throw new AuthError(failure);
        },
      });
    expect(await refusalOf(failing("unauthorized"), request("Bearer a.b.c"))).toMatchObject({
      status: 401,
      body: { code: "unauthorized" },
    });
    expect(await refusalOf(failing("session_expired"), request("Bearer a.b.c"))).toMatchObject({
      status: 401,
      body: { code: "session_expired" },
    });
  });

  it("fails closed with 503 when the keys cannot be read, or on anything unexpected", async () => {
    const unavailable = guardWith({
      verify: async () => {
        throw new AuthError("unavailable");
      },
    });
    expect(await refusalOf(unavailable, request("Bearer a.b.c"))).toMatchObject({
      status: 503,
      body: { code: "unavailable" },
    });
    const broken = guardWith({
      verify: async () => {
        throw new TypeError("unexpected");
      },
    });
    expect(await refusalOf(broken, request("Bearer a.b.c"))).toMatchObject({ status: 503 });
  });

  it("answers a public route without looking at the token", async () => {
    const guard = guardWith({
      isPublic: true,
      verify: async () => {
        throw new Error("must not be called");
      },
    });
    expect(await guard.canActivate(contextOf(request()))).toBe(true);
  });

  it("stops verifying tokens for an address that sends too many", async () => {
    let limit = 0;
    const quotas: QuotaStore = {
      take(budgets) {
        limit = budgets[0].limit;
        expect(budgets[0]).toMatchObject({ scope: "ip", key: "verify|198.51.100.7" });
        return false;
      },
    };
    expect(await refusalOf(guardWith({ quotas }), request("Bearer a.b.c"))).toMatchObject({
      status: 429,
      body: { code: "rate_limited" },
    });
    expect(limit).toBe(VERIFICATIONS_PER_MINUTE_PER_IP);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOREIGN_ORIGIN, startApi, type Api } from "./support/harness.js";
import type { Received, Reply } from "./support/providers.js";

/** The two session routes, with a stand-in for Supabase Auth. */

let api: Api;
/** When the sessions the stand-in issues began, in seconds since the epoch. */
let startedAt: number;

const EXPIRES_AT = Math.floor(Date.now() / 1000) + 3_600;

/** Supabase Auth as this API uses it: anonymous sign-up, and the refresh grant. */
async function supabase(request: Received): Promise<Reply> {
  if (request.path === "/auth/v1/.well-known/jwks.json") {
    return { body: { keys: api.providers.state.jwks } };
  }
  const issued = async () => ({
    body: {
      access_token: await api.token({ startedAt }),
      token_type: "bearer",
      expires_in: 3_600,
      expires_at: EXPIRES_AT,
      refresh_token: "new-refresh-token",
      user: {
        id: "user-id",
        is_anonymous: true,
        created_at: new Date(startedAt * 1000).toISOString(),
      },
    },
  });
  if (request.path === "/auth/v1/signup") return issued();
  if (request.path === "/auth/v1/token?grant_type=refresh_token") {
    const { refresh_token: refreshToken } = JSON.parse(request.body) as { refresh_token: string };
    return refreshToken === "known-refresh-token"
      ? issued()
      : {
          status: 400,
          body: { error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" },
        };
  }
  return { status: 404, body: {} };
}

const start = (options: { ip?: string; headers?: Record<string, string> } = {}) =>
  api.call("/v1/session", { method: "POST", token: null, ...options });
const refresh = (refreshToken: unknown, options: { ip?: string } = {}) =>
  api.call("/v1/session/refresh", { token: null, body: { refreshToken }, ...options });

beforeEach(async () => {
  api = await startApi();
  startedAt = Math.floor(Date.now() / 1000) - 60;
  api.providers.answer("supabase", supabase);
});
afterEach(() => api.close());

describe("POST /v1/session", () => {
  it("starts an anonymous session without a token, and returns exactly three fields", async () => {
    const response = await start();
    expect(response.status).toBe(200);
    expect(Object.keys(response.json).sort()).toEqual(["accessToken", "expiresAt", "refreshToken"]);
    expect(response.json.refreshToken).toBe("new-refresh-token");
    // Unix time in seconds, as the identity provider states it.
    expect(response.json.expiresAt).toBe(EXPIRES_AT);
    expect(response.json.expiresAt).toBeLessThan(10_000_000_000);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("hands out a token every other route accepts", async () => {
    const { json } = await start();
    const response = await api.call("/v1/prices", { token: json.accessToken });
    expect(response.status).toBe(200);
  });

  it("asks the identity provider itself, with its own key and nothing of the caller", async () => {
    await start({
      ip: "203.0.113.61",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh) Chrome/140",
        cookie: "a=b",
        "x-forwarded-for": "203.0.113.61",
      },
    });
    const [sent] = api.providers.sentTo("supabase");
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/auth/v1/signup");
    expect(sent.body).toBe("{}");
    expect(sent.headers.apikey).toBe("sb_publishable_integration");
    expect(sent.headers["user-agent"]).toBe("Mozilla/5.0 (compatible; NoirWire)");
    const everything = JSON.stringify(sent);
    for (const secret of ["203.0.113.61", "Chrome/140", "a=b"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("ignores whatever body it is sent, and refuses one over the cap", async () => {
    const withBody = await api.call("/v1/session", {
      token: null,
      body: { email: "someone@example.com", data: { wallet: "address" } },
    });
    expect(withBody.status).toBe(200);
    expect(api.providers.sentTo("supabase")[0].body).toBe("{}");
    const large = await api.call("/v1/session", { token: null, body: { pad: "x".repeat(2_000) } });
    expect([large.status, large.json.code]).toEqual([413, "request_too_large"]);
  });

  it("answers 503 when the identity provider is down", async () => {
    api.providers.answer("supabase", (request) =>
      request.path.endsWith("jwks.json") ? supabase(request) : { status: 500, body: "down" },
    );
    const response = await start();
    expect(response.status).toBe(503);
    expect(response.json).toEqual({
      code: "unavailable",
      error: "The service this request needs is not available. Nothing was done.",
    });
  });

  it("never answers 401 because the identity provider refused this server's own key", async () => {
    api.providers.answer("supabase", (request) =>
      request.path.endsWith("jwks.json")
        ? supabase(request)
        : { status: 401, body: { message: "Invalid API key" } },
    );
    const response = await start();
    expect(response.status).toBe(502);
    expect(response.json.code).toBe("upstream_refused");
    expect(api.logged).toContainEqual({
      event: "operator_error",
      route: "session",
      status: 401,
      reason: "supabase_refused_credentials",
    });
  });

  it("rations sessions per address: the twenty-first in a minute is refused, another address is served", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) statuses.push((await start({ ip: "203.0.113.62" })).status);
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    const refused = await start({ ip: "203.0.113.62" });
    expect(refused.json).toEqual({
      code: "rate_limited",
      error: "Too many requests. Wait and try again.",
    });
    expect((await start({ ip: "203.0.113.63" })).status).toBe(200);
    // What was refused never reached the identity provider.
    expect(api.providers.sentTo("supabase")).toHaveLength(21);
  });

  it("rations sessions in total, whoever asks", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 302; i += 1) statuses.push((await start()).status);
    expect(statuses.slice(0, 300).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(300)).toEqual([429, 429]);
  });

  it("passes the identity provider's own rate limit on as 429", async () => {
    api.providers.answer("supabase", (request) =>
      request.path.endsWith("jwks.json")
        ? supabase(request)
        : { status: 429, body: { msg: "over_request_rate_limit" } },
    );
    const response = await start();
    expect([response.status, response.json.code]).toEqual([429, "rate_limited"]);
  });

  it("refuses a browser on a foreign origin before asking anyone", async () => {
    const response = await start({ headers: { origin: FOREIGN_ORIGIN } });
    expect(response.status).toBe(403);
    expect(api.providers.sentTo("supabase")).toHaveLength(0);
  });
});

describe("POST /v1/session/refresh", () => {
  it("exchanges a refresh token for a new pair, in the same shape", async () => {
    const response = await refresh("known-refresh-token");
    expect(response.status).toBe(200);
    expect(Object.keys(response.json).sort()).toEqual(["accessToken", "expiresAt", "refreshToken"]);
    expect(response.json.expiresAt).toBe(EXPIRES_AT);
    const [sent] = api.providers.sentTo("supabase");
    expect(sent.path).toBe("/auth/v1/token?grant_type=refresh_token");
    expect(JSON.parse(sent.body)).toEqual({ refresh_token: "known-refresh-token" });
    expect(sent.headers.apikey).toBe("sb_publishable_integration");
  });

  it("refuses to renew a session past its maximum age, with a typed 401", async () => {
    startedAt = Math.floor(Date.now() / 1000) - 25 * 3_600;
    const response = await refresh("known-refresh-token");
    expect(response.status).toBe(401);
    expect(response.json).toEqual({
      code: "session_expired",
      error: "This session has reached its maximum age. Start a new one.",
    });
    // Just inside the limit, the same session is renewed.
    startedAt = Math.floor(Date.now() / 1000) - 23 * 3_600;
    expect((await refresh("known-refresh-token")).status).toBe(200);
  });

  it("honours a shorter maximum age when one is configured", async () => {
    const short = await startApi({ SESSION_MAX_AGE_HOURS: "1" });
    try {
      short.providers.answer("supabase", async (request) => {
        const reply = await supabase(request);
        if (typeof reply === "object" && request.path.includes("token")) {
          (reply.body as { access_token: string }).access_token = await short.token({ startedAt });
        }
        return request.path.endsWith("jwks.json")
          ? { body: { keys: short.providers.state.jwks } }
          : reply;
      });
      startedAt = Math.floor(Date.now() / 1000) - 2 * 3_600;
      const response = await short.call("/v1/session/refresh", {
        token: null,
        body: { refreshToken: "known-refresh-token" },
      });
      expect([response.status, response.json.code]).toEqual([401, "session_expired"]);
    } finally {
      await short.close();
    }
  });

  it("answers 401 session_invalid to a refresh token the identity provider does not know", async () => {
    const response = await refresh("unknown-refresh-token");
    expect(response.status).toBe(401);
    expect(response.json).toEqual({
      code: "session_invalid",
      error: "This session cannot be renewed. Start a new one.",
    });
    expect(response.text).not.toContain("Invalid Refresh Token");
  });

  it("refuses a body that is not exactly a refresh token, before asking anyone", async () => {
    for (const body of [
      {},
      { refreshToken: 7 },
      { refreshToken: "a b" },
      { refreshToken: "x", more: 1 },
      [],
    ]) {
      const response = await api.call("/v1/session/refresh", { token: null, body });
      expect([response.status, response.json.code]).toEqual([400, "invalid_request"]);
    }
    const notJson = await api.call("/v1/session/refresh", { token: null, body: "not json" });
    expect(notJson.status).toBe(400);
    expect(api.providers.sentTo("supabase")).toHaveLength(0);
  });

  it("answers 503 when the identity provider is down, and 502 when it refuses this server's key", async () => {
    api.providers.answer("supabase", (request) =>
      request.path.endsWith("jwks.json") ? supabase(request) : { status: 502, body: "bad gateway" },
    );
    const down = await refresh("known-refresh-token");
    expect([down.status, down.json.code]).toEqual([503, "unavailable"]);
    api.providers.answer("supabase", (request) =>
      request.path.endsWith("jwks.json") ? supabase(request) : { status: 403, body: {} },
    );
    const refused = await refresh("known-refresh-token");
    expect([refused.status, refused.json.code]).toEqual([502, "upstream_refused"]);
  });

  it("rations refreshes per address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 62; i += 1) {
      statuses.push((await refresh("known-refresh-token", { ip: "203.0.113.64" })).status);
    }
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429]);
    expect((await refresh("known-refresh-token", { ip: "203.0.113.65" })).status).toBe(200);
  });

  it("logs a fixed reason and never a token", async () => {
    await refresh("unknown-refresh-token");
    const { json } = await refresh("known-refresh-token");
    const everything = JSON.stringify(api.logged);
    expect(everything).toContain("refresh_token_refused");
    for (const secret of ["unknown-refresh-token", "known-refresh-token", json.accessToken]) {
      expect(everything).not.toContain(secret);
    }
  });
});

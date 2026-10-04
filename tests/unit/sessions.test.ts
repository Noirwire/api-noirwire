import { beforeEach, describe, expect, it } from "vitest";
import { AuthError, type Verifier } from "../../src/auth/core/verifier.js";
import type { LogLine } from "../../src/common/core/log.js";
import { createSessions } from "../../src/session/core/sessions.js";

const SUPABASE = "https://project.supabase.co";
const DAY_MS = 24 * 3_600_000;
const NOW = Date.parse("2026-10-04T12:00:00Z");

type Sent = { url: string; method?: string; headers: Record<string, string>; body?: string };

let sent: Sent[];
let logged: LogLine[];
let reply: (url: string) => Response | Promise<Response>;
let startedAt: number | null;
let verifyFailure: AuthError | null;

const issuedBy = (over: Record<string, unknown> = {}) => ({
  access_token: "access.token.value",
  refresh_token: "refresh-token-value",
  token_type: "bearer",
  expires_in: 3_600,
  expires_at: 1_790_000_000,
  user: { id: "user-id", is_anonymous: true, created_at: new Date(NOW - 60_000).toISOString() },
  ...over,
});

const verify: Verifier = async (_token, now = Date.now()) => {
  if (verifyFailure) throw verifyFailure;
  if (startedAt !== null && now - startedAt > DAY_MS) throw new AuthError("session_expired");
  return { sessionId: "session-id", startedAt };
};

const sessions = () =>
  createSessions(
    { supabaseUrl: SUPABASE, publishableKey: "sb_publishable_key", sessionMaxAgeMs: DAY_MS },
    {
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({
          url,
          method: init.method,
          headers: Object.fromEntries(new Headers(init.headers)),
          body: init.body as string | undefined,
        });
        return reply(url);
      }) as unknown as typeof fetch,
      verify,
      log: (line) => void logged.push(line),
    },
  );

/** The status and, for an error, its code; for a session, the session. */
const read = (answer: { status: number; body: string | null }) => {
  const json = answer.body === null ? null : JSON.parse(answer.body);
  return { status: answer.status, json: answer.status === 200 ? json : { code: json.code } };
};
const refresh = (body: unknown) =>
  sessions()
    .refresh(typeof body === "string" ? body : JSON.stringify(body), NOW)
    .then(read);

beforeEach(() => {
  sent = [];
  logged = [];
  startedAt = NOW - 60_000;
  verifyFailure = null;
  reply = () => Response.json(issuedBy());
});

describe("starting a session", () => {
  it("asks the identity provider for an anonymous session and hands out three fields", async () => {
    const answer = read(await sessions().start(NOW));
    expect(answer).toEqual({
      status: 200,
      json: {
        accessToken: "access.token.value",
        refreshToken: "refresh-token-value",
        expiresAt: 1_790_000_000,
      },
    });
  });

  it("builds the request itself: the publishable key, an empty body and nothing of the caller", async () => {
    await sessions().start(NOW);
    expect(sent).toEqual([
      {
        url: `${SUPABASE}/auth/v1/signup`,
        method: "POST",
        body: "{}",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 (compatible; NoirWire)",
          apikey: "sb_publishable_key",
        },
      },
    ]);
  });

  it("answers 503 when the provider is down, refuses, or cannot be reached", async () => {
    reply = () => new Response("oops", { status: 500 });
    expect(read(await sessions().start(NOW))).toEqual({
      status: 503,
      json: { code: "unavailable" },
    });
    reply = () => Response.json({ msg: "Anonymous sign-ins are disabled" }, { status: 422 });
    expect(read(await sessions().start(NOW)).status).toBe(503);
    reply = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    expect(read(await sessions().start(NOW)).status).toBe(503);
    expect(logged.map((line) => line.event === "refusal" && line.reason)).toEqual([
      "supabase_refused_signup",
      "supabase_refused_signup",
      "supabase_not_reached",
    ]);
  });

  it("passes the provider's own rate limit on as 429", async () => {
    reply = () => Response.json({ msg: "over_request_rate_limit" }, { status: 429 });
    expect(read(await sessions().start(NOW))).toEqual({
      status: 429,
      json: { code: "rate_limited" },
    });
  });

  it("hands out nothing it would not accept itself", async () => {
    verifyFailure = new AuthError("unauthorized");
    expect(read(await sessions().start(NOW)).status).toBe(503);
    verifyFailure = new AuthError("unavailable");
    expect(read(await sessions().start(NOW)).status).toBe(503);
  });

  it("hands out nothing that is not a whole session", async () => {
    for (const body of [
      {},
      issuedBy({ access_token: undefined }),
      issuedBy({ refresh_token: "" }),
      issuedBy({ expires_at: "soon" }),
      "<html>",
    ]) {
      reply = () =>
        typeof body === "string" ? new Response(body, { status: 200 }) : Response.json(body);
      expect(read(await sessions().start(NOW)).status).toBe(503);
    }
  });

  it("passes none of the provider's message or fields on", async () => {
    reply = () => Response.json(issuedBy({ user: { email: "someone@example.com" } }));
    const answer = await sessions().start(NOW);
    expect(Object.keys(JSON.parse(answer.body!)).sort()).toEqual([
      "accessToken",
      "expiresAt",
      "refreshToken",
    ]);
  });
});

describe("refreshing a session", () => {
  it("exchanges the refresh token and hands out the new pair", async () => {
    const answer = await refresh({ refreshToken: "old-refresh-token" });
    expect(answer.status).toBe(200);
    expect(answer.json.refreshToken).toBe("refresh-token-value");
    expect(sent[0].url).toBe(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`);
    expect(sent[0].body).toBe('{"refresh_token":"old-refresh-token"}');
    expect(sent[0].headers.apikey).toBe("sb_publishable_key");
  });

  it("refuses a body that is not exactly a refresh token, before asking anyone", async () => {
    for (const body of [
      "not json",
      {},
      [],
      { refreshToken: 7 },
      { refreshToken: "" },
      { refreshToken: "has spaces" },
      { refreshToken: "x".repeat(513) },
      { refreshToken: "ok", extra: true },
      { refresh_token: "ok" },
    ]) {
      expect(await refresh(body)).toEqual({ status: 400, json: { code: "invalid_request" } });
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses to renew a session past its maximum age", async () => {
    startedAt = NOW - DAY_MS - 1_000;
    expect(await refresh({ refreshToken: "old" })).toEqual({
      status: 401,
      json: { code: "session_expired" },
    });
    startedAt = NOW - DAY_MS + 60_000;
    expect((await refresh({ refreshToken: "old" })).status).toBe(200);
  });

  it("reads the session's age from the provider's answer when the token records none", async () => {
    startedAt = null;
    reply = () =>
      Response.json(
        issuedBy({ user: { created_at: new Date(NOW - DAY_MS - 60_000).toISOString() } }),
      );
    expect(await refresh({ refreshToken: "old" })).toEqual({
      status: 401,
      json: { code: "session_expired" },
    });
    reply = () =>
      Response.json(issuedBy({ user: { created_at: new Date(NOW - 3_600_000).toISOString() } }));
    expect((await refresh({ refreshToken: "old" })).status).toBe(200);
  });

  it("treats a session whose age cannot be told as too old, not as new", async () => {
    startedAt = null;
    reply = () => Response.json(issuedBy({ user: undefined }));
    expect((await refresh({ refreshToken: "old" })).json).toEqual({ code: "session_expired" });
    reply = () => Response.json(issuedBy({ user: { created_at: "not a date" } }));
    expect((await refresh({ refreshToken: "old" })).json).toEqual({ code: "session_expired" });
  });

  it("answers 401 session_invalid to a refresh token the provider turns down", async () => {
    for (const status of [400, 404, 422]) {
      reply = () => Response.json({ error_code: "refresh_token_not_found" }, { status });
      expect(await refresh({ refreshToken: "unknown" })).toEqual({
        status: 401,
        json: { code: "session_invalid" },
      });
    }
  });

  it("never answers 401 because the provider refused this server's own key", async () => {
    for (const status of [401, 403]) {
      reply = () => Response.json({ message: "Invalid API key" }, { status });
      expect(await refresh({ refreshToken: "old" })).toEqual({
        status: 502,
        json: { code: "upstream_refused" },
      });
      expect(read(await sessions().start(NOW))).toEqual({
        status: 502,
        json: { code: "upstream_refused" },
      });
    }
    expect(logged.every((line) => line.event === "operator_error")).toBe(true);
    expect(logged[0]).toEqual({
      event: "operator_error",
      route: "session",
      status: 401,
      reason: "supabase_refused_credentials",
    });
  });

  it("answers 503 when the provider is down, and 429 when it is rate limiting", async () => {
    reply = () => new Response("bad gateway", { status: 502 });
    expect((await refresh({ refreshToken: "old" })).status).toBe(503);
    reply = () => {
      throw new TypeError("fetch failed");
    };
    expect((await refresh({ refreshToken: "old" })).status).toBe(503);
    reply = () => new Response("slow down", { status: 429 });
    expect((await refresh({ refreshToken: "old" })).status).toBe(429);
  });

  it("logs a fixed reason and never a token", async () => {
    reply = () => Response.json({ error_code: "refresh_token_not_found" }, { status: 400 });
    await refresh({ refreshToken: "secret-refresh-token" });
    expect(logged).toEqual([
      { event: "refusal", route: "session", status: 401, reason: "refresh_token_refused" },
    ]);
  });
});

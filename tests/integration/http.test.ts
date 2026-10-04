import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ERRORS } from "../../src/common/core/answer.js";
import { sharedSecretToken, signingKey, sessionToken } from "../support/tokens.js";
import {
  ALLOWED_ORIGIN,
  ANSWER_HEADERS,
  answerHeaders,
  FOREIGN_ORIGIN,
  startApi,
  type Api,
} from "./support/harness.js";

const ADDRESS = "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ";
const balance = { jsonrpc: "2.0", id: 1, method: "getBalance", params: [ADDRESS] };
const SECRET = "a-shared-secret-of-at-least-32-characters";

/** Every route behind a session, with a request that would otherwise be accepted. */
const SESSION_ROUTES: [method: string, path: string, body?: unknown][] = [
  ["POST", "/v1/rpc", balance],
  ["GET", "/v1/jupiter/lend/v1/earn/tokens"],
  ["POST", "/v1/jupiter/swap/v2/execute", {}],
  ["POST", "/v1/private-payments/v1/spl/transfer", {}],
  ["GET", "/v1/relayer"],
  ["POST", "/v1/relayer", { method: "getPayerSigner" }],
  ["GET", "/v1/prices"],
  ["GET", "/v1/history/NVDAx/1D"],
  ["POST", "/v1/events", { path: "/" }],
];

let api: Api;

beforeAll(async () => {
  api = await startApi({ SUPABASE_JWT_SECRET: SECRET });
});
afterAll(() => api.close());
beforeEach(() => {
  api.providers.reset();
  api.logged.length = 0;
});

describe("GET /health", () => {
  it("answers without a session, and calls no provider", async () => {
    const response = await api.call("/health", { token: null });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ status: "ok" });
    expect(api.providers.received).toHaveLength(0);
  });
});

describe("every response", () => {
  it("carries the headers of a JSON API that is nothing else", async () => {
    for (const path of ["/health", "/v1/prices", "/nowhere"]) {
      const { headers } = await api.call(path, { token: null });
      expect(answerHeaders(headers)).toEqual(ANSWER_HEADERS);
      expect(headers.get("x-frame-options")).toBe("DENY");
      expect(headers.get("referrer-policy")).toBe("no-referrer");
      expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(headers.get("strict-transport-security")).toContain("max-age=");
      expect(headers.get("x-powered-by")).toBeNull();
      expect(headers.get("etag")).toBeNull();
      expect(headers.get("set-cookie")).toBeNull();
    }
  });

  it("answers an unknown path, and an unknown method, with a fixed JSON 404", async () => {
    for (const [method, path] of [
      ["GET", "/"],
      ["GET", "/v1"],
      ["GET", "/v1/rpc"],
      ["DELETE", "/v1/rpc"],
      ["GET", "/v1/events"],
      ["GET", "/api/rpc"],
    ]) {
      const response = await api.call(path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.json).toEqual({ code: "not_found", error: "There is nothing at this path." });
    }
  });

  it("writes every error in one shape: a listed code and its sentence, and nothing else", async () => {
    api.providers.answer("rpc", () => ({ status: 429, body: "slow down" }));
    const errors = [
      await api.call("/v1/rpc", { token: null, body: balance }),
      await api.call("/v1/rpc", { body: [] }),
      await api.call("/v1/rpc", { body: { ...balance, method: "getBlock" } }),
      await api.call("/v1/rpc", { body: balance }),
      await api.call("/v1/rpc", { body: balance, headers: { origin: FOREIGN_ORIGIN } }),
      await api.call("/v1/jupiter/nowhere", { body: {} }),
      await api.call("/v1/prices?x=1"),
      await api.call("/v1/relayer", { body: { method: "getPayerSigner" } }),
      await api.call("/nowhere"),
    ];
    expect(errors.map((response) => response.status)).toEqual([
      401, 400, 403, 429, 403, 404, 404, 503, 404,
    ]);
    for (const response of errors) {
      expect(Object.keys(response.json).sort()).toEqual(["code", "error"]);
      const listed = ERRORS[response.json.code as keyof typeof ERRORS];
      expect(listed, response.json.code).toBeDefined();
      expect([response.status, response.json.error]).toEqual([...listed]);
      expect(response.json.code).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it("gives every code exactly one status, and a sentence", () => {
    for (const [code, [status, sentence]] of Object.entries(ERRORS)) {
      expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(sentence.endsWith(".")).toBe(true);
    }
    const unauthorized = Object.entries(ERRORS)
      .filter(([, [status]]) => status === 401)
      .map(([code]) => code);
    // A 401 is only ever about the caller's own session.
    expect(unauthorized.sort()).toEqual(["session_expired", "session_invalid", "unauthorized"]);
  });
});

describe("the session every /v1 route requires", () => {
  it.each(SESSION_ROUTES)("%s %s refuses a request with no token", async (method, path, body) => {
    const response = await api.call(path, { method, body, token: null });
    expect(response.status).toBe(401);
    expect(response.json).toEqual({
      code: "unauthorized",
      error: "A valid session token is required.",
    });
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(api.providers.received).toHaveLength(0);
  });

  it.each(SESSION_ROUTES)("%s %s lets a valid session through", async (method, path, body) => {
    const response = await api.call(path, { method, body });
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it("refuses an expired token, a wrong issuer, a wrong audience and a bad signature", async () => {
    const stranger = await signingKey("integration-key");
    const tokens = {
      expired: await api.token({ expiresIn: -60 }),
      "wrong issuer": await api.token({ issuer: "https://other.supabase.co/auth/v1" }),
      "wrong audience": await api.token({ audience: "anon" }),
      "bad signature": await sessionToken(stranger, { issuer: api.issuer }),
      "not a token": "not.a.token",
      "the publishable key": "sb_publishable_integration",
    };
    for (const [name, token] of Object.entries(tokens)) {
      const response = await api.call("/v1/rpc", { body: balance, token });
      expect(response.status, name).toBe(401);
      expect(response.json.code, name).toBe("unauthorized");
    }
    expect(api.providers.sentTo("rpc")).toHaveLength(0);
  });

  it("refuses a valid token of a session past its maximum age, with its own code", async () => {
    const old = await api.token({ startedAt: Math.floor(Date.now() / 1000) - 25 * 3_600 });
    const response = await api.call("/v1/rpc", { body: balance, token: old });
    expect(response.status).toBe(401);
    expect(response.json).toEqual({
      code: "session_expired",
      error: "This session has reached its maximum age. Start a new one.",
    });
    expect(api.providers.sentTo("rpc")).toHaveLength(0);
  });

  it("refuses a valid token whose session age cannot be told, on every protected route", async () => {
    const ageless = await api.token({ startedAt: null });
    for (const [method, path, body] of SESSION_ROUTES) {
      const response = await api.call(path, { method, body, token: ageless });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.json.code).toBe("session_expired");
    }
    expect(api.providers.received).toHaveLength(0);
  });

  it("accepts a token signed with the project's shared secret, when one is configured", async () => {
    const token = await sharedSecretToken(SECRET, { issuer: api.issuer });
    expect((await api.call("/v1/rpc", { body: balance, token })).status).toBe(200);
    const forged = await sharedSecretToken("another-secret-of-at-least-32-characters", {
      issuer: api.issuer,
    });
    expect((await api.call("/v1/rpc", { body: balance, token: forged })).status).toBe(401);
  });

  it("takes the token from the Authorization header only", async () => {
    const token = await api.token();
    const elsewhere: Record<string, string>[] = [
      { cookie: `sb-access-token=${token}` },
      { "x-authorization": `Bearer ${token}` },
      { authorization: token },
      { authorization: `Basic ${token}` },
    ];
    for (const headers of elsewhere) {
      const response = await api.call("/v1/rpc", { body: balance, token: null, headers });
      expect(response.status).toBe(401);
    }
    const inQuery = await api.call(`/v1/prices?access_token=${token}`, { token: null });
    expect(inQuery.status).toBe(401);
  });
});

describe("cross-origin access", () => {
  const preflight = (origin: string, path = "/v1/rpc") =>
    api.call(path, {
      method: "OPTIONS",
      token: null,
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });

  it("answers a preflight from an allowed origin with exactly what the wallets use", async () => {
    const response = await preflight(ALLOWED_ORIGIN);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type",
    );
    expect(response.headers.get("access-control-max-age")).toBe("600");
    expect(response.headers.get("vary")).toContain("Origin");
    // The token travels in a header, so cookies are never allowed.
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("refuses a preflight from a foreign origin, with no CORS header at all", async () => {
    for (const origin of [
      FOREIGN_ORIGIN,
      "null",
      `${ALLOWED_ORIGIN}.evil.example`,
      "http://app.noirwire.example",
    ]) {
      const response = await preflight(origin);
      expect(response.status, origin).toBe(403);
      expect(response.json.code).toBe("origin_not_allowed");
      for (const header of [
        "access-control-allow-origin",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-allow-credentials",
      ]) {
        expect(response.headers.get(header)).toBeNull();
      }
      expect(response.headers.get("vary")).toContain("Origin");
    }
  });

  it("serves an allowed origin's request, and lets the page read how old a price is", async () => {
    const response = await api.call("/v1/prices", { headers: { origin: ALLOWED_ORIGIN } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get("access-control-expose-headers")).toBe("Age, Retry-After");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("refuses a foreign origin's request outright, even with a valid session", async () => {
    const response = await api.call("/v1/rpc", {
      body: balance,
      headers: { origin: FOREIGN_ORIGIN },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(api.providers.sentTo("rpc")).toHaveLength(0);
    const start = await api.call("/v1/session", {
      method: "POST",
      token: null,
      headers: { origin: FOREIGN_ORIGIN },
    });
    expect(start.status).toBe(403);
    expect(api.providers.sentTo("supabase")).toHaveLength(0);
  });

  it("serves a caller that names no origin, such as the mobile app, with no CORS header", async () => {
    const response = await api.call("/v1/rpc", { body: balance });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("the documentation", () => {
  it("serves Swagger UI at /docs without a session, under a policy it can render with", async () => {
    const response = await api.call("/docs", { token: null });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.text).toContain("swagger-ui");
    const policy = response.headers.get("content-security-policy");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("serves the OpenAPI document at /docs-json", async () => {
    const response = await api.call("/docs-json", { token: null });
    expect(response.status).toBe(200);
    expect(response.json.openapi).toMatch(/^3\./);
    expect(Object.keys(response.json.paths)).toContain("/v1/rpc");
  });
});

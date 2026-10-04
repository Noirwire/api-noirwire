import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AuthError,
  bearerToken,
  createVerifier,
  type Verifier,
} from "../../src/auth/core/verifier.js";
import {
  jwksServer,
  sessionToken,
  sharedSecretToken,
  signingKey,
  type SigningKey,
} from "../support/tokens.js";

const SECRET = "a-shared-secret-of-at-least-32-characters";
const DAY_MS = 24 * 3_600_000;

let keys: Awaited<ReturnType<typeof jwksServer>>;
let current: SigningKey;
let verify: Verifier;

const failure = async (token: string, using: Verifier = verify, now?: number) => {
  try {
    await using(token, now);
  } catch (error) {
    if (error instanceof AuthError) return error.failure;
    throw error;
  }
  return "accepted";
};

const verifier = (over: { jwtSecret?: string | null; jwksUrl?: string } = {}) =>
  createVerifier({
    issuer: keys.issuer,
    jwksUrl: over.jwksUrl ?? keys.jwksUrl,
    jwtSecret: over.jwtSecret ?? null,
    sessionMaxAgeMs: DAY_MS,
    jwksCooldownMs: 0,
  });

beforeAll(async () => {
  current = await signingKey("key-1");
  keys = await jwksServer([current.jwk]);
});
afterAll(() => keys.close());
beforeEach(() => {
  keys.state.keys = [current.jwk];
  keys.state.status = 200;
  verify = verifier();
});

describe("reading the Authorization header", () => {
  it("takes a bearer token and nothing else", () => {
    expect(bearerToken("Bearer aaa.bbb.ccc")).toBe("aaa.bbb.ccc");
    for (const header of [
      undefined,
      "",
      "aaa.bbb.ccc",
      "Basic aaa.bbb.ccc",
      "bearer aaa.bbb.ccc",
      "Bearer aaa.bbb",
      "Bearer aaa.bbb.ccc.ddd",
      "Bearer aaa.bbb.ccc extra",
      "Bearer  aaa.bbb.ccc",
      "Bearer aaa.b b.ccc",
      `Bearer ${"a".repeat(5_000)}.b.c`,
    ]) {
      expect(bearerToken(header)).toBeNull();
    }
  });
});

describe("verifying a session token against the project's published keys", () => {
  it("accepts a valid token and names its session", async () => {
    const token = await sessionToken(current, { issuer: keys.issuer, sessionId: "session-abc" });
    const session = await verify(token);
    expect(session.sessionId).toBe("session-abc");
    expect(typeof session.startedAt).toBe("number");
  });

  it("falls back to the subject when the token names no session", async () => {
    const token = await sessionToken(current, {
      issuer: keys.issuer,
      sessionId: null,
      sub: "user-123",
    });
    expect((await verify(token)).sessionId).toBe("user-123");
  });

  it("accepts an RSA-signed token too", async () => {
    const rsa = await signingKey("rsa-1", "RS256");
    keys.state.keys = [current.jwk, rsa.jwk];
    expect(await failure(await sessionToken(rsa, { issuer: keys.issuer }))).toBe("accepted");
  });

  it("refuses an expired token, and allows a few seconds of clock difference", async () => {
    const expired = await sessionToken(current, { issuer: keys.issuer, expiresIn: -60 });
    expect(await failure(expired)).toBe("unauthorized");
    const justNow = await sessionToken(current, { issuer: keys.issuer, expiresIn: -2 });
    expect(await failure(justNow)).toBe("accepted");
  });

  it("refuses a token from another issuer", async () => {
    const token = await sessionToken(current, { issuer: "https://other.supabase.co/auth/v1" });
    expect(await failure(token)).toBe("unauthorized");
  });

  it("refuses a token for another audience", async () => {
    for (const audience of ["anon", "service_role", "other"]) {
      const token = await sessionToken(current, { issuer: keys.issuer, audience });
      expect(await failure(token)).toBe("unauthorized");
    }
  });

  it("refuses a token signed by a key the project does not publish", async () => {
    const stranger = await signingKey("key-1");
    const token = await sessionToken(stranger, { issuer: keys.issuer });
    expect(await failure(token)).toBe("unauthorized");
  });

  it("refuses a token whose payload was changed after signing", async () => {
    const token = await sessionToken(current, { issuer: keys.issuer, sessionId: "mine" });
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        iss: keys.issuer,
        aud: "authenticated",
        sub: "x",
        session_id: "someone-else",
        exp: Math.floor(Date.now() / 1000) + 3_600,
      }),
    ).toString("base64url");
    expect(await failure(`${header}.${forged}.${signature}`)).toBe("unauthorized");
  });

  it("refuses a token with no expiry, no subject, or no usable session id", async () => {
    const sign = (payload: Record<string, unknown>) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: "ES256", kid: current.kid })
        .setIssuer(keys.issuer)
        .setAudience("authenticated")
        .sign(current.privateKey);
    const later = Math.floor(Date.now() / 1000) + 600;
    expect(await failure(await sign({ sub: "user" }))).toBe("unauthorized");
    expect(await failure(await sign({ exp: later }))).toBe("unauthorized");
    expect(await failure(await sign({ exp: later, sub: "x".repeat(200) }))).toBe("unauthorized");
    expect(await failure(await sign({ exp: later, sub: "user", session_id: 7 }))).toBe("accepted");
  });

  it("refuses an unsigned token and one that is not a token", async () => {
    const body = Buffer.from(
      JSON.stringify({ iss: keys.issuer, aud: "authenticated", sub: "x", exp: 9_999_999_999 }),
    ).toString("base64url");
    const none = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    expect(await failure(`${none}.${body}.`)).toBe("unauthorized");
    expect(await failure("not.a.token")).toBe("unauthorized");
    expect(await failure("a".repeat(5_000))).toBe("unauthorized");
  });

  it("picks up a rotated key, and stops accepting the one that was withdrawn", async () => {
    const before = await sessionToken(current, { issuer: keys.issuer });
    expect(await failure(before)).toBe("accepted");

    const next = await signingKey("key-2");
    const after = await sessionToken(next, { issuer: keys.issuer });
    // Not published yet: unknown key.
    expect(await failure(after)).toBe("unauthorized");
    // Published next to the old one: both verify, with no restart.
    keys.state.keys = [current.jwk, next.jwk];
    expect(await failure(after)).toBe("accepted");
    expect(await failure(before)).toBe("accepted");

    // The old key withdrawn: a fresh verifier (an empty cache, as after the
    // cache runs out) no longer accepts tokens it signed.
    keys.state.keys = [next.jwk];
    const fresh = verifier();
    expect(await failure(after, fresh)).toBe("accepted");
    expect(await failure(before, fresh)).toBe("unauthorized");
  });

  it("caches the keys instead of asking for them on every request", async () => {
    const token = await sessionToken(current, { issuer: keys.issuer });
    const fresh = verifier();
    const before = keys.state.requests;
    for (let i = 0; i < 5; i += 1) await fresh(token);
    expect(keys.state.requests - before).toBe(1);
  });

  it("says the keys are unavailable, not that the token is bad, when they cannot be read", async () => {
    const token = await sessionToken(current, { issuer: keys.issuer });
    keys.state.status = 500;
    expect(await failure(token, verifier())).toBe("unavailable");
    const nowhere = verifier({ jwksUrl: "http://127.0.0.1:9/auth/v1/.well-known/jwks.json" });
    expect(await failure(token, nowhere)).toBe("unavailable");
  });
});

describe("verifying a session token against a shared secret", () => {
  it("accepts an HS256 token when the project's secret is configured", async () => {
    const token = await sharedSecretToken(SECRET, { issuer: keys.issuer, sessionId: "hs-session" });
    expect((await verifier({ jwtSecret: SECRET })(token)).sessionId).toBe("hs-session");
  });

  it("refuses an HS256 token signed with another secret", async () => {
    const token = await sharedSecretToken("another-secret-of-at-least-32-characters", {
      issuer: keys.issuer,
    });
    expect(await failure(token, verifier({ jwtSecret: SECRET }))).toBe("unauthorized");
  });

  it("holds an HS256 token to the same issuer, audience and expiry", async () => {
    const withSecret = verifier({ jwtSecret: SECRET });
    const cases = [
      { issuer: "https://other.supabase.co/auth/v1" },
      { issuer: keys.issuer, audience: "anon" },
      { issuer: keys.issuer, expiresIn: -60 },
    ];
    for (const claims of cases) {
      expect(await failure(await sharedSecretToken(SECRET, claims), withSecret)).toBe(
        "unauthorized",
      );
    }
  });

  it("refuses every HS256 token when no secret is configured", async () => {
    const token = await sharedSecretToken(SECRET, { issuer: keys.issuer });
    expect(await failure(token)).toBe("unauthorized");
  });

  it("never uses a published public key as a shared secret", async () => {
    // The classic confusion: sign with HS256 using the public key's bytes,
    // and hope the verifier treats the key it fetched as an HMAC secret.
    const publicBytes = new TextEncoder().encode(JSON.stringify(current.jwk));
    const forged = await new SignJWT({ session_id: "forged" })
      .setProtectedHeader({ alg: "HS256", kid: current.kid })
      .setIssuer(keys.issuer)
      .setAudience("authenticated")
      .setSubject("x")
      .setExpirationTime("1h")
      .sign(publicBytes);
    expect(await failure(forged)).toBe("unauthorized");
    expect(await failure(forged, verifier({ jwtSecret: SECRET }))).toBe("unauthorized");
  });

  it("still verifies asymmetric tokens when a secret is configured as well", async () => {
    const token = await sessionToken(current, { issuer: keys.issuer });
    expect(await failure(token, verifier({ jwtSecret: SECRET }))).toBe("accepted");
  });
});

describe("the age of a session", () => {
  it("refuses a valid token of a session past its maximum age", async () => {
    const now = Date.now();
    const old = await sessionToken(current, {
      issuer: keys.issuer,
      startedAt: Math.floor((now - DAY_MS - 60_000) / 1000),
    });
    expect(await failure(old)).toBe("session_expired");
    const young = await sessionToken(current, {
      issuer: keys.issuer,
      startedAt: Math.floor((now - DAY_MS + 60_000) / 1000),
    });
    expect(await failure(young)).toBe("accepted");
  });

  it("goes by the earliest moment the session records, however often it was refreshed", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await sessionToken(current, {
      issuer: keys.issuer,
      startedAt: null,
      extra: {
        amr: [
          { method: "token_refresh", timestamp: now - 10 },
          { method: "anonymous", timestamp: now - 2 * 86_400 },
        ],
      },
    });
    expect(await failure(token)).toBe("session_expired");
  });

  it("reports no start for a token that records none", async () => {
    const token = await sessionToken(current, { issuer: keys.issuer, startedAt: null });
    expect((await verify(token)).startedAt).toBeNull();
  });
});

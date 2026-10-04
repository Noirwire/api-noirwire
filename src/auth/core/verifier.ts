import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
} from "jose";

/**
 * Verifies the session tokens this API hands out. They are Supabase
 * anonymous sessions: a token proves that this project issued it and that it
 * has not expired, and nothing about who holds it. Its `session_id` is the
 * key rate limits are counted under.
 *
 * A project signs with an asymmetric key (published at its JWKS address,
 * cached here and read again when a token names a key that is not in the
 * cache, which is how a rotated key is picked up) or, on older projects,
 * with one shared secret. Which one a token is checked against is decided
 * by the algorithm this server allows, never by what the token asks for: a
 * shared-secret token is only accepted when a secret is configured, and an
 * asymmetric key is never used as a shared secret.
 */

export type VerifierConfig = {
  issuer: string;
  jwksUrl: string;
  /** The project's shared secret, for projects that still sign with one. */
  jwtSecret: string | null;
  /** A session older than this is refused, however fresh its token. */
  sessionMaxAgeMs: number;
  /** How long to wait before asking for the keys again after a miss. */
  jwksCooldownMs?: number;
};

export type Session = {
  /** The key this caller's limits are counted under. Never stored, never logged. */
  sessionId: string;
  /** When the session began, in milliseconds. */
  startedAt: number;
};

export type AuthFailure =
  /** No token, or one that does not verify. */
  | "unauthorized"
  /** A valid token of a session past its maximum age: start a new one. */
  | "session_expired"
  /** The keys could not be read, so nothing can be verified. */
  | "unavailable";

export class AuthError extends Error {
  constructor(readonly failure: AuthFailure) {
    super(failure);
    this.name = "AuthError";
  }
}

export const AUDIENCE = "authenticated";
const CLOCK_TOLERANCE_SECONDS = 5;
const ASYMMETRIC_ALGORITHMS = ["ES256", "RS256", "EdDSA"];
/** A session token is about a kilobyte. Nothing longer is even decoded. */
const MAX_TOKEN_CHARS = 4_096;
const MAX_ID_CHARS = 128;

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/** The token in an `Authorization` header, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (!header || header.length > MAX_TOKEN_CHARS + 7) return null;
  return BEARER.exec(header)?.[1] ?? null;
}

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;

/**
 * When the session began: the earliest moment its authentication methods
 * record (`amr`, which Supabase writes into every access token, with the
 * time of the anonymous sign-in). It stays the same however often the
 * session is refreshed, which `iat` does not: that is renewed with each
 * token, so it says nothing of the session's age and is not used.
 */
export function sessionStartedAt(claims: JWTPayload): number | null {
  const { amr } = claims;
  if (!Array.isArray(amr)) return null;
  const times = amr
    .map((entry) => (entry as { timestamp?: unknown } | null)?.timestamp)
    .filter(
      (time): time is number => typeof time === "number" && Number.isFinite(time) && time > 0,
    );
  return times.length > 0 ? Math.min(...times) * 1000 : null;
}

export type Verifier = (token: string, now?: number) => Promise<Session>;

export function createVerifier(config: VerifierConfig): Verifier {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
    cooldownDuration: config.jwksCooldownMs ?? 30_000,
    cacheMaxAge: 10 * 60_000,
    timeoutDuration: 5_000,
  });
  const secret = config.jwtSecret === null ? null : new TextEncoder().encode(config.jwtSecret);
  const expected = {
    issuer: config.issuer,
    audience: AUDIENCE,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    requiredClaims: ["exp", "sub"],
  };

  async function claimsOf(token: string, now: number): Promise<JWTPayload> {
    let algorithm: string | undefined;
    try {
      algorithm = decodeProtectedHeader(token).alg;
    } catch {
      throw new AuthError("unauthorized");
    }
    const currentDate = new Date(now);
    if (algorithm === "HS256") {
      if (!secret) throw new AuthError("unauthorized");
      const verified = await jwtVerify(token, secret, {
        ...expected,
        currentDate,
        algorithms: ["HS256"],
      });
      return verified.payload;
    }
    const verified = await jwtVerify(token, jwks, {
      ...expected,
      currentDate,
      algorithms: ASYMMETRIC_ALGORITHMS,
    });
    return verified.payload;
  }

  return async (token, now = Date.now()) => {
    if (token.length > MAX_TOKEN_CHARS) throw new AuthError("unauthorized");
    let claims: JWTPayload;
    try {
      claims = await claimsOf(token, now);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      // A token that fails a check is the caller's; keys that cannot be
      // fetched are not. The two are told apart so an outage of the key
      // endpoint is not reported to every wallet as a bad token.
      const refused =
        error instanceof errors.JOSEError &&
        !(error instanceof errors.JWKSTimeout) &&
        error.code !== "ERR_JOSE_GENERIC";
      throw new AuthError(refused ? "unauthorized" : "unavailable");
    }
    const sessionId = isId(claims.session_id) ? claims.session_id : claims.sub;
    if (!isId(sessionId)) throw new AuthError("unauthorized");
    // A session whose age cannot be told is treated as too old, not as new.
    const startedAt = sessionStartedAt(claims);
    if (startedAt === null || now - startedAt > config.sessionMaxAgeMs) {
      throw new AuthError("session_expired");
    }
    return { sessionId, startedAt };
  };
}

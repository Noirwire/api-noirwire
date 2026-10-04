import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";

/** A signing key as a Supabase project holds one: a private key, and the public half it publishes. */
export type SigningKey = { kid: string; alg: string; privateKey: CryptoKey; jwk: JWK };

export async function signingKey(
  kid: string,
  alg: "ES256" | "RS256" = "ES256",
): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { kid, alg, privateKey, jwk };
}

export type Claims = {
  issuer: string;
  audience?: string;
  sub?: string;
  sessionId?: string | null;
  /** Seconds from now until expiry; negative for a token already expired. */
  expiresIn?: number;
  /** When the session began, in seconds since the epoch. Omitted from the token when null. */
  startedAt?: number | null;
  now?: number;
  extra?: Record<string, unknown>;
};

function claimsOf(claims: Claims) {
  const now = Math.floor((claims.now ?? Date.now()) / 1000);
  const startedAt = claims.startedAt === undefined ? now - 60 : claims.startedAt;
  return {
    payload: {
      role: "authenticated",
      is_anonymous: true,
      ...(claims.sessionId === null
        ? {}
        : { session_id: claims.sessionId ?? "7f1c7f5e-0c7e-4f0b-9d55-6a1f2d3c4b5a" }),
      ...(startedAt === null ? {} : { amr: [{ method: "anonymous", timestamp: startedAt }] }),
      ...claims.extra,
    },
    now,
  };
}

/** A session token as the project's Auth server signs one with an asymmetric key. */
export function sessionToken(key: SigningKey, claims: Claims): Promise<string> {
  const { payload, now } = claimsOf(claims);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: "JWT" })
    .setIssuer(claims.issuer)
    .setAudience(claims.audience ?? "authenticated")
    .setSubject(claims.sub ?? "0b6f5a1e-2d3c-4b5a-8f7e-9d0c1b2a3f4e")
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.expiresIn ?? 3_600))
    .sign(key.privateKey);
}

/** The same, signed with a project's shared secret. */
export function sharedSecretToken(secret: string, claims: Claims): Promise<string> {
  const { payload, now } = claimsOf(claims);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(claims.issuer)
    .setAudience(claims.audience ?? "authenticated")
    .setSubject(claims.sub ?? "0b6f5a1e-2d3c-4b5a-8f7e-9d0c1b2a3f4e")
    .setIssuedAt(now)
    .setExpirationTime(now + (claims.expiresIn ?? 3_600))
    .sign(new TextEncoder().encode(secret));
}

/** A local stand-in for a project's key endpoint. `keys` and `status` can be changed while it runs. */
export async function jwksServer(initial: JWK[]) {
  const state = { keys: initial, status: 200, requests: 0 };
  const server: Server = createServer((_req, res) => {
    state.requests += 1;
    res.writeHead(state.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: state.keys }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const supabaseUrl = `http://127.0.0.1:${port}`;
  return {
    state,
    supabaseUrl,
    issuer: `${supabaseUrl}/auth/v1`,
    jwksUrl: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

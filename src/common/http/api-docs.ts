import { applyDecorators } from "@nestjs/common";
import { ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { ERRORS, type ErrorCode } from "../core/answer.js";

/** The name of the bearer scheme in the OpenAPI document. */
export const SESSION_SCHEME = "session";

const errorSchema = {
  type: "object" as const,
  description:
    "Every error has this shape: a stable `code` to act on and a plain sentence. The codes are listed in the introduction.",
  properties: {
    code: { type: "string" as const, enum: Object.keys(ERRORS) },
    error: { type: "string" as const },
  },
  required: ["code", "error"],
};

type Examples = Record<string, { summary: string; value: unknown }>;

export function jsonResponse(status: number, description: string, examples: Examples) {
  return ApiResponse({
    status,
    description,
    content: { "application/json": { schema: { type: "object" }, examples } },
  });
}

/**
 * An error response, with one example per code. Each example is the exact
 * body: the code and its sentence come from the one list of errors, so the
 * documentation cannot drift from what is sent.
 */
export function errorResponse(
  status: number,
  description: string,
  codes: Partial<Record<ErrorCode, string>>,
) {
  const examples: Examples = {};
  for (const [code, summary] of Object.entries(codes) as [ErrorCode, string][]) {
    const [ownStatus, error] = ERRORS[code];
    if (ownStatus !== status)
      throw new Error(`${code} is a ${ownStatus}, documented as ${status}.`);
    examples[code] = { summary, value: { code, error } };
  }
  return ApiResponse({
    status,
    description,
    content: { "application/json": { schema: errorSchema, examples } },
  });
}

const UNAUTHORIZED =
  "The session token is not accepted here: none was sent, it does not verify (wrong signature, issuer or audience, or expired), or its session is past its maximum age. This status never means anything else: a provider refusing this server's own credentials is a `502 upstream_refused`. Start or refresh a session and try again.";
const FOREIGN_ORIGIN =
  "The request names an `Origin` that is not on this API's list. Browsers on other sites are refused; a caller with no `Origin` (the mobile app, a server) is not affected.";
const RATE_LIMITED =
  "A quota is spent: this session's, this address's or the route's as a whole, each counted per minute, or the provider's own rate limit passed on. Nothing was done with the request. Wait and retry with backoff.";
const KEYS_UNAVAILABLE =
  "The keys that verify session tokens could not be read, so no token can be checked. Nothing was done with the request.";

type Extra = Partial<Record<ErrorCode, string>>;

/**
 * What every route behind a session can answer before its own logic runs.
 * A route that has more to say under one of these statuses passes its own
 * codes and they are listed next to the shared ones.
 */
export function SessionRequired(more: { 403?: Extra; 503?: Extra; describe503?: string } = {}) {
  return applyDecorators(
    ApiBearerAuth(SESSION_SCHEME),
    errorResponse(401, UNAUTHORIZED, {
      unauthorized: "Missing or invalid token",
      session_expired: "The session is past its maximum age: start a new one",
    }),
    errorResponse(403, FOREIGN_ORIGIN, { origin_not_allowed: "Foreign origin", ...more[403] }),
    errorResponse(429, RATE_LIMITED, { rate_limited: "Quota spent" }),
    errorResponse(503, more.describe503 ?? KEYS_UNAVAILABLE, {
      unavailable: "Token keys unavailable",
      ...more[503],
    }),
  );
}

/** What a route that reads a request body can answer about the body itself. */
export function BodyLimits(maxBytes: number) {
  return applyDecorators(
    errorResponse(408, "The request body did not arrive within 5 seconds.", {
      request_timeout: "Body too slow",
    }),
    errorResponse(
      413,
      `The request body is larger than ${maxBytes.toLocaleString("en-US")} bytes. Reading stops at the limit.`,
      { request_too_large: "Body too large" },
    ),
  );
}

/** What a route that relays to a provider can answer when the provider fails. */
export function UpstreamFailures(provider: string) {
  return applyDecorators(
    errorResponse(
      502,
      `${provider} gave no usable answer (not JSON, larger than this route passes on, or the connection broke), or refused this server's own credentials (it answered 401 or 403, which is never passed on as such). Its body is not passed on in either case.`,
      {
        upstream_failed: "Unusable upstream answer",
        upstream_refused: "The provider refused this server's key: an operator's to fix",
      },
    ),
    errorResponse(504, `${provider} did not answer within 30 seconds.`, {
      upstream_timeout: "Upstream timed out",
    }),
  );
}

/** Dummy values for examples. None of these is a real account or a real token. */
export const EXAMPLE = {
  address: "11111111111111111111111111111111",
  otherAddress: "Examp1eAddress1111111111111111111111111111",
  mint: "ExampLeMint11111111111111111111111111111111",
  transaction: "AQAAAA...base64...AAAA=",
  token: "eyJhbGciOiJFUzI1NiJ9.example-payload.example-signature",
  refreshToken: "example-refresh-token",
} as const;

import { applyDecorators } from "@nestjs/common";
import { ApiBearerAuth, ApiResponse } from "@nestjs/swagger";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "node:buffer";
import { base58 } from "../../chain/core/bytes.js";
import { ERRORS, type ErrorCode } from "../core/answer.js";

/** The name of the bearer scheme in the OpenAPI document. */
export const SESSION_SCHEME = "session";

type Schema = Record<string, unknown>;
type Examples = Record<string, { summary: string; value: unknown }>;

/** How many seconds old a cached answer is. */
const AGE_HEADER = {
  Age: {
    description:
      "How old the data is, in whole seconds: the time since this server read it from its source.",
    schema: { type: "integer", minimum: 0 },
  },
};

/** A successful answer: what it is, the shape of its body, and examples of it. */
export function ok(
  description: string,
  schema: Schema,
  examples: Examples,
  options: { status?: number; age?: boolean } = {},
) {
  return ApiResponse({
    status: options.status ?? 200,
    description,
    ...(options.age ? { headers: AGE_HEADER } : {}),
    content: { "application/json": { schema, examples } },
  });
}

/** For each code a route can answer with, what it means there. */
type Codes = Partial<Record<ErrorCode, string>>;
type StatusDocs = { why: string; codes: Codes };

export type RouteErrors = {
  /** The route requires a session token. */
  session?: boolean;
  /** The route reads a body, capped at this many bytes. */
  body?: number;
  /** The route relays to this provider. */
  upstream?: string;
  /** What the route itself answers, by status. Said first. */
  own?: Partial<Record<number, StatusDocs>>;
};

/**
 * Every error a route can answer with, by status: the reasons, and the
 * stable codes as an enum with the exact body of each as an example. The
 * codes and sentences come from the one list of errors, so the
 * documentation cannot drift from what is sent.
 */
export function ApiErrors(route: RouteErrors = {}) {
  const statuses = new Map<number, StatusDocs[]>();
  const add = (status: number, why: string, codes: Codes) =>
    statuses.set(status, [...(statuses.get(status) ?? []), { why, codes }]);

  for (const [status, docs] of Object.entries(route.own ?? {})) {
    if (docs) add(Number(status), docs.why, docs.codes);
  }
  add(
    400,
    "The request carries a query string. No route takes one, and one is refused everywhere.",
    {
      invalid_request: "A query string, or a malformed request",
    },
  );
  if (route.session) {
    add(
      401,
      "The session token is not accepted here: none was sent, it does not verify (wrong signature, issuer or audience, or expired), or its session is past its maximum age or of an age that cannot be established. This status never means anything else: a provider refusing this server's own credentials is never a `401`. Start or refresh a session and try again.",
      {
        unauthorized: "Missing or invalid token",
        session_expired: "The session is past its maximum age: start a new one",
      },
    );
  }
  add(
    403,
    "The request names an `Origin` that is not on this API's list. Browsers on other sites are refused; a caller with no `Origin` (the mobile app, a server) is not affected.",
    { origin_not_allowed: "Foreign origin" },
  );
  if (route.body !== undefined) {
    add(408, "The request body did not arrive within 5 seconds.", {
      request_timeout: "Body too slow",
    });
    add(
      413,
      `The request body is larger than ${route.body.toLocaleString("en-US")} bytes. Reading stops at the limit.`,
      { request_too_large: "Body too large" },
    );
  }
  if (route.session) {
    add(
      429,
      "A quota is spent (this session's, this address's or the route's as a whole), this server is holding back to stay inside a provider's allowance (then with a `Retry-After` header, in seconds), or the provider's own rate limit is passed on. Nothing was done with the request. Wait and retry with backoff.",
      { rate_limited: "Quota spent" },
    );
  }
  add(500, "An unexpected failure in this API. Nothing of it is described: a fixed message only.", {
    internal_error: "Unexpected failure",
  });
  if (route.upstream) {
    add(
      502,
      `${route.upstream} gave no usable answer (not JSON, larger than this route passes on, or the connection broke), or refused this server's own credentials (it answered 401 or 403, which is never passed on as such and is logged as an operator error). Its body is not passed on in either case.`,
      {
        upstream_failed: "Unusable upstream answer",
        upstream_refused: "The provider refused this server's key: an operator's to fix",
      },
    );
    add(503, `${route.upstream} could not be connected to at all, so it never saw the request.`, {
      upstream_not_reached: "Provider not reached: it never saw the request",
    });
  }
  if (route.session) {
    add(
      503,
      "The keys that verify session tokens could not be read, so no token can be checked. Nothing was done with the request.",
      { unavailable: "Token keys unavailable" },
    );
  }
  if (route.upstream) {
    add(504, `${route.upstream} did not answer within 30 seconds.`, {
      upstream_timeout: "Upstream timed out",
    });
  }
  add(504, "This API did not finish answering within 60 seconds.", {
    response_timeout: "The response took too long",
  });

  const responses = [...statuses.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, parts]) => {
      const examples: Examples = {};
      for (const { codes } of parts) {
        for (const [code, summary] of Object.entries(codes) as [ErrorCode, string][]) {
          const [ownStatus, error] = ERRORS[code];
          if (ownStatus !== status) {
            throw new Error(`${code} is a ${ownStatus}, documented as ${status}.`);
          }
          examples[code] ??= { summary, value: { code, error } };
        }
      }
      return ApiResponse({
        status,
        description: parts.map(({ why }) => why).join(" "),
        content: {
          "application/json": {
            schema: {
              type: "object",
              description: "Every error has this shape. `code` is stable; `error` is a sentence.",
              required: ["code", "error"],
              properties: {
                code: { type: "string", enum: Object.keys(examples) },
                error: { type: "string", description: "A plain sentence for a person." },
              },
            },
            examples,
          },
        },
      });
    });
  return applyDecorators(...(route.session ? [ApiBearerAuth(SESSION_SCHEME)] : []), ...responses);
}

/** A provider's own body, passed through: the fields the wallets read are named, others may be present. */
export function passedThrough(description: string, properties: Schema = {}): Schema {
  return { type: "object", description, additionalProperties: true, properties };
}

const filled = (length: number, byte: number) => new Uint8Array(length).fill(byte);
const exampleKey = (byte: number) => new PublicKey(filled(32, byte));

/** A well-formed transaction that does nothing and is signed by nobody. */
function exampleTransaction(): string {
  const message = new TransactionMessage({
    payerKey: exampleKey(1),
    recentBlockhash: exampleKey(3).toBase58(),
    instructions: [],
  }).compileToLegacyMessage();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

/**
 * Dummy values for examples: each is well-formed (valid base58 or base64 of
 * the right length) and plainly made up (the all-ones key, keys of one
 * repeated byte, a signature of one repeated byte). None is a real account,
 * transaction or token.
 */
export const EXAMPLE = {
  /** The all-ones key (the System Program's address): the usual stand-in for "an address". */
  address: PublicKey.default.toBase58(),
  otherAddress: exampleKey(1).toBase58(),
  mint: exampleKey(2).toBase58(),
  blockhash: exampleKey(3).toBase58(),
  signature: base58(filled(64, 1)),
  transaction: exampleTransaction(),
  token: "eyJhbGciOiJFUzI1NiJ9.ZXhhbXBsZS1wYXlsb2Fk.ZXhhbXBsZS1zaWduYXR1cmU",
  refreshToken: "example-refresh-token",
} as const;

export const address = (description: string): Schema => ({
  type: "string",
  description: `${description} A Solana address: base58, 32 to 44 characters.`,
  pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$",
});

export const transaction = (description: string): Schema => ({
  type: "string",
  description: `${description} A whole serialized transaction, base64.`,
});

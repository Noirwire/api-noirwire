/**
 * What a route answers with: a status and a JSON body, or no body at all.
 * Every answer goes out as JSON and as nothing else (see `ANSWER_HEADERS`).
 */
export type Answer = {
  status: number;
  /** JSON text, or null for an empty body. */
  body: string | null;
  /** Extra headers this answer carries, on top of `ANSWER_HEADERS`. */
  headers?: Record<string, string>;
};

/**
 * The body of an answer may be a third party's. Were its content type passed
 * along, a provider that answered with HTML would be serving a page from
 * this API's origin. So the type is fixed, the browser is told not to guess
 * another, nothing is cached, and a direct visit downloads the answer
 * instead of rendering it under a policy that lets it load and run nothing.
 */
export const NO_DOCUMENT_POLICY = "default-src 'none'; frame-ancestors 'none'";

export const ANSWER_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Disposition": "attachment",
  "Content-Security-Policy": NO_DOCUMENT_POLICY,
};

export function answer(status: number, body: unknown, headers?: Record<string, string>): Answer {
  return { status, body: JSON.stringify(body), ...(headers ? { headers } : {}) };
}

/**
 * Every error this API answers with, as one closed list. An error body has
 * one shape, `{ "code": ..., "error": ... }`: a stable code a client can
 * act on, and a plain sentence for a person. Each code has one status.
 *
 * A 401 means one thing only: the session token is not accepted here. A
 * provider that turns down this server's own credentials is never reported
 * as a 401, because a wallet reads a 401 on a submit as "nothing was sent".
 */
export const ERRORS = {
  invalid_request: [400, "The request is malformed."],
  unauthorized: [401, "A valid session token is required."],
  session_expired: [401, "This session has reached its maximum age. Start a new one."],
  session_invalid: [401, "This session cannot be renewed. Start a new one."],
  origin_not_allowed: [403, "This origin may not call the API from a browser."],
  method_not_allowed: [403, "This method is not one the wallets use."],
  not_found: [404, "There is nothing at this path."],
  request_timeout: [408, "The request body took too long to arrive."],
  // The profile program's own refusals, under the names the program gives them.
  Paused: [409, "Profiles are paused. Nothing was written."],
  RecordTooLarge: [409, "The record is larger than this deployment allows. Nothing was written."],
  ProfileExists: [409, "This profile already exists. Nothing was written."],
  ProfileMissing: [409, "This profile does not exist. Nothing was done."],
  StaleRevision: [409, "The profile changed since it was read. Read it again."],
  request_too_large: [413, "The request body is too large."],
  refused: [422, "The transaction was refused. Nothing was signed."],
  insufficient_payment: [422, "The payment is below the current price. Nothing was signed."],
  rate_limited: [429, "Too many requests. Wait and try again."],
  internal_error: [500, "The request could not be handled."],
  upstream_failed: [502, "The provider did not give a usable answer."],
  upstream_refused: [502, "The provider refused this server's own credentials."],
  no_answer: [502, "The relayer gave no usable answer. What it did with the request is not known."],
  unavailable: [503, "The service this request needs is not available. Nothing was done."],
  relayer_unavailable: [503, "The relayer could not be used. Nothing was signed."],
  upstream_not_reached: [503, "The provider could not be reached. It never received the request."],
  upstream_timeout: [504, "The provider did not answer in time."],
  response_timeout: [504, "The request took too long to answer."],
} as const satisfies Record<string, readonly [status: number, sentence: string]>;

export type ErrorCode = keyof typeof ERRORS;

/** The answer for an error from the list. */
export function refusal(code: ErrorCode, headers?: Record<string, string>): Answer {
  const [status, error] = ERRORS[code];
  return answer(status, { code, error }, headers);
}

/** The code of an answer that is one of this API's own errors, or null. */
export function codeOf(from: Answer): string | null {
  const body = parsed(from);
  const code = (body as { code?: unknown } | null)?.code;
  return from.status >= 400 && typeof code === "string" ? code : null;
}

export const rateRefusal = (): Answer => refusal("rate_limited");

/** The same refusal, saying when to try again: this server is holding back for a provider. */
export const busyRefusal = (retryAfterSeconds: number): Answer =>
  refusal("rate_limited", { "Retry-After": String(retryAfterSeconds) });

/** The parsed body of an answer, or null when it has none or it is not JSON. */
export function parsed(from: Answer): unknown {
  if (from.body === null) return null;
  try {
    return JSON.parse(from.body) as unknown;
  } catch {
    return null;
  }
}

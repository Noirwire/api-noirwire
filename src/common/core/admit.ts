import { rateRefusal, refusal, type Answer } from "./answer.js";
import type { Budget, QuotaStore } from "./quota.js";
import { readCappedIncoming, type IncomingBody } from "./readCapped.js";

/** A request body here is a few kilobytes. One that takes longer than this to arrive is not a wallet. */
export const BODY_DEADLINE_MS = 5_000;

export type AdmissionRule = { budgets: readonly Budget[]; maxBodyBytes: number };

export type Incoming = {
  /** The `content-length` header as sent, if any. */
  contentLength: string | undefined;
  body: IncomingBody;
};

export type Admitted = { body: string } | { refused: Answer };

/**
 * The checks every request passes before anything is done with it: under
 * every budget it is counted against (its session's, its address's and the
 * route's as a whole), and a body no larger than `maxBodyBytes` that
 * arrives promptly.
 */
export async function admit(
  incoming: Incoming,
  rule: AdmissionRule,
  quotas: QuotaStore,
  bodyDeadlineMs = BODY_DEADLINE_MS,
): Promise<Admitted> {
  if (!quotas.take(rule.budgets)) return { refused: rateRefusal() };
  const tooLarge = { refused: refusal("request_too_large") };
  if (Number(incoming.contentLength ?? 0) > rule.maxBodyBytes) return tooLarge;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), bodyDeadlineMs);
  try {
    const body = await readCappedIncoming(incoming.body, rule.maxBodyBytes, deadline.signal);
    return body ? { body: body.toString("utf8") } : tooLarge;
  } catch {
    return deadline.signal.aborted
      ? { refused: refusal("request_timeout") }
      : { refused: refusal("invalid_request") };
  } finally {
    clearTimeout(timer);
  }
}

import type { RouteLimits } from "../../common/core/quota.js";

/**
 * The wallet's only way to MagicBlock's private-payment API. MagicBlock sees
 * this server's address rather than the user's. It still sees the funding
 * wallet and the portfolio together: a transfer cannot be built without
 * naming both.
 *
 * Not an open proxy: only the paths below, all of them a POST.
 */
export const PRIVATE_PAYMENT_PATHS: ReadonlySet<string> = new Set([
  "v1/spl/transfer",
  "v1/transaction/send",
  "v1/spl/transfer-queue/ensure-crank",
]);

export const PRIVATE_PAYMENTS_MAX_BODY_BYTES = 16 * 1024;
/** The largest answer is one unsigned transaction with its fees, a few kilobytes. */
export const PRIVATE_PAYMENTS_MAX_RESPONSE_BYTES = 256 * 1024;
export const PRIVATE_PAYMENTS_LIMITS: RouteLimits = { perSession: 60, perIp: 600, total: 1_200 };

import { z } from "zod";
import { refusal, type Answer } from "../../common/core/answer.js";
import type { RouteLimits } from "../../common/core/quota.js";

/**
 * The wallet's only way to the Solana RPC. It forwards what it receives, one
 * call per request, and never merges two: the wallet sends each address's
 * reads separately, and joining them here would hand the provider the link
 * it was split to withhold. A JSON-RPC batch is refused for the same reason
 * and one more: the wallet never sends one, so an array could only be
 * someone multiplying their rate limit.
 */

/** Every method the wallet calls. Anything else has no business going through this server's key. */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getFeeForMessage",
  "getGenesisHash",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getSignatureStatuses",
  "getTokenAccountsByOwner",
  "getTransaction",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);

/**
 * The calls that cost the provider real work or reach the chain. They get a
 * budget and a provider allowance of their own, well under the ones for
 * plain reads. The costliest reads of all (`getProgramAccounts`,
 * `getSignaturesForAddress`) are not on the list above and never pass.
 */
export const HEAVY_METHODS: ReadonlySet<string> = new Set([
  "getTokenAccountsByOwner",
  "getTransaction",
  "sendTransaction",
  "simulateTransaction",
]);

/** A signed transaction is about 1.7 KB encoded; a simulation adds the accounts it watches. */
export const RPC_MAX_BODY_BYTES = 64 * 1024;
/**
 * The largest answers are a hundred accounts read at once, a simulation with
 * its logs and watched accounts, and an owner's token accounts: tens to a
 * few hundred kilobytes. The ceiling sits well above those.
 */
export const RPC_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/**
 * The limits follow from what the provider allows this server's key. The
 * route's total for a minute is what the provider gate lets through in one;
 * a session may take at most half of that, an address at most all of it. A
 * balance refresh is a handful of requests, a confirmation two a second, an
 * import a burst of about a hundred.
 */
export function rpcLimits(providerRps: number): RouteLimits {
  const total = providerRps * 60;
  return { perSession: Math.ceil(total / 2), perIp: total, total };
}

/** The share of the provider's allowance the costly calls may take: half. */
export const heavyRps = (providerRps: number) => Math.max(1, Math.floor(providerRps / 2));

/** The same rule for the costly calls, over their smaller allowance. A trade needs about four of them. */
export function rpcHeavyLimits(providerRps: number): RouteLimits {
  const total = heavyRps(providerRps) * 60;
  return { perSession: Math.ceil(total / 4), perIp: total, total };
}

const call = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(64), z.number()]),
  method: z.string(),
  params: z.array(z.unknown()).optional(),
});

export type RpcReading = { method: string; heavy: boolean } | { refused: Answer };

/** The one call in `body`, or the error it is refused with. */
export function readRpcCall(body: string): RpcReading {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { refused: refusal("invalid_request") };
  }
  const invalid = { refused: refusal("invalid_request") };
  if (typeof json !== "object" || json === null || Array.isArray(json)) return invalid;
  const method = (json as { method?: unknown }).method;
  if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
    return { refused: refusal("method_not_allowed") };
  }
  if (!call.safeParse(json).success) return invalid;
  return { method, heavy: HEAVY_METHODS.has(method) };
}

import { z } from "zod";
import { refusal, type Answer } from "../../common/core/answer.js";
import { limitsFromProviderRps, type RouteLimits } from "../../common/core/quota.js";

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
  "getSignaturesForAddress",
  "getTokenAccountsByOwner",
  "getTransaction",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction",
]);

/**
 * The calls that cost the provider real work or reach the chain. They get a
 * budget and a provider allowance of their own, well under the ones for
 * plain reads. `getProgramAccounts` is not on the list above and never
 * passes.
 */
export const HEAVY_METHODS: ReadonlySet<string> = new Set([
  "getSignaturesForAddress",
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
  return limitsFromProviderRps(providerRps);
}

/** The share of the provider's allowance the costly calls may take: half. */
export const heavyRps = (providerRps: number) => Math.max(1, Math.floor(providerRps / 2));

/** The same rule for the costly calls, over their smaller allowance. A trade needs about four of them. */
export function rpcHeavyLimits(providerRps: number): RouteLimits {
  return limitsFromProviderRps(heavyRps(providerRps), 4);
}

/**
 * The most signatures one `getSignaturesForAddress` call may ask for. The
 * wallet asks for a signer's recent transactions to find one that landed
 * without its id having been recorded, before it tells anyone a payment did
 * not go through. It needs the last few dozen, never a history: the limit
 * must be stated, and small.
 */
export const SIGNATURES_MAX_LIMIT = 50;

/** One address, and options that state the limit. */
const signaturesParams = z.tuple([
  z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  z.strictObject({
    limit: z.number().int().min(1).max(SIGNATURES_MAX_LIMIT),
    commitment: z.enum(["confirmed", "finalized"]).optional(),
    before: z.string().max(90).optional(),
    until: z.string().max(90).optional(),
    minContextSlot: z.number().int().nonnegative().optional(),
  }),
]);

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
  const parsed = call.safeParse(json);
  if (!parsed.success) return invalid;
  if (
    method === "getSignaturesForAddress" &&
    !signaturesParams.safeParse(parsed.data.params).success
  ) {
    return invalid;
  }
  return { method, heavy: HEAVY_METHODS.has(method) };
}

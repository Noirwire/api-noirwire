import { PublicKey } from "@solana/web3.js";
import { fromBase58 } from "../../chain/core/bytes.js";
import { signedBy } from "../../chain/core/signatures.js";

/**
 * What a member signs. Lines of text joined by a line feed: two that are
 * fixed, the rewards key, and what the request is about. So a signature made
 * for one purpose is never one for another, and none is a Solana transaction
 * or anything a wallet would sign for another service.
 */

const HEADING = "NoirWire rewards v1";

export type RewardsAction = "join" | "state" | "claim";

/**
 * The bytes signed for `action`. `about` is the time for a state, the
 * transaction for a claim, and for a join the time and then the invite code
 * as it is taken (the empty string when there is none): a join's last line
 * is always there, so the code a member is tied to is one they signed for.
 */
export function rewardsMessage(
  action: RewardsAction,
  rewardsKey: string,
  ...about: string[]
): Uint8Array {
  return new TextEncoder().encode([HEADING, action, rewardsKey, ...about].join("\n"));
}

/** Whether `signature` (base58) is `signer`'s over `message`. `signer` is an address already checked. */
export function signatureVerifies(signer: string, message: Uint8Array, signature: string): boolean {
  const bytes = fromBase58(signature);
  return bytes !== null && bytes.length === 64 && signedBy(new PublicKey(signer), message, bytes);
}

/** How far a signed time may be from this server's clock, either way. */
export const MAX_CLOCK_DRIFT_SECONDS = 300;

/** Whether `at` (Unix seconds) is close enough to `nowMs` to be taken. */
export function timely(at: number, nowMs: number): boolean {
  return Math.abs(at - Math.floor(nowMs / 1_000)) <= MAX_CLOCK_DRIFT_SECONDS;
}

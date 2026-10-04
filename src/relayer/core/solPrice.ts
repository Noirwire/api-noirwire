import { PublicKey } from "@solana/web3.js";
import type { ChainAccount, ChainReader } from "../../chain/core/chainReader.js";

/**
 * The price of SOL in dollars, as the relayer route uses it to state the
 * relayer's charges in USDC. Read from Pyth's SOL/USD price account through
 * this server's own RPC, for itself: it is never taken from a request, never
 * from the relayer (whose own estimate it exists to be checked against), and
 * not from Jupiter, which the relayer prices by.
 *
 * The account is written by Pyth's receiver program, which only accepts a
 * price carrying the Wormhole guardians' signatures. What that is not is
 * proof of the price: an RPC that lies about one account can lie about this
 * one. So there is a floor under it, and the route also refuses when it and
 * the relayer disagree.
 *
 * It is a USD price and the portfolio pays USDC; the two are treated as equal.
 */

/** The sponsored SOL/USD feed account (shard 0), the program that must own it and the feed it must carry. */
export const PYTH_SOL_USD = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const PYTH_RECEIVER = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";
const SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** How long one read is used for. */
const TTL_MS = 30_000;
/** A price published longer ago than this is not used. */
const MAX_PRICE_AGE_SECONDS = 120;
/** The feed's own confidence interval must be within 1 percent of the price. */
const MAX_CONFIDENCE_BPS = 100n;

/**
 * No price is believed below this. A price that is wrong on the low side
 * makes rent the relayer pays in SOL look cheap in USDC, so a wrong answer
 * must not be able to name one near zero. SOL has not traded this low since
 * 2023; if it ever does again, charges are worked out as if it had not,
 * until this is lowered by hand.
 */
export const MIN_SOL_PRICE_USD = 50;

// PriceUpdateV2: 8 discriminator, 32 write authority, 1 verification level
// (1 = fully verified), then feed id 32, price i64, confidence u64,
// exponent i32, publish time i64.
const VERIFICATION = 40;
const FEED_ID = 41;
const PRICE = 73;
const CONFIDENCE = 81;
const EXPONENT = 89;
const PUBLISH_TIME = 93;
const MIN_LENGTH = 101;

/** The price in `data`, in dollars, or null when it is not one to charge by. */
export function decodePythPrice(account: ChainAccount | null, nowSeconds: number): number | null {
  if (!account || account.owner.toBase58() !== PYTH_RECEIVER) return null;
  const { data } = account;
  if (data.length < MIN_LENGTH || data[VERIFICATION] !== 1) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const feed = [...data.subarray(FEED_ID, FEED_ID + 32)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (feed !== SOL_USD_FEED_ID) return null;
  const price = view.getBigInt64(PRICE, true);
  const confidence = view.getBigUint64(CONFIDENCE, true);
  const exponent = view.getInt32(EXPONENT, true);
  const age = nowSeconds - Number(view.getBigInt64(PUBLISH_TIME, true));
  if (age > MAX_PRICE_AGE_SECONDS || age < -MAX_PRICE_AGE_SECONDS) return null;
  if (price <= 0n || confidence * 10_000n > price * MAX_CONFIDENCE_BPS) return null;
  if (exponent < -18 || exponent > 0) return null;
  return Number(price) * 10 ** exponent;
}

export type SolPrice = (now?: number) => Promise<number | null>;

/**
 * Dollars per SOL, never under `MIN_SOL_PRICE_USD`, or null when the feed
 * cannot be read or is stale. With no price nothing is priced and the
 * relayer is not used. An unusable read is kept for the same thirty seconds
 * as a good one, so an outage does not turn every request into an RPC call.
 */
export function createSolPrice(chain: ChainReader): SolPrice {
  let last: { at: number; usd: number | null } | null = null;
  return async (now = Date.now()) => {
    if (!last || now - last.at >= TTL_MS) {
      const account = await chain.getAccountInfo(PYTH_SOL_USD, "confirmed").catch(() => null);
      last = { at: now, usd: decodePythPrice(account, Math.floor(now / 1000)) };
    }
    return last.usd === null ? null : Math.max(last.usd, MIN_SOL_PRICE_USD);
  };
}

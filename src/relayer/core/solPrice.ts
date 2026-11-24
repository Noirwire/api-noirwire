import { PublicKey } from "@solana/web3.js";
import type { ChainAccount, ChainReader } from "../../chain/core/chainReader.js";
import type { Log } from "../../common/core/log.js";

/**
 * The price of SOL in dollars, as the relayer route uses it to state the
 * relayer's charges in USDC. Read from MagicBlock's SOL/USD price account on
 * its rollup, through the RPC this server is given for that rollup, for
 * itself: it is never taken from a request, never from the relayer (whose own
 * estimate it exists to be checked against), and not from Jupiter, which the
 * relayer prices by.
 *
 * The account is written by MagicBlock's oracle program, which owns it. What
 * that is not is proof of the price: an RPC that lies about one account can
 * lie about this one. So there is a floor under it, and the route also
 * refuses when it and the relayer disagree. The feed carries no confidence
 * interval, so none is checked.
 *
 * It is a USD price and the portfolio pays USDC; the two are treated as equal.
 */

/** MagicBlock's price oracle program, the program that must own the account. */
const ORACLE_PROGRAM = new PublicKey("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
/** The oracle's feed number of SOL/USD. */
const SOL_USD_FEED_NUMBER = 6;

/** The oracle's second address seed: MagicBlock's name for its feed family, not a reference to another oracle. */
const FEED_FAMILY_SEED = "pyth-lazer";

/** The oracle's price account for SOL/USD, derived from the feed number. It is also the feed id the account must carry. */
export const MAGICBLOCK_SOL_USD = PublicKey.findProgramAddressSync(
  [
    Buffer.from("price_feed"),
    Buffer.from(FEED_FAMILY_SEED),
    Buffer.from(String(SOL_USD_FEED_NUMBER)),
  ],
  ORACLE_PROGRAM,
)[0];

/** How long one read is used for. */
const TTL_MS = 30_000;
/** A price published longer ago than this is not used. */
const MAX_PRICE_AGE_SECONDS = 120;
/** The order book refuses any publish time in the future; this much allowance is for this server's clock only. */
const MAX_CLOCK_SKEW_SECONDS = 5;

/**
 * No price is believed below this. A price that is wrong on the low side
 * makes rent the relayer pays in SOL look cheap in USDC, so a wrong answer
 * must not be able to name one near zero. SOL has not traded this low since
 * 2023; if it ever does again, charges are worked out as if it had not,
 * until this is lowered by hand.
 */
export const MIN_SOL_PRICE_USD = 50;

// PriceUpdateV3, 134 bytes: 8 discriminator, 32 write authority, 1
// verification level (1 = fully verified), then feed id 32 (the account's
// own address), price i64, exponent i32 (the number of decimals, positive),
// publish time i64.
const DISCRIMINATOR = [234, 161, 14, 36, 172, 239, 15, 232];
const ACCOUNT_LENGTH = 134;
const VERIFICATION = 40;
const FEED_ID = 41;
const PRICE = 73;
const EXPONENT = 89;
const PUBLISH_TIME = 93;
const STORED_DECIMALS = 8;

type Observation = { usd: number; publishedAt: number };

/** The price in `account`, in dollars, or null when it is not one to charge by. */
export function decodeMagicblockPrice(
  account: ChainAccount | null,
  nowSeconds: number,
): number | null {
  return observe(account, nowSeconds)?.usd ?? null;
}

function observe(account: ChainAccount | null, nowSeconds: number): Observation | null {
  if (!account || !account.owner.equals(ORACLE_PROGRAM)) return null;
  const { data } = account;
  if (data.length !== ACCOUNT_LENGTH || data[VERIFICATION] !== 1) return null;
  if (DISCRIMINATOR.some((byte, at) => data[at] !== byte)) return null;
  if (!Buffer.from(data.subarray(FEED_ID, FEED_ID + 32)).equals(MAGICBLOCK_SOL_USD.toBuffer())) {
    return null;
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getInt32(EXPONENT, true) !== STORED_DECIMALS) return null;
  const price = view.getBigInt64(PRICE, true);
  const publishedAt = Number(view.getBigInt64(PUBLISH_TIME, true));
  const age = nowSeconds - publishedAt;
  if (age > MAX_PRICE_AGE_SECONDS || age < -MAX_CLOCK_SKEW_SECONDS) return null;
  if (price <= 0n) return null;
  return { usd: Number(price) / 10 ** STORED_DECIMALS, publishedAt };
}

export type SolPrice = (now?: number) => Promise<number | null>;

/**
 * Dollars per SOL, never under `MIN_SOL_PRICE_USD`, or null when the feed
 * cannot be read or is stale. `rollup` is null when no rollup RPC is
 * configured, which leaves nothing to read. With no price nothing is priced
 * and the relayer is not used. An unusable read is kept for the same thirty
 * seconds as a good one, so an outage does not turn every request into an RPC
 * call.
 */
export function createSolPrice(rollup: ChainReader | null, log?: Log): SolPrice {
  let last: { at: number; usd: number | null; publishedAt: number } | null = null;
  const aged = (read: { usd: number | null; publishedAt: number }, now: number) =>
    read.usd !== null && Math.floor(now / 1000) - read.publishedAt > MAX_PRICE_AGE_SECONDS;
  return async (now = Date.now()) => {
    if (!last || now - last.at >= TTL_MS || aged(last, now)) {
      const account = rollup
        ? await rollup.getAccountInfo(MAGICBLOCK_SOL_USD, "confirmed").catch(() => null)
        : null;
      const seen = observe(account, Math.floor(now / 1000));
      last = { at: now, usd: seen?.usd ?? null, publishedAt: seen?.publishedAt ?? 0 };
      if (last.usd === null) {
        log?.({ event: "refusal", route: "relayer", status: 503, reason: "sol_price_unreadable" });
      }
    }
    return last.usd === null ? null : Math.max(last.usd, MIN_SOL_PRICE_USD);
  };
}

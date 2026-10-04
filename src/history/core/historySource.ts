import { stockBySymbol, type StockDefinition } from "../../chain/core/tokenRegistry.js";
import { readCapped } from "../../common/core/readCapped.js";

/**
 * Real price history for charts and sparklines: candle closes for the token
 * itself, from Jupiter's chart data, the same aggregated price its own
 * trading screens draw.
 *
 * Read on the server, once for everyone, and cached. The endpoint is the one
 * Jupiter's site uses rather than part of its documented API; if it ever
 * changes, charts hide and nothing else is affected.
 */

export const PRICE_RANGES = ["1D", "1W", "1M"] as const;
export type PriceRange = (typeof PRICE_RANGES)[number];

export const isRange = (value: string): value is PriceRange =>
  (PRICE_RANGES as readonly string[]).includes(value);

/**
 * How long a series is reused, matched to its candle size: an hourly series
 * gains a candle every hour, a 4-hour or daily one far less often.
 */
export const SERIES_TTL_SECONDS: Record<PriceRange, number> = {
  "1D": 5 * 60,
  "1W": 30 * 60,
  "1M": 6 * 60 * 60,
};

/**
 * How much longer than its normal life a series may still be shown while a
 * fresh one is fetched. Past that it is not served at all, so a chart is
 * never far older than its candles.
 */
export const STALE_FACTOR = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

const RANGES: Record<PriceRange, { interval: string; candles: number; spanMs: number }> = {
  "1D": { interval: "1_HOUR", candles: 24, spanMs: DAY_MS },
  "1W": { interval: "4_HOUR", candles: 42, spanMs: 7 * DAY_MS },
  "1M": { interval: "1_DAY", candles: 30, spanMs: 30 * DAY_MS },
};

const TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

/** The listed stock and range a request names, or null: nothing else has a chart. */
export function seriesOf(
  symbol: string,
  range: string,
): { stock: StockDefinition; range: PriceRange } | null {
  const stock = stockBySymbol(symbol);
  return stock && isRange(range) ? { stock, range } : null;
}

/**
 * Candle closes for a listed stock, oldest first, or null when there is no
 * usable history. Throws when the source could not be reached, which is a
 * different answer: "try again", not "there is nothing".
 */
export async function loadPriceHistory(
  stock: StockDefinition,
  range: PriceRange,
  source: { url: string; fetch: typeof fetch; now?: () => number },
): Promise<number[] | null> {
  const mint = stock.mint.toBase58();
  const { interval, candles, spanMs } = RANGES[range];
  const to = (source.now ?? Date.now)();
  const query = new URLSearchParams({
    interval,
    baseAsset: mint,
    from: String(to - spanMs),
    to: String(to),
    candles: String(candles),
    type: "price",
  });
  const response = await source.fetch(`${source.url}/v2/charts/${mint}?${query}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Price history returned ${response.status}.`);
  const bytes = await readCapped(response.body, MAX_RESPONSE_BYTES);
  if (!bytes) throw new Error("Price history answer too large.");
  const payload = JSON.parse(bytes.toString("utf8")) as { candles?: unknown } | null;
  const listed = Array.isArray(payload?.candles) ? (payload.candles as Candle[]) : [];
  // A candle is stamped with its opening time, so the first may open one candle before the window.
  return closesWithin(listed, to - spanMs - spanMs / candles, to);
}

type Candle = { time?: number; close?: number };

/**
 * The closes of the candles that fall inside the window, oldest first, or
 * null when fewer than two do. The order and the window are checked here
 * rather than trusted: a response that came back reversed, or for some other
 * period, would otherwise draw a believable chart of the wrong thing.
 */
export function closesWithin(candles: Candle[], fromMs: number, toMs: number): number[] | null {
  const closes = candles
    .filter(
      (candle): candle is Required<Candle> =>
        typeof candle === "object" &&
        candle !== null &&
        Number.isFinite(candle.time) &&
        Number.isFinite(candle.close) &&
        (candle.close as number) > 0 &&
        (candle.time as number) * 1000 >= fromMs &&
        (candle.time as number) * 1000 <= toMs,
    )
    .sort((a, b) => a.time - b.time)
    .map((candle) => candle.close);
  return closes.length >= 2 ? closes : null;
}

import { ALL_STOCKS } from "../../chain/core/tokenRegistry.js";
import { readCapped } from "../../common/core/readCapped.js";

/**
 * Live USD prices from Jupiter's price index, the same venue every trade is
 * routed through, so the number on a stock row and the number at review come
 * from one source.
 *
 * Read on the server and cached, once for everyone: the Jupiter key is
 * shared by every user, so each wallet polling it directly would spend that
 * one quota in proportion to how many are open.
 *
 * Jupiter quotes `usdPrice` per displayed token, which for a tokenized stock
 * is one share-equivalent. It is passed on as it is; the wallet applies the
 * mint's display multiplier on its side. USDC is not fetched: it is the unit
 * prices are quoted in.
 */

export type LivePrice = { usd: number; change24h: number };

/** Where Jupiter is reached and the headers every request to it carries. */
export type JupiterUpstream = { url: string; headers: () => Record<string, string> };

const SOL_MINT = "So11111111111111111111111111111111111111112";

const MINT_TO_SYMBOL = new Map<string, string>([
  [SOL_MINT, "SOL"],
  ...ALL_STOCKS.map((stock) => [stock.mint.toBase58(), stock.symbol] as [string, string]),
]);

/** The most mints Jupiter prices in one request. */
const IDS_PER_REQUEST = 50;
const RATE_LIMIT_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 8_000;
/** The longest a rate limit is waited out before the request is made again. */
const MAX_WAIT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** How long the index's prices are served before it is read again, and how much longer a stale copy may stand in. */
export const PRICES_TTL_MS = 30_000;
export const PRICES_STALE_MS = 30_000;

type IndexedPrice = { usdPrice?: number; priceChange24h?: number };

function idChunks(): string[][] {
  const ids = [...MINT_TO_SYMBOL.keys()];
  return Array.from({ length: Math.ceil(ids.length / IDS_PER_REQUEST) }, (_, index) =>
    ids.slice(index * IDS_PER_REQUEST, (index + 1) * IDS_PER_REQUEST),
  );
}

/** The price of each priced mint in one response, by symbol. Unpriced mints are simply absent. */
export function pricesFrom(
  payload: Record<string, IndexedPrice | null>,
): Record<string, LivePrice> {
  const prices: Record<string, LivePrice> = {};
  for (const [mint, entry] of Object.entries(payload)) {
    const symbol = MINT_TO_SYMBOL.get(mint);
    if (!symbol || !entry || !(typeof entry.usdPrice === "number" && entry.usdPrice > 0)) continue;
    prices[symbol] = { usd: entry.usdPrice, change24h: entry.priceChange24h ?? 0 };
  }
  return prices;
}

type Deps = { fetch: typeof fetch; sleep?: (ms: number) => Promise<void> };

/**
 * A read of the index that waits out a rate limit instead of failing on it,
 * for as long as the API asks (up to a bound) or with a doubling pause.
 */
async function indexFetch(url: string, headers: Record<string, string>, deps: Deps) {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    const response = await deps.fetch(url, {
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "error",
    });
    if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return response;
    await response.body?.cancel();
    const asked = Number(response.headers.get("retry-after")) * 1000 || 2_000 * 2 ** attempt;
    await sleep(Math.min(asked, MAX_WAIT_MS));
  }
}

/**
 * Every known asset's price, keyed by symbol. The index takes a limited
 * number of mints per request, so the list is read in chunks, one after the
 * other: being gentle on the shared key matters more than a second of
 * latency. A chunk that fails leaves its assets without a price rather than
 * failing the rest. Throws when nothing could be read at all.
 */
export async function loadLivePrices(
  jupiter: JupiterUpstream,
  deps: Deps,
): Promise<Record<string, LivePrice>> {
  const prices: Record<string, LivePrice> = {};
  let answered = 0;
  for (const ids of idChunks()) {
    try {
      const response = await indexFetch(
        `${jupiter.url}/price/v3?ids=${ids.join(",")}`,
        jupiter.headers(),
        deps,
      );
      if (!response.ok) continue;
      const bytes = await readCapped(response.body, MAX_RESPONSE_BYTES);
      if (!bytes) continue;
      const payload = JSON.parse(bytes.toString("utf8")) as Record<string, IndexedPrice | null>;
      if (typeof payload !== "object" || payload === null) continue;
      Object.assign(prices, pricesFrom(payload));
      answered += 1;
    } catch {
      /* this chunk's assets go without a price until the next read */
    }
  }
  if (answered === 0) throw new Error("Jupiter prices could not be read.");
  return prices;
}

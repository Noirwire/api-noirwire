import { describe, expect, it } from "vitest";
import { ALL_STOCKS, stockBySymbol } from "../../src/chain/core/tokenRegistry.js";
import { createCache } from "../../src/common/core/cached.js";
import { closesWithin, loadPriceHistory, seriesOf } from "../../src/history/core/historySource.js";
import { loadLivePrices, pricesFrom } from "../../src/prices/core/liveSource.js";

const JUPITER = { url: "https://api.jup.ag", headers: () => ({ "x-api-key": "server-key" }) };
const SOL_MINT = "So11111111111111111111111111111111111111112";
const [STOCK] = ALL_STOCKS;
const STOCK_MINT = STOCK.mint.toBase58();
const fetchOf = (reply: (url: string, init: RequestInit) => Response | Promise<Response>) =>
  reply as unknown as typeof fetch;

describe("prices as the wallets use them", () => {
  it("passes the index's price on as it is, keyed by symbol", () => {
    const prices = pricesFrom({
      [STOCK_MINT]: { usdPrice: 764.15, priceChange24h: -0.33 },
      [SOL_MINT]: { usdPrice: 200 },
    });
    expect(prices).toEqual({
      [STOCK.symbol]: { usd: 764.15, change24h: -0.33 },
      SOL: { usd: 200, change24h: 0 },
    });
  });

  it("leaves out anything unpriced, unknown or not a positive number", () => {
    const prices = pricesFrom({
      [STOCK_MINT]: null,
      [SOL_MINT]: { usdPrice: 0 },
      "11111111111111111111111111111111": { usdPrice: 5 },
    });
    expect(prices).toEqual({});
  });
});

describe("reading the price index", () => {
  it("asks for at most fifty mints per request and never repeats one, with the server's key", async () => {
    const requested: string[][] = [];
    const keys: (string | null)[] = [];
    await loadLivePrices(JUPITER, {
      fetch: fetchOf((url, init) => {
        requested.push(new URL(url).searchParams.get("ids")!.split(","));
        keys.push(new Headers(init.headers).get("x-api-key"));
        return Response.json({});
      }),
    });

    expect(requested.length).toBe(Math.ceil((ALL_STOCKS.length + 1) / 50));
    expect(requested.every((ids) => ids.length <= 50)).toBe(true);
    const all = requested.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain(SOL_MINT);
    for (const stock of ALL_STOCKS) expect(all).toContain(stock.mint.toBase58());
    expect(keys.every((key) => key === "server-key")).toBe(true);
  });

  it("fails when the index cannot be read at all", async () => {
    const down = { fetch: fetchOf(() => new Response("down", { status: 500 })) };
    await expect(loadLivePrices(JUPITER, down)).rejects.toThrow(/could not be read/);
    const broken = {
      fetch: fetchOf(() => {
        throw new TypeError("fetch failed");
      }),
    };
    await expect(loadLivePrices(JUPITER, broken)).rejects.toThrow(/could not be read/);
  });

  it("leaves a failed chunk's assets without a price rather than failing the rest", async () => {
    let calls = 0;
    const prices = await loadLivePrices(JUPITER, {
      fetch: fetchOf(() => {
        calls += 1;
        return calls === 1
          ? Response.json({ [SOL_MINT]: { usdPrice: 150 } })
          : new Response("<html>", { status: 200 });
      }),
    });
    expect(prices).toEqual({ SOL: { usd: 150, change24h: 0 } });
  });

  it("waits out a rate limit a bounded number of times, for a bounded time", async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(
      loadLivePrices(JUPITER, {
        fetch: fetchOf(() => {
          calls += 1;
          return new Response("busy", { status: 429, headers: { "retry-after": "3600" } });
        }),
        sleep: async (ms) => void waits.push(ms),
      }),
    ).rejects.toThrow(/could not be read/);
    const chunks = Math.ceil((ALL_STOCKS.length + 1) / 50);
    expect(calls).toBe(chunks * 4);
    expect(waits).toHaveLength(chunks * 3);
    expect(Math.max(...waits)).toBeLessThanOrEqual(8_000);
  });
});

describe("closesWithin", () => {
  const HOUR = 3_600;
  const from = 1_000 * HOUR * 1000;
  const to = from + 24 * HOUR * 1000;
  const at = (hours: number, close: number) => ({ time: from / 1000 + hours * HOUR, close });

  it("returns closes oldest first, whatever order they arrived in", () => {
    expect(closesWithin([at(3, 30), at(1, 10), at(2, 20)], from, to)).toEqual([10, 20, 30]);
  });

  it("drops candles from outside the window, so another period cannot be drawn as this one", () => {
    expect(closesWithin([at(-400, 1), at(-300, 2), at(1, 10), at(2, 20)], from, to)).toEqual([
      10, 20,
    ]);
    expect(closesWithin([at(-400, 1), at(-300, 2)], from, to)).toBeNull();
  });

  it("drops candles with no usable price or time", () => {
    expect(
      closesWithin(
        [at(1, 10), { close: 5 }, { time: from / 1000 + HOUR }, at(2, 0), at(3, 30)],
        from,
        to,
      ),
    ).toEqual([10, 30]);
  });

  it("is null for fewer than two candles", () => {
    expect(closesWithin([at(1, 10)], from, to)).toBeNull();
  });
});

describe("price history", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");

  it("names a series only for a listed tracker and one of the three ranges", () => {
    expect(seriesOf(STOCK.symbol, "1D")).toEqual({ stock: STOCK, range: "1D" });
    expect(seriesOf(STOCK.symbol.toLowerCase(), "1M")?.stock).toBe(STOCK);
    for (const [symbol, range] of [
      ["NOPE", "1D"],
      [STOCK.symbol, "1Y"],
      [STOCK.symbol, "1d"],
      ["SOL", "1D"],
      ["USDC", "1D"],
      ["constructor", "1D"],
      ["", ""],
    ]) {
      expect(seriesOf(symbol, range)).toBeNull();
    }
    expect(stockBySymbol("__proto__")).toBeUndefined();
  });

  it("asks the chart source for the listed mint's candles, and nothing else", async () => {
    const asked: string[] = [];
    const points = await loadPriceHistory(STOCK, "1D", {
      url: "https://datapi.example",
      now: () => now,
      fetch: fetchOf((url) => {
        asked.push(url);
        return Response.json({
          candles: [
            { time: now / 1000 - 7_200, close: 10 },
            { time: now / 1000 - 3_600, close: 11 },
          ],
        });
      }),
    });
    expect(points).toEqual([10, 11]);
    const url = new URL(asked[0]);
    expect(url.pathname).toBe(`/v2/charts/${STOCK_MINT}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      interval: "1_HOUR",
      baseAsset: STOCK_MINT,
      from: String(now - 86_400_000),
      to: String(now),
      candles: "24",
      type: "price",
    });
  });

  it("is null when the source has nothing usable, and throws when it cannot be read", async () => {
    const source = (reply: () => Response) => ({
      url: "https://datapi.example",
      now: () => now,
      fetch: fetchOf(reply),
    });
    expect(
      await loadPriceHistory(
        STOCK,
        "1W",
        source(() => Response.json({})),
      ),
    ).toBeNull();
    expect(
      await loadPriceHistory(
        STOCK,
        "1W",
        source(() => Response.json({ candles: "soon" })),
      ),
    ).toBeNull();
    await expect(
      loadPriceHistory(
        STOCK,
        "1W",
        source(() => new Response("down", { status: 503 })),
      ),
    ).rejects.toThrow();
    await expect(
      loadPriceHistory(
        STOCK,
        "1W",
        source(() => new Response("<html>", { status: 200 })),
      ),
    ).rejects.toThrow();
  });
});

describe("reading a source once for everyone", () => {
  function setup(ttlMs = 30_000, staleMs = 30_000) {
    const state = { clock: 0, loads: 0, fail: false, release: null as null | (() => void) };
    const get = createCache({
      ttlMs,
      staleMs,
      now: () => state.clock,
      load: async () => {
        state.loads += 1;
        const value = state.loads;
        if (state.release === null && state.fail) throw new Error("down");
        return value;
      },
    });
    return { state, get };
  }

  it("reads once per lifetime however many ask, and says how old the copy is", async () => {
    const { state, get } = setup();
    expect(await get()).toEqual({ value: 1, ageSeconds: 0 });
    state.clock = 29_000;
    expect(await get()).toEqual({ value: 1, ageSeconds: 29 });
    expect(state.loads).toBe(1);
  });

  it("shares one read between callers that arrive together", async () => {
    const { state, get } = setup();
    const answers = await Promise.all([get(), get(), get()]);
    expect(answers.map((answer) => answer.value)).toEqual([1, 1, 1]);
    expect(state.loads).toBe(1);
  });

  it("serves a stale copy at once while a fresh one is fetched behind it", async () => {
    const { state, get } = setup();
    await get();
    state.clock = 45_000;
    expect(await get()).toEqual({ value: 1, ageSeconds: 45 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.loads).toBe(2);
    expect(await get()).toEqual({ value: 2, ageSeconds: 0 });
  });

  it("never serves a copy past its stale time: it waits for a fresh one", async () => {
    const { state, get } = setup();
    await get();
    state.clock = 61_000;
    expect(await get()).toEqual({ value: 2, ageSeconds: 0 });
  });

  it("never keeps a failure: the next request tries again", async () => {
    const { state, get } = setup();
    state.fail = true;
    await expect(get()).rejects.toThrow("down");
    await expect(get()).rejects.toThrow("down");
    state.fail = false;
    expect((await get()).value).toBe(3);
  });

  it("keeps serving the stale copy when the refresh behind it fails, until it is too old", async () => {
    const { state, get } = setup();
    await get();
    state.clock = 40_000;
    state.fail = true;
    expect((await get()).value).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await get()).value).toBe(1);
    state.clock = 61_000;
    await expect(get()).rejects.toThrow("down");
  });
});

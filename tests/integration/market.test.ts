import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_STOCKS } from "../../src/chain/core/tokenRegistry.js";
import { visitorCode } from "../../src/events/core/forward.js";
import { ANSWER_HEADERS, answerHeaders, startApi, type Api } from "./support/harness.js";

const [STOCK] = ALL_STOCKS;

let api: Api;

beforeEach(async () => {
  // A fresh process for each test: prices and series are cached in memory.
  api = await startApi();
});
afterEach(() => api.close());

describe("GET /v1/prices", () => {
  it("returns every priced asset by symbol, read with the server's key, and says how old it is", async () => {
    const response = await api.call("/v1/prices");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      prices: {
        SOL: { usd: 150, change24h: 1.5 },
        [STOCK.symbol]: { usd: 764.15, change24h: -0.33 },
      },
    });
    expect(response.headers.get("age")).toBe("0");
    expect(answerHeaders(response.headers)).toEqual(ANSWER_HEADERS);
    const [sent] = api.providers.sentTo("jupiter");
    expect(sent.path.startsWith("/price/v3?ids=")).toBe(true);
    expect(sent.headers["x-api-key"]).toBe("server-jupiter-key");
    expect(sent.headers.authorization).toBeUndefined();
  });

  it("reads the index once for everyone, however many ask", async () => {
    await Promise.all(Array.from({ length: 10 }, () => api.call("/v1/prices")));
    await api.call("/v1/prices");
    const chunks = Math.ceil((ALL_STOCKS.length + 1) / 50);
    expect(api.providers.sentTo("jupiter")).toHaveLength(chunks);
  });

  it("takes no query string", async () => {
    const response = await api.call("/v1/prices?bust=1");
    expect([response.status, response.json.code]).toEqual([404, "not_found"]);
    expect(api.providers.sentTo("jupiter")).toHaveLength(0);
  });

  it("answers 502 when the index cannot be read, and keeps no failure", async () => {
    api.providers.answer("jupiter", () => ({ status: 500, body: "down" }));
    const failed = await api.call("/v1/prices");
    expect([failed.status, failed.json.code]).toEqual([502, "upstream_failed"]);
    api.providers.reset();
    expect((await api.call("/v1/prices")).status).toBe(200);
  });
});

describe("GET /v1/history/:symbol/:range", () => {
  it("returns a listed tracker's closes, oldest first, and reads the source once", async () => {
    const response = await api.call(`/v1/history/${STOCK.symbol}/1D`);
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ points: [10, 11, 12] });
    expect(response.headers.get("age")).toBe("0");
    await api.call(`/v1/history/${STOCK.symbol.toLowerCase()}/1D`);
    const sent = api.providers.sentTo("datapi");
    expect(sent).toHaveLength(1);
    expect(sent[0].path.startsWith(`/v2/charts/${STOCK.mint.toBase58()}?interval=1_HOUR`)).toBe(
      true,
    );
  });

  it("refuses a symbol that is not listed, a range that is not one, and any query", async () => {
    for (const path of [
      "/v1/history/NOPE/1D",
      `/v1/history/${STOCK.symbol}/1Y`,
      `/v1/history/${STOCK.symbol}/1d`,
      "/v1/history/SOL/1D",
      `/v1/history/${STOCK.symbol}/1D?bust=1`,
      `/v1/history/${STOCK.mint.toBase58()}/1D`,
    ]) {
      const response = await api.call(path);
      expect([response.status, response.json.code], path).toEqual([404, "not_found"]);
    }
    expect(api.providers.sentTo("datapi")).toHaveLength(0);
  });

  it("answers 404 when the source has nothing usable, and 502 when it cannot be read", async () => {
    api.providers.answer("datapi", () => ({ body: { candles: [] } }));
    expect((await api.call(`/v1/history/${STOCK.symbol}/1W`)).status).toBe(404);
    api.providers.answer("datapi", () => ({ status: 503, body: "down" }));
    const failed = await api.call(`/v1/history/${STOCK.symbol}/1W`);
    expect([failed.status, failed.json.code]).toEqual([502, "upstream_failed"]);
    api.providers.reset();
    expect((await api.call(`/v1/history/${STOCK.symbol}/1W`)).status).toBe(200);
  });
});

describe("POST /v1/events", () => {
  const BROWSER = "Mozilla/5.0 (iPhone) Safari/605";

  it("forwards a listed event to the analytics server, rebuilt, with nothing of the caller", async () => {
    const token = await api.token({ sessionId: "events-session" });
    const response = await api.call("/v1/events", {
      token,
      ip: "203.0.113.44",
      body: {
        path: "/portfolios/:id",
        display: "390x844",
        name: "account_created",
        data: { kind: "pie" },
      },
      headers: { "user-agent": BROWSER, cookie: "a=b", referer: "https://app.noirwire.example/x" },
    });
    expect(response.status).toBe(204);
    expect(response.text).toBe("");

    const [sent] = api.providers.sentTo("umami");
    expect(sent.method).toBe("POST");
    expect(sent.path).toBe("/api/send");
    expect(sent.headers["user-agent"]).toBe(BROWSER);
    expect(JSON.parse(sent.body)).toEqual({
      type: "event",
      payload: {
        website: "site-id",
        hostname: "app.noirwire.example",
        url: "/portfolios/:id",
        title: "NoirWire",
        id: visitorCode("server-only-salt", "events-session", Date.now()),
        screen: "390x844",
        name: "account_created",
        data: { kind: "pie" },
      },
    });
    const everything = JSON.stringify(sent);
    for (const secret of [
      token,
      "events-session",
      "203.0.113.44",
      "a=b",
      "app.noirwire.example/x",
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers["x-real-ip"]).toBeUndefined();
    expect(sent.headers["x-forwarded-for"]).toBeUndefined();
  });

  it("forwards an event that coincides with a transaction with no visitor code and no browser", async () => {
    await api.call("/v1/events", {
      body: {
        path: "/portfolios/:id",
        display: "390x844",
        name: "trade_placed",
        data: { side: "buy" },
      },
      headers: { "user-agent": BROWSER },
    });
    const [sent] = api.providers.sentTo("umami");
    expect(sent.headers["user-agent"]).toBe("Mozilla/5.0 (compatible; NoirWire)");
    expect(JSON.parse(sent.body).payload).toEqual({
      website: "site-id",
      hostname: "app.noirwire.example",
      url: "/portfolios/:id",
      title: "NoirWire",
      name: "trade_placed",
      data: { side: "buy" },
    });
  });

  it("answers 204 and forwards nothing for anything off the closed list", async () => {
    for (const body of [
      { path: "/portfolios/acc_k3j2h1g0" },
      { path: "/", name: "sent", data: { to: "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ" } },
      { path: "/", name: "anything_else" },
      { path: "/", visitor: "me" },
      "not json",
      { path: "/", pad: "x".repeat(2_000) },
    ]) {
      const response = await api.call("/v1/events", { body });
      expect(response.status).toBe(204);
    }
    expect(api.providers.sentTo("umami")).toHaveLength(0);
  });

  it("answers 204 whether or not the analytics server is there", async () => {
    api.providers.answer("umami", () => ({ status: 500, body: "down" }));
    expect((await api.call("/v1/events", { body: { path: "/" } })).status).toBe(204);
  });

  it("drops events past the quota, still with a 204", async () => {
    const token = await api.token();
    for (let i = 0; i < 125; i += 1) {
      const response = await api.call("/v1/events", { token, body: { path: "/" } });
      expect(response.status).toBe(204);
    }
    expect(api.providers.sentTo("umami")).toHaveLength(120);
  });
});

describe("POST /v1/events with analytics off", () => {
  let quiet: Api;
  beforeAll(async () => {
    quiet = await startApi({ UMAMI_URL: "", UMAMI_WEBSITE_ID: "", UMAMI_HOSTNAME: "" });
  });
  afterAll(() => quiet.close());

  it("answers 204 and sends nothing anywhere", async () => {
    const response = await quiet.call("/v1/events", { body: { path: "/" } });
    expect(response.status).toBe(204);
    expect(quiet.providers.sentTo("umami")).toHaveLength(0);
  });
});

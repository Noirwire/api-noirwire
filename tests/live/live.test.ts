import { describe, expect, it } from "vitest";

/**
 * The live suite: a running copy of this API, asked to reach the real
 * providers. Read-only: it starts an anonymous session, reads prices, a
 * chart, the vault list and the chain's identity. It signs nothing and
 * sends no transaction.
 *
 * Runs only when API_LIVE_URL is set (for example http://localhost:4000,
 * with `npm run supabase:start` and `npm run dev` running).
 */

const API = process.env.API_LIVE_URL?.replace(/\/+$/, "");

const GENESIS = [
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
];

describe.skipIf(!API)("a running copy, against the real providers", () => {
  let token = "";
  const authorized = () => ({ authorization: `Bearer ${token}` });

  it("starts an anonymous session", async () => {
    const response = await fetch(`${API}/v1/session`, { method: "POST" });
    expect(response.status).toBe(200);
    const session = (await response.json()) as { accessToken: string; expiresAt: number };
    expect(session.expiresAt).toBeGreaterThan(Date.now() / 1000);
    token = session.accessToken;
  });

  it("reads live prices from Jupiter's index", async () => {
    const response = await fetch(`${API}/v1/prices`, { headers: authorized() });
    expect(response.status).toBe(200);
    const { prices } = (await response.json()) as { prices: Record<string, { usd: number }> };
    expect(prices.SOL.usd).toBeGreaterThan(0);
    expect(Object.keys(prices).length).toBeGreaterThan(10);
  });

  it("reads a tracker's price history from Jupiter's chart data", async () => {
    const response = await fetch(`${API}/v1/history/NVDAx/1M`, { headers: authorized() });
    expect(response.status).toBe(200);
    const { points } = (await response.json()) as { points: number[] };
    expect(points.length).toBeGreaterThanOrEqual(2);
  });

  it("reaches the RPC provider, on a network this API knows", async () => {
    const response = await fetch(`${API}/v1/rpc`, {
      method: "POST",
      headers: { ...authorized(), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
    });
    expect(response.status).toBe(200);
    expect(GENESIS).toContain(((await response.json()) as { result: string }).result);
  });

  it("reads the lending vaults through the Jupiter relay", async () => {
    const response = await fetch(`${API}/v1/jupiter/lend/v1/earn/tokens`, {
      headers: authorized(),
    });
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });
});

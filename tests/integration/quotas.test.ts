import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApi, type Api } from "./support/harness.js";

/** The limits a caller meets over real HTTP. Each test has a process, and so a set of counters, of its own. */

const ADDRESS = "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ";
const call = (method: string) => ({ jsonrpc: "2.0", id: 1, method, params: [ADDRESS] });

let api: Api;

beforeEach(async () => {
  api = await startApi();
});
afterEach(() => api.close());

async function statuses(count: number, request: (index: number) => Promise<{ status: number }>) {
  const seen: number[] = [];
  for (let start = 0; start < count; start += 50) {
    const batch = Array.from({ length: Math.min(50, count - start) }, (_, i) => request(start + i));
    seen.push(...(await Promise.all(batch)).map((response) => response.status));
  }
  return seen;
}

describe("rate limits per caller", () => {
  it("stops one session past its per-minute limit, and only that session", async () => {
    const token = await api.token();
    const within = await statuses(600, () =>
      api.call("/v1/rpc", { token, body: call("getBalance") }),
    );
    expect(within.every((status) => status === 200)).toBe(true);

    const over = await api.call("/v1/rpc", { token, body: call("getBalance") });
    expect(over.status).toBe(429);
    expect(over.json.code).toBe("rate_limited");
    expect((await api.call("/v1/rpc", { body: call("getBalance") })).status).toBe(200);
    // The session is the key, whatever address it comes from.
    const elsewhere = await api.call("/v1/rpc", {
      token,
      ip: "198.51.100.200",
      body: call("getBalance"),
    });
    expect(elsewhere.status).toBe(429);
    expect(api.providers.sentTo("rpc")).toHaveLength(601);
  });

  it("gives the expensive calls a smaller budget than plain reads", async () => {
    const token = await api.token();
    const heavy = ["simulateTransaction", "getTransaction", "getTokenAccountsByOwner"];
    const within = await statuses(120, (i) =>
      api.call("/v1/rpc", { token, body: call(heavy[i % heavy.length]) }),
    );
    expect(within.every((status) => status === 200)).toBe(true);
    expect((await api.call("/v1/rpc", { token, body: call("sendTransaction") })).status).toBe(429);
    expect((await api.call("/v1/rpc", { token, body: call("getBalance") })).status).toBe(200);
  });

  it("stops one address past its limit, however many sessions it holds", async () => {
    const ip = "198.51.100.10";
    const body = { from: ADDRESS };
    const within = await statuses(600, () =>
      api.call("/v1/private-payments/v1/spl/transfer", { ip, body }),
    );
    expect(within.every((status) => status === 200)).toBe(true);
    const over = await api.call("/v1/private-payments/v1/spl/transfer", { ip, body });
    expect(over.status).toBe(429);
    const other = await api.call("/v1/private-payments/v1/spl/transfer", { body });
    expect(other.status).toBe(200);
  });

  it("counts by the platform's address, whatever the caller puts in x-forwarded-for", async () => {
    const ip = "198.51.100.11";
    const body = { from: ADDRESS };
    const spoofing = (i: number) =>
      api.call("/v1/private-payments/v1/spl/transfer", {
        ip,
        body,
        headers: { "x-forwarded-for": `192.0.2.${i % 250}, 10.1.1.1` },
      });
    const within = await statuses(600, spoofing);
    expect(within.every((status) => status === 200)).toBe(true);
    expect((await spoofing(600)).status).toBe(429);
  });

  it("stops everyone once a route's total for the minute is spent", async () => {
    const body = { from: ADDRESS };
    const within = await statuses(1_200, () =>
      api.call("/v1/private-payments/v1/spl/transfer", { body }),
    );
    expect(within.every((status) => status === 200)).toBe(true);
    const over = await api.call("/v1/private-payments/v1/spl/transfer", { body });
    expect(over.status).toBe(429);
    // Other routes have totals of their own.
    expect((await api.call("/v1/rpc", { body: call("getBalance") })).status).toBe(200);
  });

  it("does not count a request that failed its token check against anyone's quota", async () => {
    const token = await api.token();
    await statuses(100, () =>
      api.call("/v1/rpc", { token: "not.a.token", body: call("getBalance") }),
    );
    const within = await statuses(600, () =>
      api.call("/v1/rpc", { token, body: call("getBalance") }),
    );
    expect(within.every((status) => status === 200)).toBe(true);
  });
});

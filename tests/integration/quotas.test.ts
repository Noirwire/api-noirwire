import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startApi, type Api } from "./support/harness.js";

/**
 * The limits a caller meets over real HTTP. Each test has a process, and so
 * a set of counters, of its own.
 *
 * The budget arithmetic itself (per-session, per-address and per-route
 * caps, window resets) is proved once, fast and deterministically, in
 * `tests/unit/quota.test.ts` against the quota store directly. What stays
 * here is what only exists once the HTTP layer is in the loop: the client
 * address resolution (and its header-spoofing defences), and the provider
 * gate's real concurrency behaviour.
 *
 * The provider's-allowance tests below still pace themselves with a real
 * `setTimeout`-based `pause`. A clock injected through the gate's own `now`
 * seam was tried (`vi.useFakeTimers()` plus the already-injectable clock)
 * and dropped: driving fake timers while a real server answers a real
 * concurrent flood of sockets produced spurious `ECONNRESET`s that do not
 * happen under real time, which is a worse trade than the wall-clock cost.
 */

const ADDRESS = "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ";
const SECRET = "an-edge-secret-of-at-least-32-characters";
const call = (method: string) => ({ jsonrpc: "2.0", id: 1, method, params: [ADDRESS] });
const transfer = { from: ADDRESS };
const TRANSFER = "/v1/private-payments/v1/spl/transfer";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let api: Api;

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
  beforeEach(async () => {
    api = await startApi();
  });

  it("does not count a request that failed its token check against anyone's quota", async () => {
    const token = await api.token();
    await statuses(100, () => api.call(TRANSFER, { token: "not.a.token", body: transfer }));
    const within = await statuses(60, () => api.call(TRANSFER, { token, body: transfer }));
    expect(within.every((status) => status === 200)).toBe(true);
  });
});

describe("the client address", () => {
  /** Eleven session starts (ten are allowed an hour per address): how many were refused. */
  async function refusedOf(
    request: (index: number) => { ip?: string | null; headers: Record<string, string> },
  ) {
    let refused = 0;
    for (let i = 1; i <= 11; i += 1) {
      const response = await api.call("/v1/session", {
        method: "POST",
        token: null,
        ...request(i),
      });
      if (response.status === 429) refused += 1;
    }
    return refused;
  }

  it("cannot be chosen with x-forwarded-for: the platform's address is what counts", async () => {
    api = await startApi();
    const refused = await refusedOf((i) => ({
      ip: "198.51.100.11",
      headers: { "x-forwarded-for": `192.0.2.${i}, 10.1.1.${i}` },
    }));
    expect(refused).toBe(1);
  });

  it("falls back to the socket's address, never to another header, when the platform's is missing", async () => {
    api = await startApi();
    const refused = await refusedOf((i) => ({
      ip: null,
      headers: {
        "x-forwarded-for": `192.0.2.${i}`,
        "x-noirwire-client-ip": `203.0.113.${i}`,
        "x-client-ip": `203.0.113.${i}`,
        forwarded: `for=203.0.113.${i}`,
      },
    }));
    // Every one of them came from this machine's socket.
    expect(refused).toBe(1);
  });

  it("ignores the web app's headers when no secret is configured", async () => {
    api = await startApi();
    const refused = await refusedOf((i) => ({
      ip: "198.51.100.12",
      headers: { "x-noirwire-edge": SECRET, "x-noirwire-client-ip": `203.0.113.${i}` },
    }));
    expect(refused).toBe(1);
  });

  it("ignores the web app's headers when the secret is wrong", async () => {
    api = await startApi({ EDGE_SHARED_SECRET: SECRET });
    const guesses = ["", "wrong", `${SECRET}x`, SECRET.slice(1)];
    for (const [index, guess] of guesses.entries()) {
      const refused = await refusedOf((i) => ({
        ip: `198.51.100.${40 + index}`,
        headers: { "x-noirwire-edge": guess, "x-noirwire-client-ip": `203.0.113.${i}` },
      }));
      expect(refused, guess).toBe(1);
    }
  });

  it("counts a web user by their own address when the web app's server proves itself", async () => {
    api = await startApi({ EDGE_SHARED_SECRET: SECRET });
    const viaEdge = (browser: string) =>
      api.call("/v1/session", {
        method: "POST",
        token: null,
        // Every forwarded request arrives from the web host's one address.
        ip: "198.51.100.30",
        headers: { "x-noirwire-edge": SECRET, "x-noirwire-client-ip": browser },
      });
    // Thirty browsers behind one host address: each is served.
    // (No identity provider stands behind this test, so a start that is let through answers 503.)
    for (let i = 1; i <= 30; i += 1) expect((await viaEdge(`203.0.113.${i}`)).status).toBe(503);
    // And one browser is held to its own ten.
    const one: number[] = [];
    for (let i = 0; i < 10; i += 1) one.push((await viaEdge("203.0.113.1")).status);
    expect(one.filter((status) => status === 503)).toHaveLength(9);
    expect(one.at(-1)).toBe(429);
    // Neither header ever leaves this server.
    const everything = JSON.stringify(api.providers.received) + JSON.stringify(api.logged);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("203.0.113.1");
  });
});

describe("the provider's allowance", () => {
  const RPS = 20;
  const BURST = 5;

  /** The most requests the stand-in received in any one second. */
  function peakPerSecond(times: number[]) {
    return Math.max(
      0,
      ...times.map((start) => times.filter((at) => at >= start && at < start + 1_000).length),
    );
  }

  it("is never exceeded at the RPC provider, however many sessions burst, and a quiet session is still served", async () => {
    api = await startApi({ RPC_PROVIDER_RPS: String(RPS) });
    const arrivals: number[] = [];
    const answer = api.providers.defaults.rpc;
    api.providers.answer("rpc", (request) => {
      arrivals.push(Date.now());
      return answer(request);
    });

    const tokens = await Promise.all(Array.from({ length: 5 }, () => api.token()));
    const served = new Map<string, number>();
    const flood: Promise<{ status: number; headers: Headers }>[] = [];
    const startedAt = Date.now();
    let quiet: { status: number } | null = null;
    while (Date.now() - startedAt < 2_500) {
      for (const token of tokens) {
        for (let i = 0; i < 2; i += 1) {
          flood.push(
            api.call("/v1/rpc", { token, body: call("getBalance") }).then((response) => {
              if (response.status === 200) served.set(token, (served.get(token) ?? 0) + 1);
              return response;
            }),
          );
        }
      }
      await pause(25);
      // In the thick of it, a session that has asked for nothing asks once.
      if (quiet === null && Date.now() - startedAt > 1_200) {
        quiet = await api.call("/v1/rpc", { body: call("getBalance") });
      }
    }
    const answers = await Promise.all(flood);

    expect(peakPerSecond(arrivals)).toBeLessThanOrEqual(RPS + BURST);
    // It does use the allowance: about twenty a second for two and a half seconds.
    expect(arrivals.length).toBeGreaterThanOrEqual(RPS * 1.5);
    expect(quiet?.status).toBe(200);

    const refused = answers.filter((response) => response.status === 429);
    expect(refused.length).toBeGreaterThan(0);
    expect(answers.every((response) => [200, 429].includes(response.status))).toBe(true);
    expect(refused[0].headers.get("retry-after")).toBe("1");
    // No session took it all: each of the five was served a fair share.
    const shares = tokens.map((token) => served.get(token) ?? 0);
    expect(Math.min(...shares)).toBeGreaterThanOrEqual(4);
    expect(Math.max(...shares)).toBeLessThanOrEqual(Math.min(...shares) * 3);
  });

  it("holds the costly calls to a smaller share of it", async () => {
    api = await startApi({ RPC_PROVIDER_RPS: String(RPS) });
    const arrivals: number[] = [];
    const answer = api.providers.defaults.rpc;
    api.providers.answer("rpc", (request) => {
      arrivals.push(Date.now());
      return answer(request);
    });
    const startedAt = Date.now();
    const pending: Promise<unknown>[] = [];
    while (Date.now() - startedAt < 1_500) {
      for (let i = 0; i < 10; i += 1) {
        pending.push(api.call("/v1/rpc", { body: call("simulateTransaction") }));
      }
      await pause(25);
    }
    await Promise.all(pending);
    // Half the rate, and its own small burst.
    expect(peakPerSecond(arrivals)).toBeLessThanOrEqual(RPS / 2 + 2);
    expect(arrivals.length).toBeGreaterThan(RPS / 2);
  });

  it("is never exceeded at Jupiter either", async () => {
    api = await startApi({ JUPITER_PROVIDER_RPS: String(RPS) });
    const arrivals: number[] = [];
    api.providers.answer("jupiter", () => {
      arrivals.push(Date.now());
      return { body: [] };
    });
    const startedAt = Date.now();
    const pending: Promise<{ status: number }>[] = [];
    while (Date.now() - startedAt < 1_500) {
      for (let i = 0; i < 10; i += 1) {
        pending.push(api.call("/v1/jupiter/swap/v2/execute", { body: {} }));
      }
      await pause(25);
    }
    const answers = await Promise.all(pending);
    expect(peakPerSecond(arrivals)).toBeLessThanOrEqual(RPS + BURST);
    expect(answers.some((response) => response.status === 429)).toBe(true);
    expect(answers.some((response) => response.status === 200)).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { burstFor, createProviderGate } from "../../src/common/core/providerGate.js";
import { heavyRps, rpcHeavyLimits, rpcLimits } from "../../src/rpc/core/rpc.js";
import { jupiterLimits } from "../../src/jupiter/core/jupiter.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

/** Requests as they were granted or refused, in the order that happened. */
function recorder() {
  const granted: { key: string; at: number }[] = [];
  const refused: string[] = [];
  const track = (key: string, pending: Promise<boolean>) =>
    void pending.then((ok) => (ok ? granted.push({ key, at: Date.now() }) : refused.push(key)));
  return { granted, refused, track };
}

describe("the provider gate", () => {
  it("lets a burst through at once, and no more than the burst", async () => {
    const gate = createProviderGate({ ratePerSecond: 8 });
    const { granted, refused, track } = recorder();
    for (let i = 0; i < 30; i += 1) track(`s${i}`, gate.acquire(`s${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(burstFor(8)).toBe(2);
    expect(granted).toHaveLength(2);
    expect(refused).toHaveLength(0);
    // The rest wait their turn, and those it does not reach in time are refused.
    await vi.advanceTimersByTimeAsync(500);
    expect(granted.length).toBeLessThanOrEqual(2 + 4);
    expect(granted.length + refused.length).toBe(30);
  });

  it("never sends the provider more than its rate plus the burst in any second", async () => {
    const gate = createProviderGate({ ratePerSecond: 8 });
    const { granted, track } = recorder();
    for (let ms = 0; ms < 5_000; ms += 10) {
      for (const key of ["a", "b", "c", "d", "e"]) track(key, gate.acquire(key));
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    for (let start = 0; start <= 5_000; start += 50) {
      const inWindow = granted.filter(({ at }) => at >= start && at < start + 1_000).length;
      expect(inWindow, `window from ${start}`).toBeLessThanOrEqual(8 + 2);
    }
    // And it does send what it may: about eight a second over five seconds.
    expect(granted.length).toBeGreaterThanOrEqual(38);
  });

  it("serves the sessions that are waiting in turn, however much one of them asks", async () => {
    const gate = createProviderGate({ ratePerSecond: 10 });
    const { granted, track } = recorder();
    for (let ms = 0; ms < 3_000; ms += 10) {
      // One session asks ten times as often as each of the other two.
      for (let i = 0; i < 10; i += 1) track("loud", gate.acquire("loud"));
      track("quiet-1", gate.acquire("quiet-1"));
      track("quiet-2", gate.acquire("quiet-2"));
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    const share = (key: string) => granted.filter((entry) => entry.key === key).length;
    expect(share("quiet-1")).toBeGreaterThanOrEqual(8);
    expect(share("quiet-2")).toBeGreaterThanOrEqual(8);
    // The loud one gets no more than its turn.
    expect(share("loud")).toBeLessThanOrEqual(share("quiet-1") + 4);
  });

  it("serves a quiet session's single request while another floods", async () => {
    const gate = createProviderGate({ ratePerSecond: 8 });
    const flood = setInterval(() => {
      for (let i = 0; i < 20; i += 1) void gate.acquire("flood");
    }, 5);
    await vi.advanceTimersByTimeAsync(2_000);
    const quiet = gate.acquire("quiet");
    await vi.advanceTimersByTimeAsync(400);
    clearInterval(flood);
    expect(await quiet).toBe(true);
  });

  it("refuses a request that would wait too long, after a short bounded wait", async () => {
    const gate = createProviderGate({ ratePerSecond: 1, burst: 1 });
    expect(await gate.acquire("a")).toBe(true);
    const waited = gate.acquire("a");
    const second = gate.acquire("b");
    let settled = false;
    void waited.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(399);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await waited).toBe(false);
    expect(await second).toBe(false);
  });

  it("refuses a session's third waiting request at once, and still lets another session wait", async () => {
    const gate = createProviderGate({ ratePerSecond: 1, burst: 1 });
    await gate.acquire("a");
    const held = [gate.acquire("a"), gate.acquire("a")];
    const refusedAt = Date.now();
    expect(await gate.acquire("a")).toBe(false);
    expect(Date.now()).toBe(refusedAt);
    // Its neighbour's line is its own.
    const other = gate.acquire("b");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await Promise.all([...held, other])).toHaveLength(3);
  });

  it("is ready again after a quiet spell, with no more than its burst saved up", async () => {
    const gate = createProviderGate({ ratePerSecond: 8 });
    await vi.advanceTimersByTimeAsync(60_000);
    const { granted, track } = recorder();
    for (let i = 0; i < 10; i += 1) track(`s${i}`, gate.acquire(`s${i}`));
    await vi.advanceTimersByTimeAsync(0);
    expect(granted).toHaveLength(2);
  });
});

describe("the limits that follow from the provider's rate", () => {
  it("never let a route's minute exceed what the provider allows in one", () => {
    expect(rpcLimits(8)).toEqual({ perSession: 240, perIp: 480, total: 480 });
    expect(heavyRps(8)).toBe(4);
    expect(rpcHeavyLimits(8)).toEqual({ perSession: 60, perIp: 240, total: 240 });
    expect(jupiterLimits(5)).toEqual({ perSession: 150, perIp: 300, total: 300 });
    for (const rps of [1, 2, 8, 50, 1_000]) {
      for (const limits of [rpcLimits(rps), rpcHeavyLimits(rps), jupiterLimits(rps)]) {
        expect(limits.total).toBeLessThanOrEqual(rps * 60);
        expect(limits.perSession).toBeLessThanOrEqual(limits.total);
        expect(limits.perIp).toBeLessThanOrEqual(limits.total);
      }
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  createMemoryQuotaStore,
  HOUR_MS,
  MINUTE_MS,
  routeBudgets,
  type Budget,
} from "../../src/common/core/quota.js";

const LIMITS = { perSession: 3, perIp: 5, total: 8 };
const caller = (sessionId: string, ip = `ip-of-${sessionId}`) => ({ sessionId, ip });

describe("the quota store", () => {
  it("stops one session past its limit, and only that session", () => {
    const quotas = createMemoryQuotaStore();
    const take = (sessionId: string) => quotas.take(routeBudgets("rpc", caller(sessionId), LIMITS));
    expect([take("a"), take("a"), take("a")]).toEqual([true, true, true]);
    expect(take("a")).toBe(false);
    expect(take("b")).toBe(true);
  });

  it("stops one address past its limit, however many sessions it holds", () => {
    const quotas = createMemoryQuotaStore();
    const from = (sessionId: string) =>
      quotas.take(routeBudgets("rpc", caller(sessionId, "198.51.100.1"), LIMITS));
    expect(["a", "b", "c", "d", "e"].map(from)).toEqual([true, true, true, true, true]);
    expect(from("f")).toBe(false);
    expect(quotas.take(routeBudgets("rpc", caller("f", "198.51.100.2"), LIMITS))).toBe(true);
  });

  it("stops everyone once the route's total is spent", () => {
    const quotas = createMemoryQuotaStore();
    const results = Array.from({ length: 9 }, (_, i) =>
      quotas.take(routeBudgets("rpc", caller(`s${i}`), LIMITS)),
    );
    expect(results).toEqual([true, true, true, true, true, true, true, true, false]);
  });

  it("counts each route apart", () => {
    const quotas = createMemoryQuotaStore();
    for (let i = 0; i < 3; i += 1) quotas.take(routeBudgets("rpc", caller("a"), LIMITS));
    expect(quotas.take(routeBudgets("rpc", caller("a"), LIMITS))).toBe(false);
    expect(quotas.take(routeBudgets("jupiter", caller("a"), LIMITS))).toBe(true);
  });

  it("opens a new window once the old one has run out", () => {
    const quotas = createMemoryQuotaStore();
    const budget: Budget[] = [{ scope: "session", key: "k", limit: 1, windowMs: MINUTE_MS }];
    expect(quotas.take(budget, 0)).toBe(true);
    expect(quotas.take(budget, MINUTE_MS - 1)).toBe(false);
    expect(quotas.take(budget, MINUTE_MS)).toBe(true);
  });

  it("takes from every budget or from none: a refused request is not counted", () => {
    const quotas = createMemoryQuotaStore();
    const minute: Budget = { scope: "global", key: "minute", limit: 2, windowMs: MINUTE_MS };
    const hour: Budget = { scope: "global", key: "hour", limit: 3, windowMs: HOUR_MS };
    expect(quotas.take([minute, hour], 0)).toBe(true);
    expect(quotas.take([minute, hour], 0)).toBe(true);
    // The minute is spent: neither is counted, so the hour still has one left.
    expect(quotas.take([minute, hour], 0)).toBe(false);
    expect(quotas.take([minute, hour], MINUTE_MS)).toBe(true);
    expect(quotas.take([minute, hour], 2 * MINUTE_MS)).toBe(false);
    expect(quotas.take([minute, hour], HOUR_MS)).toBe(true);
  });

  it("never serves a budget whose limit is zero", () => {
    const quotas = createMemoryQuotaStore();
    expect(quotas.take([{ scope: "global", key: "off", limit: 0, windowMs: MINUTE_MS }])).toBe(
      false,
    );
  });

  it("fails closed when its table is full: a newcomer is refused, a counted key is unaffected", () => {
    const quotas = createMemoryQuotaStore(100);
    const of = (key: string, limit = 2): Budget[] => [
      { scope: "ip", key, limit, windowMs: MINUTE_MS },
    ];
    expect(quotas.take(of("limited"), 0)).toBe(true);
    expect(quotas.take(of("limited"), 0)).toBe(true);
    expect(quotas.take(of("limited"), 0)).toBe(false);

    const flood = Array.from({ length: 150 }, (_, i) => quotas.take(of(`flood-${i}`), 10));
    // Once every slot holds a live window, a key that is not counted is not
    // served: a flood of new identities gets nothing past the table's size.
    expect(flood.slice(0, 99).every(Boolean)).toBe(true);
    expect(flood.slice(99).some(Boolean)).toBe(false);
    expect(quotas.take(of("one-more-newcomer"), 20)).toBe(false);
    // The flood did not reset anyone's count, and did not push anyone out.
    expect(quotas.take(of("limited"), 30)).toBe(false);
    expect(quotas.take(of("flood-0"), 30)).toBe(true);
  });

  it("makes room again once the windows that filled it have run out", () => {
    const quotas = createMemoryQuotaStore(10);
    const of = (key: string): Budget[] => [{ scope: "ip", key, limit: 1, windowMs: MINUTE_MS }];
    for (let i = 0; i < 10; i += 1) quotas.take(of(`first-${i}`), 0);
    expect(quotas.take(of("late"), 1_500)).toBe(false);
    expect(quotas.take(of("late"), MINUTE_MS + 1_500)).toBe(true);
  });

  it("keeps a flood of sessions from pushing out addresses, and the other way round", () => {
    const quotas = createMemoryQuotaStore(10);
    for (let i = 0; i < 20; i += 1) {
      quotas.take([{ scope: "session", key: `s${i}`, limit: 1, windowMs: MINUTE_MS }], 0);
    }
    expect(
      quotas.take([{ scope: "ip", key: "an-address", limit: 1, windowMs: MINUTE_MS }], 0),
    ).toBe(true);
    expect(quotas.take([{ scope: "global", key: "total", limit: 1, windowMs: MINUTE_MS }], 0)).toBe(
      true,
    );
  });
});

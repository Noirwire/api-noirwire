import { describe, expect, it } from "vitest";
import type { LogLine } from "../../src/common/core/log.js";
import {
  createMemoryQuotaStore,
  HOUR_MS,
  MINUTE_MS,
  type Budget,
} from "../../src/common/core/quota.js";
import {
  chooseSpendStore,
  createDurableQuotaStore,
  createSpendCalls,
  type SpendCalls,
} from "../../src/common/core/spend.js";

const DAY_MS = 24 * HOUR_MS;
const minute: Budget = { scope: "global", key: "minute", limit: 2, windowMs: MINUTE_MS };
const hour: Budget = { scope: "global", key: "hour", limit: 3, windowMs: HOUR_MS };

/** The two SQL functions, as the migration defines them, over a map. */
function fakeDatabase() {
  const counts = new Map<string, number>();
  const id = (budget: string, windowStartMs: number) => `${budget}@${windowStartMs}`;
  const state = { down: false, failTakeFor: "" };
  const calls: SpendCalls = {
    take(budget, windowStartMs, limit) {
      if (state.down || state.failTakeFor === budget) return Promise.resolve(null);
      const held = counts.get(id(budget, windowStartMs)) ?? 0;
      if (limit < 1 || held >= limit) return Promise.resolve(false);
      counts.set(id(budget, windowStartMs), held + 1);
      return Promise.resolve(true);
    },
    refund(budget, windowStartMs) {
      if (state.down) return Promise.resolve(false);
      const held = counts.get(id(budget, windowStartMs)) ?? 0;
      if (held > 0) counts.set(id(budget, windowStartMs), held - 1);
      return Promise.resolve(true);
    },
  };
  return { calls, counts, state, held: (budget: string, at: number) => counts.get(id(budget, at)) };
}

function store() {
  const database = fakeDatabase();
  const logged: LogLine[] = [];
  return {
    ...database,
    logged,
    spend: createDurableQuotaStore(database.calls, (line) => void logged.push(line)),
  };
}

describe("the durable quota store", () => {
  it("refuses at the cap and counts a window once it is taken", async () => {
    const { spend, held } = store();
    expect(await spend.reserve([minute], 0)).not.toBeNull();
    expect(await spend.reserve([minute], 0)).not.toBeNull();
    expect(await spend.reserve([minute], 0)).toBeNull();
    expect(held("minute", 0)).toBe(2);
  });

  it("opens a new window when the old one has run out, aligned to the clock", async () => {
    const { spend } = store();
    const one: Budget = { ...minute, limit: 1 };
    expect(await spend.reserve([one], 10_000)).not.toBeNull();
    expect(await spend.reserve([one], MINUTE_MS - 1)).toBeNull();
    expect(await spend.reserve([one], MINUTE_MS)).not.toBeNull();
  });

  it("takes from every budget or from none", async () => {
    const { spend, held } = store();
    await spend.reserve([minute, hour], 0);
    await spend.reserve([minute, hour], 0);
    expect(await spend.reserve([minute, hour], 0)).toBeNull();
    expect(held("minute", 0)).toBe(2);
    expect(held("hour", 0)).toBe(2);
  });

  it("gives back only the exact windows a receipt counted", async () => {
    const { spend, held } = store();
    const day: Budget = { scope: "global", key: "day", limit: 5, windowMs: DAY_MS };
    const early = await spend.reserve([minute, day], 0);
    await spend.reserve([minute, day], MINUTE_MS);
    expect(early).not.toBeNull();
    await spend.refund(early!);
    expect(held("minute", 0)).toBe(0);
    expect(held("minute", MINUTE_MS)).toBe(1);
    expect(held("day", 0)).toBe(1);
  });

  it("makes a second refund of one receipt a no-op", async () => {
    const { spend, held } = store();
    const first = await spend.reserve([minute], 0);
    await spend.reserve([minute], 0);
    await spend.refund(first!);
    await spend.refund(first!);
    expect(held("minute", 0)).toBe(1);
  });

  it("never refunds below zero", async () => {
    const { calls, held, spend } = store();
    const receipt = await spend.reserve([minute], 0);
    await calls.refund("minute", 0);
    await spend.refund(receipt!);
    expect(held("minute", 0)).toBe(0);
  });

  it("fails closed when the database does not answer, and logs without a name or value", async () => {
    const { spend, state, logged } = store();
    state.down = true;
    expect(await spend.reserve([minute], 0)).toBeNull();
    state.down = false;
    expect(await spend.reserve([minute], 0)).not.toBeNull();
    expect(logged).toEqual([]);
  });

  it("fails closed when a call throws, and gives back what it had taken", async () => {
    const database = fakeDatabase();
    const logged: LogLine[] = [];
    const throwing: SpendCalls = {
      take: (budget, at, limit) =>
        budget === "hour"
          ? Promise.reject(new Error("boom"))
          : database.calls.take(budget, at, limit),
      refund: database.calls.refund,
    };
    const spend = createDurableQuotaStore(throwing, (line) => void logged.push(line));
    expect(await spend.reserve([minute, hour], 0)).toBeNull();
    expect(database.held("minute", 0)).toBe(0);
    expect(logged).toEqual([
      { event: "refusal", route: "spend", status: 502, reason: "database_failed" },
    ]);
  });

  it("gives back an earlier take when a later budget cannot be counted", async () => {
    const { spend, state, held } = store();
    state.failTakeFor = "hour";
    expect(await spend.reserve([minute, hour], 0)).toBeNull();
    expect(held("minute", 0)).toBe(0);
  });
});

describe("the database calls", () => {
  function calls(reply: () => Response | Promise<Response>) {
    const sent: { url: string; body: unknown }[] = [];
    const logged: LogLine[] = [];
    const log = (line: LogLine) => void logged.push(line);
    const relay = async (_route: string, url: string, init: { body?: string }) => {
      sent.push({ url, body: JSON.parse(init.body ?? "null") });
      const response = await reply();
      return { status: response.status, body: await response.text() };
    };
    return {
      sent,
      logged,
      calls: createSpendCalls({ url: "https://project.supabase.co", secretKey: "k", relay, log }),
    };
  }

  it("calls spend_take with the window start as a timestamp", async () => {
    const { calls: spend, sent } = calls(() => new Response("true"));
    expect(await spend.take("day", DAY_MS, 500)).toBe(true);
    expect(sent).toEqual([
      {
        url: "https://project.supabase.co/rest/v1/rpc/spend_take",
        body: { p_budget: "day", p_window_start: "1970-01-02T00:00:00.000Z", p_limit: 500 },
      },
    ]);
  });

  it("reads an error status or an unusable answer as a failure, never as a slot", async () => {
    const refused = calls(
      () => new Response('{"message":"relation spend_windows"}', { status: 400 }),
    );
    expect(await refused.calls.take("day", 0, 1)).toBeNull();
    const odd = calls(() => new Response('"yes"'));
    expect(await odd.calls.take("day", 0, 1)).toBeNull();
    expect(JSON.stringify([refused.logged, odd.logged])).not.toContain("spend_windows");
  });

  it("counts a 204 as a refund that reached the database", async () => {
    const { calls: spend } = calls(() => new Response(null, { status: 204 }));
    expect(await spend.refund("day", 0)).toBe(true);
  });
});

describe("choosing the store", () => {
  const relay = () => Promise.reject(new Error("not called"));

  it("falls back to memory, and says so, when there is no database", async () => {
    const logged: LogLine[] = [];
    const spend = chooseSpendStore({
      database: null,
      quotas: createMemoryQuotaStore(),
      relay,
      log: (line) => void logged.push(line),
    });
    expect(logged).toEqual([{ event: "lifecycle", state: "spend_in_memory" }]);
    expect(await spend.reserve([{ ...minute, limit: 1 }], 0)).not.toBeNull();
    expect(await spend.reserve([{ ...minute, limit: 1 }], 0)).toBeNull();
  });

  it("uses the database, and says so, when there is one", () => {
    const logged: LogLine[] = [];
    chooseSpendStore({
      database: { url: "https://project.supabase.co", secretKey: "k" },
      quotas: createMemoryQuotaStore(),
      relay,
      log: (line) => void logged.push(line),
    });
    expect(logged).toEqual([{ event: "lifecycle", state: "spend_in_database" }]);
  });
});

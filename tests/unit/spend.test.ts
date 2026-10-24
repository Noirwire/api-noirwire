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

/** The two SQL functions, as the migration defines them, over a map and a clock the test moves. */
function fakeDatabase() {
  const rows = new Map<string, { start: number; count: number }>();
  const state = { down: false, failTakeFor: "", now: 0 };
  const calls: SpendCalls = {
    take(budget, windowMs, limit) {
      if (state.down || state.failTakeFor === budget) return Promise.resolve(null);
      const row = rows.get(budget);
      if (limit < 1 || windowMs < 1) return Promise.resolve(false);
      if (!row || row.start + windowMs <= state.now) {
        rows.set(budget, { start: state.now, count: 1 });
      } else if (row.count < limit) {
        row.count += 1;
      } else {
        return Promise.resolve(false);
      }
      return Promise.resolve(new Date(rows.get(budget)!.start).toISOString());
    },
    refund(budget, windowStart) {
      if (state.down) return Promise.resolve(false);
      const row = rows.get(budget);
      if (row && new Date(row.start).toISOString() === windowStart && row.count > 0) {
        row.count -= 1;
      }
      return Promise.resolve(true);
    },
  };
  return { calls, state, held: (budget: string) => rows.get(budget)?.count };
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
    expect(await spend.reserve([minute])).not.toBeNull();
    expect(await spend.reserve([minute])).not.toBeNull();
    expect(await spend.reserve([minute])).toBeNull();
    expect(held("minute")).toBe(2);
  });

  it("starts a window at the first use and ends it a whole window later", async () => {
    const { spend, state } = store();
    const one: Budget = { ...minute, limit: 1 };
    state.now = 10_000;
    expect(await spend.reserve([one])).not.toBeNull();
    state.now = 10_000 + MINUTE_MS - 1;
    expect(await spend.reserve([one])).toBeNull();
    state.now = 10_000 + MINUTE_MS;
    expect(await spend.reserve([one])).not.toBeNull();
  });

  it("does not refill a spent cap at a clock boundary inside the window", async () => {
    const { spend, state } = store();
    state.now = MINUTE_MS - 5_000;
    expect(await spend.reserve([minute])).not.toBeNull();
    expect(await spend.reserve([minute])).not.toBeNull();
    state.now = MINUTE_MS + 5_000;
    expect(await spend.reserve([minute])).toBeNull();
  });

  it("takes from every budget or from none", async () => {
    const { spend, held } = store();
    await spend.reserve([minute, hour]);
    await spend.reserve([minute, hour]);
    expect(await spend.reserve([minute, hour])).toBeNull();
    expect(held("minute")).toBe(2);
    expect(held("hour")).toBe(2);
  });

  it("gives back only the window a receipt counted", async () => {
    const { spend, state, held } = store();
    const day: Budget = { scope: "global", key: "day", limit: 5, windowMs: DAY_MS };
    const early = await spend.reserve([minute, day]);
    state.now = MINUTE_MS;
    await spend.reserve([minute, day]);
    expect(early).not.toBeNull();
    await spend.refund(early!);
    expect(held("minute")).toBe(1);
    expect(held("day")).toBe(1);
  });

  it("makes a second refund of one receipt a no-op", async () => {
    const { spend, held } = store();
    const first = await spend.reserve([minute]);
    await spend.reserve([minute]);
    await spend.refund(first!);
    await spend.refund(first!);
    expect(held("minute")).toBe(1);
  });

  it("never refunds below zero", async () => {
    const { calls, held, spend } = store();
    const receipt = await spend.reserve([minute]);
    await calls.refund("minute", new Date(0).toISOString());
    await calls.refund("minute", new Date(0).toISOString());
    await spend.refund(receipt!);
    expect(held("minute")).toBe(0);
  });

  it("fails closed when the database does not answer, and logs without a name or value", async () => {
    const { spend, state, logged } = store();
    state.down = true;
    expect(await spend.reserve([minute])).toBeNull();
    state.down = false;
    expect(await spend.reserve([minute])).not.toBeNull();
    expect(logged).toEqual([]);
  });

  it("fails closed when a call throws, and gives back what it had taken", async () => {
    const database = fakeDatabase();
    const logged: LogLine[] = [];
    const throwing: SpendCalls = {
      take: (budget, windowMs, limit) =>
        budget === "hour"
          ? Promise.reject(new Error("boom"))
          : database.calls.take(budget, windowMs, limit),
      refund: database.calls.refund,
    };
    const spend = createDurableQuotaStore(throwing, (line) => void logged.push(line));
    expect(await spend.reserve([minute, hour])).toBeNull();
    expect(database.held("minute")).toBe(0);
    expect(logged).toEqual([
      { event: "refusal", route: "spend", status: 502, reason: "database_failed" },
    ]);
  });

  it("gives back an earlier take when a later budget cannot be counted", async () => {
    const { spend, state, held } = store();
    state.failTakeFor = "hour";
    expect(await spend.reserve([minute, hour])).toBeNull();
    expect(held("minute")).toBe(0);
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

  const taken = '{"taken":true,"window_start":"2026-10-24T10:00:00.123456+00:00"}';

  it("calls spend_take with the window length and reads the window it was counted in", async () => {
    const { calls: spend, sent } = calls(() => new Response(taken));
    expect(await spend.take("day", DAY_MS, 500)).toBe("2026-10-24T10:00:00.123456+00:00");
    expect(sent).toEqual([
      {
        url: "https://project.supabase.co/rest/v1/rpc/spend_take",
        body: { p_budget: "day", p_window_ms: DAY_MS, p_limit: 500 },
      },
    ]);
  });

  it("reads a spent budget as false", async () => {
    const { calls: spend } = calls(() => new Response('{"taken":false}'));
    expect(await spend.take("day", DAY_MS, 1)).toBe(false);
  });

  it("reads an error status or an unusable answer as a failure, never as a slot", async () => {
    const refused = calls(
      () => new Response('{"message":"relation spend_windows"}', { status: 400 }),
    );
    expect(await refused.calls.take("day", 1, 1)).toBeNull();
    const unusable = [
      '"yes"',
      "true",
      "null",
      '{"taken":true}',
      '{"taken":true,"window_start":""}',
    ];
    for (const body of unusable) {
      const odd = calls(() => new Response(body));
      expect(await odd.calls.take("day", 1, 1), body).toBeNull();
      expect(odd.logged).toHaveLength(1);
    }
    expect(JSON.stringify(refused.logged)).not.toContain("spend_windows");
  });

  it("sends the window start back as the database wrote it, and counts a 204 as reached", async () => {
    const { calls: spend, sent } = calls(() => new Response(null, { status: 204 }));
    expect(await spend.refund("day", "2026-10-24T10:00:00.123456+00:00")).toBe(true);
    expect(sent[0].body).toEqual({
      p_budget: "day",
      p_window_start: "2026-10-24T10:00:00.123456+00:00",
    });
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

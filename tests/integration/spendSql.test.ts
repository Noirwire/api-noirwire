import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LogLine } from "../../src/common/core/log.js";
import type { Relay } from "../../src/common/core/relay.js";
import { createDurableQuotaStore, createSpendCalls } from "../../src/common/core/spend.js";

/**
 * The spend migration, run in a Postgres that lives in this process, and its
 * two functions called through the application's own adapter as the role the
 * secret key acts as. One connection: it shows the rules, not two requests
 * at once.
 */

const MIGRATION = "supabase/migrations/20261024120000_spend_windows.sql";
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

let db: PGlite;

const rest: Relay = async (_route, url, init) => {
  const name = /\/rest\/v1\/rpc\/(\w+)$/.exec(url)?.[1] ?? "";
  const args = Object.entries(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
  const named = args.map(([argument], index) => `${argument} => $${index + 1}`).join(", ");
  try {
    const { rows, fields } = await db.query<{ result: unknown }>(
      `select public.${name}(${named}) as result`,
      args.map(([, value]) => value),
    );
    if (fields[0].dataTypeID === 2278) return { status: 204, body: null };
    return { status: 200, body: JSON.stringify(rows[0].result ?? null) };
  } catch (error) {
    return { status: 400, body: JSON.stringify({ message: (error as Error).message }) };
  }
};

const logged: LogLine[] = [];
const log = (line: LogLine) => void logged.push(line);
const calls = createSpendCalls({
  url: "https://project.supabase.co",
  secretKey: "k",
  relay: rest,
  log,
});
const spend = createDurableQuotaStore(calls, log);

const count = async (budget: string) =>
  (
    await db.query<{ count: number }>("select count from public.spend_windows where budget = $1", [
      budget,
    ])
  ).rows[0]?.count;

/**
 * Moves time forward for a budget by moving its window back: the clock is
 * the database's own. This in-process Postgres reads its clock to the
 * millisecond, so it also waits one out, to keep the next window's start
 * from equalling the old one's.
 */
const ageWindow = async (budget: string, ms: number) => {
  await db.query(
    "update public.spend_windows set window_start = window_start - $2 * interval '1 millisecond' where budget = $1",
    [budget, ms],
  );
  await new Promise((done) => setTimeout(done, 5));
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    `create role anon; create role authenticated; create role service_role;
     create schema if not exists public;`,
  );
  await db.exec(readFileSync(MIGRATION, "utf8"));
});

beforeEach(async () => {
  logged.length = 0;
  await db.exec("truncate public.spend_windows");
});

afterAll(async () => {
  await db.close();
});

describe("the spend migration", () => {
  it("takes up to the limit in one window and refuses past it", async () => {
    expect(await calls.take("day", DAY_MS, 2)).toEqual(expect.any(String));
    expect(await calls.take("day", DAY_MS, 2)).toEqual(expect.any(String));
    expect(await calls.take("day", DAY_MS, 2)).toBe(false);
    expect(await count("day")).toBe(2);
    expect(await calls.take("day", DAY_MS, 0)).toBe(false);
    expect(await calls.take("day", 0, 5)).toBe(false);
  });

  it("anchors a window to the first take, and every take in it reports the same start", async () => {
    const first = await calls.take("minute", MINUTE_MS, 3);
    const second = await calls.take("minute", MINUTE_MS, 3);
    expect(first).toEqual(expect.any(String));
    expect(second).toBe(first);
  });

  it("keeps a spent cap spent across a clock boundary that falls inside its window", async () => {
    expect(await calls.take("minute", MINUTE_MS, 2)).toEqual(expect.any(String));
    expect(await calls.take("minute", MINUTE_MS, 2)).toEqual(expect.any(String));
    await ageWindow("minute", MINUTE_MS - 1_000);
    expect(await calls.take("minute", MINUTE_MS, 2)).toBe(false);
    expect(await count("minute")).toBe(2);
  });

  it("starts a new window at one take once the window has run its length", async () => {
    await calls.take("minute", MINUTE_MS, 2);
    await calls.take("minute", MINUTE_MS, 2);
    await ageWindow("minute", MINUTE_MS);
    expect(await calls.take("minute", MINUTE_MS, 2)).toEqual(expect.any(String));
    expect(await count("minute")).toBe(1);
    const { rows } = await db.query<{ age: number }>(
      "select extract(epoch from now() - window_start) as age from public.spend_windows where budget = 'minute'",
    );
    expect(Number(rows[0].age)).toBeLessThan(5);
  });

  it("refunds one in the window it names, never below zero", async () => {
    const window = (await calls.take("day", DAY_MS, 5)) as string;
    await calls.take("day", DAY_MS, 5);
    expect(await calls.refund("day", window)).toBe(true);
    expect(await count("day")).toBe(1);
    expect(await calls.refund("day", window)).toBe(true);
    expect(await calls.refund("day", window)).toBe(true);
    expect(await count("day")).toBe(0);
  });

  it("leaves a newer window alone when an older one is refunded", async () => {
    const old = (await calls.take("minute", MINUTE_MS, 5)) as string;
    await ageWindow("minute", MINUTE_MS);
    const current = (await calls.take("minute", MINUTE_MS, 5)) as string;
    expect(current).not.toBe(old);
    expect(await calls.refund("minute", old)).toBe(true);
    expect(await count("minute")).toBe(1);
    expect(await calls.refund("minute", current)).toBe(true);
    expect(await count("minute")).toBe(0);
  });

  it("counts each budget on its own row", async () => {
    await calls.take("minute", MINUTE_MS, 1);
    expect(await calls.take("hour", 3_600_000, 1)).toEqual(expect.any(String));
    expect(await calls.take("minute", MINUTE_MS, 1)).toBe(false);
  });

  it("works through the store, with a receipt tied to its window", async () => {
    const budget = { scope: "global" as const, key: "hour", limit: 1, windowMs: 3_600_000 };
    const receipt = await spend.reserve([budget]);
    expect(receipt).not.toBeNull();
    expect(await spend.reserve([budget])).toBeNull();
    await spend.refund(receipt!);
    expect(await spend.reserve([budget])).not.toBeNull();
  });

  it("does not refund a receipt into a window that replaced the one it was taken in", async () => {
    const budget = { scope: "global" as const, key: "minute", limit: 1, windowMs: MINUTE_MS };
    const old = await spend.reserve([budget]);
    await ageWindow("minute", MINUTE_MS);
    expect(await spend.reserve([budget])).not.toBeNull();
    await spend.refund(old!);
    expect(await count("minute")).toBe(1);
    expect(await spend.reserve([budget])).toBeNull();
  });

  it("is not callable by the public roles", async () => {
    await db.exec("set role anon");
    const refused = await db.query("select public.spend_take('x', 1000, 1)").then(
      () => null,
      (error: Error) => error.message,
    );
    await db.exec("reset role");
    expect(refused).toMatch(/permission denied/);
  });
});

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
const WINDOW = "2026-10-24T10:00:00.000Z";
const WINDOW_MS = Date.parse(WINDOW);

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

const count = async (budget: string, windowStart = WINDOW) =>
  (
    await db.query<{ count: number }>(
      "select count from public.spend_windows where budget = $1 and window_start = $2",
      [budget, windowStart],
    )
  ).rows[0]?.count;

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
    expect(await calls.take("day", WINDOW_MS, 2)).toBe(true);
    expect(await calls.take("day", WINDOW_MS, 2)).toBe(true);
    expect(await calls.take("day", WINDOW_MS, 2)).toBe(false);
    expect(await count("day")).toBe(2);
    expect(await calls.take("day", WINDOW_MS, 0)).toBe(false);
  });

  it("refunds one in the exact window, never below zero", async () => {
    await calls.take("day", WINDOW_MS, 5);
    await calls.take("day", WINDOW_MS + 60_000, 5);
    expect(await calls.refund("day", WINDOW_MS)).toBe(true);
    expect(await calls.refund("day", WINDOW_MS)).toBe(true);
    expect(await count("day")).toBe(0);
    expect(await count("day", "2026-10-24T10:01:00.000Z")).toBe(1);
  });

  it("drops windows more than two days old", async () => {
    await calls.take("minute", WINDOW_MS - 3 * 86_400_000, 1);
    await calls.take("minute", WINDOW_MS, 1);
    const { rows } = await db.query("select 1 from public.spend_windows");
    expect(rows).toHaveLength(1);
  });

  it("works through the store, with a receipt tied to its windows", async () => {
    const budget = { scope: "global" as const, key: "hour", limit: 1, windowMs: 3_600_000 };
    const receipt = await spend.reserve([budget], WINDOW_MS + 5);
    expect(receipt).not.toBeNull();
    expect(await spend.reserve([budget], WINDOW_MS + 6)).toBeNull();
    await spend.refund(receipt!);
    expect(await spend.reserve([budget], WINDOW_MS + 7)).not.toBeNull();
  });

  it("is not callable by the public roles", async () => {
    await db.exec("set role anon");
    const refused = await db.query("select public.spend_take('x', now(), 1)").then(
      () => null,
      (error: Error) => error.message,
    );
    await db.exec("reset role");
    expect(refused).toMatch(/permission denied/);
  });
});

import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Relay } from "../../src/common/core/relay.js";
import { createRewardsDatabase } from "../../src/rewards/core/database.js";
import type { RewardsStorage, Stored } from "../../src/rewards/core/storage.js";
import { splitPoints, weeklyScores, type Scorer } from "../support/rewards.js";

/**
 * The rewards migration, run. The file in `supabase/migrations` is loaded
 * into a real Postgres that lives in this process, with the three roles a
 * Supabase project has, and its functions are called through the
 * application's own database adapter: by the names it uses, with the
 * arguments it names, as the role its secret key acts as.
 *
 * The REST interface in between is stood in for by one line of SQL per
 * call. It is one connection, so nothing here shows two requests at once.
 */

const MIGRATION = "supabase/migrations/20261008120000_rewards.sql";
const TABLES = [
  "rewards_members",
  "rewards_week_fees",
  "rewards_claims",
  "rewards_settled_weeks",
  "rewards_points",
];
const POT = 100_000;

let db: PGlite;
let storage: RewardsStorage;

/** What the REST interface does with `POST /rest/v1/rpc/<name>`: the function, called with the body's fields as named arguments. */
const rest: Relay = async (_route, url, init) => {
  const name = /\/rest\/v1\/rpc\/(\w+)$/.exec(url)?.[1] ?? "";
  const args = Object.entries(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
  const named = args.map(([argument], index) => `${argument} => $${index + 1}`).join(", ");
  try {
    const { rows, fields } = await db.query<{ result: unknown }>(
      `select public.${name}(${named}) as result`,
      args.map(([, value]) => value),
    );
    // A function that returns nothing is answered with no body.
    if (fields[0].dataTypeID === VOID) return { status: 204, body: null };
    return { status: 200, body: JSON.stringify(rows[0].result ?? null) };
  } catch (error) {
    sqlError = (error as Error).message;
    return { status: 400, body: JSON.stringify({ message: sqlError }) };
  }
};
/** Postgres's number for the type `void`. */
const VOID = 2278;
/** What Postgres said of the last call it refused: the adapter itself passes none of it on. */
let sqlError = "";

const rows = async <T>(sql: string, params: unknown[] = []) =>
  (await db.query<T>(sql, params)).rows;
/** Why a statement was refused, or null when it ran. */
const refusedFor = (sql: string) =>
  db.query(sql).then(
    () => null,
    (error: Error) => error.message,
  );

function done<T>(stored: Stored<T>): T {
  if ("failed" in stored) throw new Error(`The database gave no usable answer. ${sqlError}`);
  return stored.value;
}

/** When a member joins, and how many the day may take: far more than any test makes, unless it says. */
type Joining = { week?: number; day?: number; cap?: number };

const join = async (
  rewardsKey: string,
  code: string,
  inviteCode: string | null = null,
  { week = 0, day = 0, cap = 1_000 }: Joining = {},
) =>
  done(
    await storage.join({
      rewardsKey,
      code,
      inviteCode,
      joinedWeek: week,
      joinedDay: day,
      dailyJoinCap: cap,
    }),
  );
const credit = async (rewardsKey: string, fingerprint: string, week: number, fee: bigint) =>
  done(await storage.credit({ rewardsKey, fingerprint, week, feeMicroUsdc: fee }));
const settle = async (weeks: number) => done(await storage.settle(weeks, POT));
const traders = async (week: number) => done(await storage.traders(week));
const state = async (rewardsKey: string, week: number | null) =>
  done(await storage.state(rewardsKey, week));

/** The points handed out for `week`, by member. */
async function pointsOf(week: number): Promise<Record<string, bigint>> {
  const handed = await rows<{ rewards_key: string; points: string }>(
    "select rewards_key, points::text from public.rewards_points where week = $1",
    [week],
  );
  return Object.fromEntries(handed.map((row) => [row.rewards_key, BigInt(row.points)]));
}

let fingerprints = 0;
/** A credited trade of `rewardsKey` in `week`, under a fingerprint of its own. */
const traded = (rewardsKey: string, week: number, fee: bigint) => {
  fingerprints += 1;
  return credit(rewardsKey, `fingerprint-${fingerprints}`, week, fee);
};

beforeAll(async () => {
  db = new PGlite();
  // The roles as a Supabase project has them: the two public ones, and the one the secret key acts as.
  await db.exec(`
    create role anon nologin noinherit;
    create role authenticated nologin noinherit;
    create role service_role nologin noinherit bypassrls;
  `);
  await db.exec(readFileSync(MIGRATION, "utf8"));
  storage = createRewardsDatabase({
    url: "http://database.example",
    secretKey: "not-sent-anywhere",
    relay: rest,
    log: () => undefined,
  });
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec(`reset role; truncate ${TABLES.map((table) => `public.${table}`).join(", ")}`);
  await db.exec("set role service_role");
});

describe("rewards_join", () => {
  it("makes a member once: joining again keeps the first code and adds no row", async () => {
    expect(await join("alice", "AAAAAAAA")).toBe("joined");
    expect(await join("alice", "BBBBBBBB")).toBe("member");
    expect(await rows("select rewards_key, code from public.rewards_members")).toEqual([
      { rewards_key: "alice", code: "AAAAAAAA" },
    ]);
  });

  it("gives no two members one code, and creates nobody for a code already taken", async () => {
    await join("alice", "AAAAAAAA");
    expect(await join("bob", "AAAAAAAA")).toBe("code_taken");
    expect(await state("bob", 0)).toBeNull();
  });

  it("binds a new member to the member whose active code they joined with", async () => {
    await join("alice", "AAAAAAAA");
    await traded("alice", 0, 1_000n);
    expect(await join("bob", "BBBBBBBB", "AAAAAAAA")).toBe("joined");
    expect((await state("bob", 0))?.wasInvited).toBe(true);
    expect((await state("alice", 0))?.invited).toBe(1);
  });

  it("refuses a code nobody has, and creates nobody", async () => {
    expect(await join("bob", "BBBBBBBB", "NOBODYS2")).toBe("invite_invalid");
    expect(await rows("select 1 from public.rewards_members")).toHaveLength(0);
  });

  it("refuses the code of a member with no credited trade, and creates nobody", async () => {
    await join("alice", "AAAAAAAA");
    expect(await join("bob", "BBBBBBBB", "AAAAAAAA")).toBe("invite_invalid");
    expect(await state("bob", 0)).toBeNull();
  });

  it("binds only at the first join: a member who joins again with an active code stays uninvited", async () => {
    await join("alice", "AAAAAAAA");
    await traded("alice", 0, 1_000n);
    await join("bob", "BBBBBBBB");
    expect(await join("bob", "CCCCCCCC", "AAAAAAAA")).toBe("member");
    expect((await state("bob", 0))?.wasInvited).toBe(false);
    expect((await state("alice", 0))?.invited).toBe(0);
  });

  it("never binds a member to themselves", async () => {
    await join("alice", "AAAAAAAA");
    await traded("alice", 0, 1_000n);
    expect(await join("alice", "CCCCCCCC", "AAAAAAAA")).toBe("member");
    expect(await rows("select invited_by from public.rewards_members")).toEqual([
      { invited_by: null },
    ]);
  });
});

describe("the cap on new members in one day", () => {
  it("makes no member past the cap, and nothing of the refused key is kept", async () => {
    expect(await join("alice", "AAAAAAAA", null, { day: 20_000, cap: 2 })).toBe("joined");
    expect(await join("bob", "BBBBBBBB", null, { day: 20_000, cap: 2 })).toBe("joined");
    expect(await join("carol", "CCCCCCCC", null, { day: 20_000, cap: 2 })).toBe("cap_reached");
    expect(await rows("select rewards_key from public.rewards_members order by 1")).toEqual([
      { rewards_key: "alice" },
      { rewards_key: "bob" },
    ]);
  });

  it("still answers a member who joins again on a day that is full", async () => {
    await join("alice", "AAAAAAAA", null, { day: 20_000, cap: 1 });
    expect(await join("alice", "BBBBBBBB", null, { day: 20_000, cap: 1 })).toBe("member");
  });

  it("counts each UTC day on its own", async () => {
    await join("alice", "AAAAAAAA", null, { day: 20_000, cap: 1 });
    expect(await join("bob", "BBBBBBBB", null, { day: 20_001, cap: 1 })).toBe("joined");
    expect(await join("carol", "CCCCCCCC", null, { day: 20_000, cap: 1 })).toBe("cap_reached");
  });

  it("does not count a join that was refused for its invite code", async () => {
    expect(await join("bob", "BBBBBBBB", "NOBODYS2", { day: 20_000, cap: 1 })).toBe(
      "invite_invalid",
    );
    expect(await join("carol", "CCCCCCCC", null, { day: 20_000, cap: 1 })).toBe("joined");
  });
});

describe("rewards_credit", () => {
  beforeEach(() => join("alice", "AAAAAAAA"));

  it("adds each trade's fee to the member's week, and keeps weeks apart", async () => {
    expect(await credit("alice", "one", 2, 61_000n)).toBe("credited");
    await credit("alice", "two", 2, 9_000n);
    await credit("alice", "three", 3, 5n);
    expect((await state("alice", 2))?.weekFeeMicroUsdc).toBe(70_000n);
    expect((await state("alice", 3))?.weekFeeMicroUsdc).toBe(5n);
  });

  it("refuses a fingerprint it has seen, whoever sends it, and changes no total", async () => {
    await join("bob", "BBBBBBBB");
    await credit("alice", "one", 2, 61_000n);
    expect(await credit("alice", "one", 2, 61_000n)).toBe("duplicate");
    expect(await credit("bob", "one", 2, 61_000n)).toBe("duplicate");
    expect((await state("alice", 2))?.weekFeeMicroUsdc).toBe(61_000n);
    expect((await state("bob", 2))?.weekFeeMicroUsdc).toBe(0n);
  });

  it("makes a member's code active with their first credit, and not before", async () => {
    expect((await state("alice", 0))?.codeActive).toBe(false);
    await credit("alice", "one", 0, 1n);
    expect((await state("alice", 0))?.codeActive).toBe(true);
  });

  it("credits nobody who has not joined, and remembers nothing of the attempt", async () => {
    expect(await credit("stranger", "one", 0, 1_000n)).toBe("not_member");
    expect(await rows("select 1 from public.rewards_claims")).toHaveLength(0);
  });

  it("keeps a fee beyond what a JavaScript number holds, to the digit", async () => {
    await credit("alice", "one", 0, 9_007_199_254_740_993n);
    expect((await state("alice", 0))?.weekFeeMicroUsdc).toBe(9_007_199_254_740_993n);
  });
});

describe("rewards_settle", () => {
  it("splits the pot by score, each share rounded down, never handing out more than the pot", async () => {
    for (const member of ["alice", "bob", "carol"]) {
      await join(member, `${member.toUpperCase()}000`.slice(0, 8));
      await traded(member, 0, 1_000n);
    }
    await settle(1);
    expect(await pointsOf(0)).toEqual({ alice: 33_333n, bob: 33_333n, carol: 33_333n });
  });

  it("gives the inviter 0.2 of the fees of the members they invited, without fees of their own that week", async () => {
    await join("alice", "AAAAAAAA");
    await traded("alice", 0, 1n);
    await join("bob", "BBBBBBBB", "AAAAAAAA", { week: 1 });
    await traded("bob", 1, 1_000n);
    await settle(2);
    // Bob scores 1,100 of 1,300 and Alice 200.
    expect(await pointsOf(1)).toEqual({ alice: 15_384n, bob: 84_615n });
  });

  it("counts an invited member's fees 1.1 times for eight weeks from the week they joined in, and once after", async () => {
    await join("alice", "AAAAAAAA");
    await traded("alice", 0, 1n);
    await join("bob", "BBBBBBBB", "AAAAAAAA", { week: 2 });
    await join("carol", "CCCCCCCC");
    for (const week of [9, 10]) {
      await traded("bob", week, 1_000n);
      await traded("carol", week, 1_000n);
    }
    await settle(11);
    // Week 9 is Bob's eighth: 1,100 against Carol's 1,000 and Alice's 200. In week 10 he scores 1,000.
    expect(await pointsOf(9)).toEqual({ alice: 8_695n, bob: 47_826n, carol: 43_478n });
    expect(await pointsOf(10)).toEqual({ alice: 9_090n, bob: 45_454n, carol: 45_454n });
  });

  it("counts a trade from a week before its member joined once, and gives the inviter nothing of it", async () => {
    await join("alice", "AAAAAAAA");
    await traded("alice", 0, 1n);
    await join("carol", "CCCCCCCC");
    // Bob traded in week 3, joined with Alice's code in week 4, and claimed inside the day of grace.
    await join("bob", "BBBBBBBB", "AAAAAAAA", { week: 4 });
    await traded("bob", 3, 1_000n);
    await traded("carol", 3, 1_000n);
    await traded("bob", 4, 1_000n);
    await settle(5);
    expect(await pointsOf(3)).toEqual({ bob: 50_000n, carol: 50_000n });
    // From the week he joined in, both count: 1,100 for Bob and 200 for Alice.
    expect(await pointsOf(4)).toEqual({ alice: 15_384n, bob: 84_615n });
  });

  it("gives no bonus to a member who joined without a code", async () => {
    await join("alice", "AAAAAAAA");
    await join("bob", "BBBBBBBB");
    await traded("alice", 0, 1_000n);
    await traded("bob", 0, 1_000n);
    await settle(1);
    expect(await pointsOf(0)).toEqual({ alice: 50_000n, bob: 50_000n });
  });

  it("marks a week nobody traded in as settled, and hands out nothing for it", async () => {
    await join("alice", "AAAAAAAA");
    await settle(1);
    expect(await rows("select week from public.rewards_settled_weeks")).toEqual([{ week: 0 }]);
    expect(await rows("select 1 from public.rewards_points")).toHaveLength(0);
  });

  it("settles a week once: called again, even with more fees to count, it changes nothing", async () => {
    await join("alice", "AAAAAAAA");
    await join("bob", "BBBBBBBB");
    await traded("alice", 0, 1_000n);
    await settle(1);
    // Written past the function, as nothing in the application can: a second settlement would count it.
    await db.query(
      "insert into public.rewards_week_fees (rewards_key, week, fee_micro_usdc) values ('bob', 0, 1000)",
    );
    await settle(1);
    expect(await pointsOf(0)).toEqual({ alice: 100_000n });
  });

  it("settles only the weeks it is asked for", async () => {
    await join("alice", "AAAAAAAA");
    await traded("alice", 0, 1_000n);
    await traded("alice", 1, 1_000n);
    await settle(1);
    expect((await state("alice", 1))?.points).toBe(100_000n);
    await settle(2);
    expect((await state("alice", 1))?.points).toBe(200_000n);
  });

  it("takes no credit for a week already settled: the fee, the fingerprint and the points stay as they were", async () => {
    await join("alice", "AAAAAAAA");
    await join("bob", "BBBBBBBB");
    await traded("alice", 0, 1_000n);
    await settle(1);
    expect(await credit("bob", "late", 0, 5_000n)).toBe("settled");
    expect((await state("bob", 0))?.weekFeeMicroUsdc).toBe(0n);
    expect(await rows("select 1 from public.rewards_claims where fingerprint = 'late'")).toEqual(
      [],
    );
    expect(await pointsOf(0)).toEqual({ alice: 100_000n });
  });
});

describe("rewards_week_traders", () => {
  beforeEach(async () => {
    await join("alice", "AAAAAAAA");
    await join("bob", "BBBBBBBB");
  });

  it("counts the members with a fee in the week, and none who only joined", async () => {
    await traded("alice", 2, 1_000n);
    expect(await traders(2)).toBe(1);
    await traded("bob", 2, 1n);
    expect(await traders(2)).toBe(2);
  });

  it("counts a member once, however many trades they claimed that week", async () => {
    await traded("alice", 2, 1_000n);
    await traded("alice", 2, 2_000n);
    expect(await traders(2)).toBe(1);
  });

  it("counts a week on its own: a fee in another week is not this week's trader", async () => {
    await traded("alice", 1, 1_000n);
    await traded("bob", 3, 1_000n);
    expect([await traders(1), await traders(2), await traders(3)]).toEqual([1, 0, 1]);
  });

  it("is the number a member's state carries for the same week", async () => {
    await traded("alice", 2, 1_000n);
    await traded("bob", 2, 1_000n);
    await traded("bob", 3, 1_000n);
    expect((await state("alice", 2))?.weekTraders).toBe(await traders(2));
    expect((await state("alice", 3))?.weekTraders).toBe(1);
  });
});

describe("rewards_state", () => {
  it("returns the settled points next to the running week's fee and scores", async () => {
    await join("alice", "AAAAAAAA");
    await join("bob", "BBBBBBBB");
    await traded("alice", 0, 1_000n);
    await settle(1);
    await traded("alice", 1, 300n);
    await traded("bob", 1, 100n);
    expect(await state("alice", 1)).toEqual({
      code: "AAAAAAAA",
      codeActive: true,
      invited: 0,
      wasInvited: false,
      points: 100_000n,
      weekFeeMicroUsdc: 300n,
      weekScore: 3_000n,
      weekTotalScore: 4_000n,
      weekTraders: 2,
    });
  });

  it("returns the points with no week's amounts when asked outside the season", async () => {
    await join("alice", "AAAAAAAA");
    await traded("alice", 0, 1_000n);
    await settle(1);
    expect(await state("alice", null)).toMatchObject({
      points: 100_000n,
      weekFeeMicroUsdc: 0n,
      weekScore: 0n,
      weekTotalScore: 0n,
    });
  });

  it("has nothing for a key that has not joined", async () => {
    expect(await state("stranger", 0)).toBeNull();
  });
});

describe("who may reach the rewards tables", () => {
  const CALLS = [
    "public.rewards_scores(0)",
    "public.rewards_week_traders(0)",
    "public.rewards_join('mallory', 'MMMMMMMM', null, 0, 0, 1000)",
    "public.rewards_state('alice', 0)",
    "public.rewards_credit('alice', 'forged', 0, 1000000)",
    "public.rewards_settle(12, 100000)",
  ];

  it("has row level security on for all five tables, and not one policy", async () => {
    const secured = await rows<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_catalog.pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname",
    );
    expect(secured).toEqual(
      [...TABLES].sort().map((relname) => ({ relname, relrowsecurity: true })),
    );
    expect(await rows("select 1 from pg_catalog.pg_policies where schemaname = 'public'")).toEqual(
      [],
    );
  });

  for (const role of ["anon", "authenticated"]) {
    it(`lets ${role} read no table`, async () => {
      await join("alice", "AAAAAAAA");
      await db.exec(`reset role; set role ${role}`);
      for (const table of TABLES) {
        expect(await refusedFor(`select * from public.${table}`), table).toMatch(
          /permission denied for table/,
        );
      }
    });

    it(`lets ${role} write to no table`, async () => {
      await db.exec(`reset role; set role ${role}`);
      expect(
        await refusedFor("insert into public.rewards_claims (fingerprint) values ('forged')"),
      ).toMatch(/permission denied for table/);
    });

    it(`lets ${role} execute none of the functions`, async () => {
      await join("alice", "AAAAAAAA");
      await db.exec(`reset role; set role ${role}`);
      for (const call of CALLS) {
        expect(await refusedFor(`select ${call}`), call).toMatch(/permission denied for function/);
      }
    });
  }

  it("does not let the tables be read by a role that only has row level security in its way", async () => {
    await join("alice", "AAAAAAAA");
    await db.exec(`
      reset role;
      create role reader nologin;
      grant select on public.rewards_members to reader;
      set role reader;
    `);
    expect(await rows("select 1 from public.rewards_members")).toEqual([]);
    await db.exec("reset role; revoke all on public.rewards_members from reader; drop role reader");
  });
});

describe("the rules in SQL and in points.ts", () => {
  it("hand out the same points for the same members and fees, week by week", async () => {
    // A fixed sequence, so a failure can be run again: inviters, invited members
    // who joined in different weeks, members with no fees, and fees of every size.
    let seed = 20_261_008;
    const next = (below: number) => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % below;
    };
    const WEEKS = 12;
    const members: Scorer[] = [];
    const fees = Array.from({ length: WEEKS }, () => new Map<string, bigint>());

    for (let index = 0; index < 40; index += 1) {
      const rewardsKey = `member-${index}`;
      // Early enough that many members pass their eighth week inside the season.
      const joinedWeek = next(6) - 2;
      // Only a member with a credited trade has a code that can be joined with.
      const inviters = members.filter(({ rewardsKey: key }) => fees.some((week) => week.has(key)));
      const inviter = inviters.length > 0 && next(3) > 0 ? inviters[next(inviters.length)] : null;
      const code = `M${String(index).padStart(7, "0")}`;
      const inviteCode = inviter && `M${inviter.rewardsKey.slice(7).padStart(7, "0")}`;
      expect(await join(rewardsKey, code, inviteCode, { week: joinedWeek })).toBe("joined");
      members.push({ rewardsKey, invitedBy: inviter?.rewardsKey ?? null, joinedWeek });

      for (let week = 0; week < WEEKS; week += 1) {
        if (next(4) === 0) continue;
        for (let trades = next(3); trades >= 0; trades -= 1) {
          const fee = BigInt(next(5_000_000) + 1) * BigInt(next(1_000) + 1);
          await traded(rewardsKey, week, fee);
          fees[week].set(rewardsKey, (fees[week].get(rewardsKey) ?? 0n) + fee);
        }
      }
    }
    await settle(WEEKS);

    for (let week = 0; week < WEEKS; week += 1) {
      const expected = splitPoints(weeklyScores(week, members, fees[week]), BigInt(POT));
      const paid = Object.fromEntries([...expected].filter(([, points]) => points > 0n));
      expect(await pointsOf(week), `week ${week}`).toEqual(paid);
      const total = Object.values(paid).reduce((sum, points) => sum + points, 0n);
      expect(total, `week ${week}`).toBeLessThanOrEqual(BigInt(POT));
      // The stand-in counts a week's traders as the members it holds fees for.
      expect(await traders(week), `traders of week ${week}`).toBe(fees[week].size);
    }
    // The sequence must reach the edge of the bonus from both sides, or agreeing there proves nothing.
    const invitedTradedAt = (weeksIn: number) =>
      members.some(
        (member) =>
          member.invitedBy !== null && fees[member.joinedWeek + weeksIn]?.has(member.rewardsKey),
      );
    // And a trade from the week before an invited member joined, which earns no bonus and no share.
    expect([invitedTradedAt(-1), invitedTradedAt(7), invitedTradedAt(8)]).toEqual([
      true,
      true,
      true,
    ]);
  });
});

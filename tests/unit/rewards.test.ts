import { createHmac } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { beforeEach, describe, expect, it } from "vitest";
import { refusal, type Answer } from "../../src/common/core/answer.js";
import type { LogLine } from "../../src/common/core/log.js";
import type { ChainTransaction } from "../../src/rewards/core/claim.js";
import {
  CODE_ALPHABET,
  createRewards,
  TOTALS_TTL_MS,
  type Rewards,
} from "../../src/rewards/core/rewards.js";
import {
  DAY_MS,
  memoryRewardsStorage,
  REFERRAL_ACCOUNT,
  SEASON_START_MS,
  signed,
  trade,
  transactionId,
  USDC_MINT,
  WEEK_MS,
  type MemoryRewards,
} from "../support/rewards.js";

/**
 * The rewards routes' rules, with the database kept in memory, a stand-in
 * for the chain and a clock the tests move. No framework is involved.
 */

const FINGERPRINT_SECRET = "a-fingerprint-secret-of-32-chars!";
const CALLER = { sessionId: "session-1", ip: "10.0.0.1" };

let clock: number;
let logged: LogLine[];
let store: MemoryRewards;
/** The finalized transactions the stand-in chain holds, by id, and every id it was asked for. */
let chain: Map<string, ChainTransaction>;
let looked: string[];
let allowed: boolean;
let codes: string[];
let settleCalls: number;
let totalsCalls: number;
let databaseDown: Answer | null;

type Deployment = { off?: boolean; dailyJoinCap?: number; doubleHourStartMs?: number };

function rewards(options: Deployment = {}): Rewards {
  return createRewards({
    upstream: options.off
      ? null
      : {
          storage: {
            join: (member) =>
              databaseDown ? Promise.resolve({ failed: databaseDown }) : store.storage.join(member),
            state: (rewardsKey, week) =>
              databaseDown
                ? Promise.resolve({ failed: databaseDown })
                : store.storage.state(rewardsKey, week),
            credit: (credit) => store.storage.credit(credit),
            settle: (weeks, weeklyPoints) => {
              settleCalls += 1;
              return store.storage.settle(weeks, weeklyPoints);
            },
            totals: (week) => {
              totalsCalls += 1;
              return databaseDown
                ? Promise.resolve({ failed: databaseDown })
                : store.storage.totals(week);
            },
          },
          transactions: {
            finalized: (signature) => {
              looked.push(signature);
              return Promise.resolve({ transaction: chain.get(signature) ?? null });
            },
          },
          rpcAllowance: () => Promise.resolve(allowed),
          seasonStartMs: SEASON_START_MS,
          dailyJoinCap: options.dailyJoinCap ?? 2_000,
          doubleHourStartMs: options.doubleHourStartMs ?? null,
          referralAccount: REFERRAL_ACCOUNT,
          usdcMint: USDC_MINT,
          fingerprintSecret: FINGERPRINT_SECRET,
        },
    log: (line) => void logged.push(line),
    now: () => clock,
    ...(codes.length > 0 ? { newCode: () => codes.shift() ?? "ZZZZZZZZ" } : {}),
  });
}

const seconds = () => Math.floor(clock / 1_000);
const read = (answered: Answer) => JSON.parse(answered.body ?? "null");
const outcome = (answered: Answer) => [answered.status, read(answered)?.code];

type Extra = {
  inviteCode?: string;
  /** The invite code the member signs for, when it is not the one sent as the server takes it. */
  signedCode?: string;
  at?: number | string;
  signer?: Keypair;
};

function join(api: Rewards, member: Keypair, extra: Extra = {}) {
  const rewardsKey = member.publicKey.toBase58();
  const at = extra.at ?? seconds();
  const signedCode = extra.signedCode ?? extra.inviteCode?.trim().toUpperCase() ?? "";
  return api.join(
    JSON.stringify({
      rewardsKey,
      at,
      signature: signed(extra.signer ?? member, "join", rewardsKey, String(at), signedCode),
      ...(extra.inviteCode === undefined ? {} : { inviteCode: extra.inviteCode }),
    }),
  );
}

function state(api: Rewards, member: Keypair, extra: Extra = {}) {
  const rewardsKey = member.publicKey.toBase58();
  const at = extra.at ?? seconds();
  return api.state(
    JSON.stringify({
      rewardsKey,
      at,
      signature: signed(extra.signer ?? member, "state", rewardsKey, String(at)),
    }),
  );
}

/** A trade of `portfolio` the chain has finalized, made at the clock's time. Returns its id. */
function landed(portfolio: Keypair, options: { fee?: bigint; succeeded?: boolean } = {}): string {
  const id = transactionId();
  chain.set(
    id,
    trade({
      portfolio: portfolio.publicKey.toBase58(),
      blockTime: seconds(),
      feeMicroUsdc: options.fee,
      succeeded: options.succeeded,
    }),
  );
  return id;
}

type Signers = { rewards?: Keypair; portfolio?: Keypair };

function claim(
  api: Rewards,
  member: Keypair,
  portfolio: Keypair,
  id: string,
  signers: Signers = {},
) {
  const rewardsKey = member.publicKey.toBase58();
  return api.claim(
    JSON.stringify({
      rewardsKey,
      transaction: id,
      portfolio: portfolio.publicKey.toBase58(),
      portfolioSignature: signed(signers.portfolio ?? portfolio, "claim", rewardsKey, id),
      rewardsSignature: signed(signers.rewards ?? member, "claim", rewardsKey, id),
    }),
    CALLER,
  );
}

/** A member with one credited trade, so that their code can be joined with. */
async function activeMember(api: Rewards): Promise<{ member: Keypair; code: string }> {
  const member = Keypair.generate();
  const portfolio = Keypair.generate();
  await join(api, member);
  const credited = await claim(api, member, portfolio, landed(portfolio, { fee: 1_000n }));
  return { member, code: read(credited).state.code };
}

beforeEach(() => {
  clock = SEASON_START_MS + 2 * WEEK_MS + DAY_MS;
  logged = [];
  store = memoryRewardsStorage();
  chain = new Map();
  looked = [];
  allowed = true;
  codes = [];
  settleCalls = 0;
  totalsCalls = 0;
  databaseDown = null;
});

describe("a deployment with no rewards", () => {
  it("says so with every field null, and has no other route", async () => {
    const api = rewards({ off: true });
    expect(read(await api.config())).toEqual({
      enabled: false,
      seasonStart: null,
      seasonWeeks: null,
      weeklyPoints: null,
      members: null,
      tradersThisWeek: null,
      doubleHour: null,
    });
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    for (const answered of [
      join(api, member),
      state(api, member),
      claim(api, member, portfolio, landed(portfolio)),
    ]) {
      expect(outcome(await answered)).toEqual([404, "not_found"]);
    }
    expect(looked).toHaveLength(0);
  });
});

describe("the season", () => {
  it("is stated from the configuration: its start, twelve weeks, 100,000 points a week", async () => {
    expect(read(await rewards().config())).toEqual({
      enabled: true,
      seasonStart: "2026-10-19T00:00:00.000Z",
      seasonWeeks: 12,
      weeklyPoints: 100_000,
      members: 0,
      tradersThisWeek: 0,
      doubleHour: null,
    });
  });
});

describe("the count of this week's traders", () => {
  /** A new member with one credited trade at the clock's time. */
  async function trader(api: Rewards): Promise<Keypair> {
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    await join(api, member);
    await claim(api, member, portfolio, landed(portfolio));
    return member;
  }
  const count = async (api: Rewards) => read(await api.config()).tradersThisWeek;

  it("is the members with a fee credited in the running week, and the same number in a member's state", async () => {
    const api = rewards();
    const member = await trader(api);
    await trader(api);
    await join(api, Keypair.generate());
    expect(await count(api)).toBe(2);
    expect(read(await state(api, member)).week.traders).toBe(2);
  });

  it("is null outside the season, while the members are still counted", async () => {
    const api = rewards();
    await trader(api);
    for (const outside of [SEASON_START_MS - 1_000, SEASON_START_MS + 12 * WEEK_MS]) {
      clock = outside;
      expect(read(await api.config())).toMatchObject({ tradersThisWeek: null, members: 1 });
    }
  });

  it("is read once and answered for 60 seconds, then read again", async () => {
    const api = rewards();
    await trader(api);
    expect(await count(api)).toBe(1);
    await trader(api);

    clock += TOTALS_TTL_MS - 1;
    expect(await count(api)).toBe(1);
    expect(totalsCalls).toBe(1);

    clock += 1;
    expect(await count(api)).toBe(2);
    expect(totalsCalls).toBe(2);
  });

  it("comes with the count of all members, traders or not, from the same one read", async () => {
    const api = rewards();
    await trader(api);
    await join(api, Keypair.generate());
    await join(api, Keypair.generate());
    expect(read(await api.config())).toMatchObject({ members: 3, tradersThisWeek: 1 });
    expect(totalsCalls).toBe(1);

    // A member who joins inside the minute is counted when it is over, like a trader.
    await join(api, Keypair.generate());
    expect(read(await api.config()).members).toBe(3);
    clock += TOTALS_TTL_MS;
    expect(read(await api.config()).members).toBe(4);
    expect(totalsCalls).toBe(2);
  });

  it("is not last week's count in a week that has just begun", async () => {
    const api = rewards();
    clock = SEASON_START_MS + 3 * WEEK_MS - 1_000;
    await trader(api);
    expect(await count(api)).toBe(1);
    clock += 1_000;
    expect(await count(api)).toBe(0);
  });

  it("is null when the database gives no answer, and rewards are still stated as on", async () => {
    const api = rewards();
    databaseDown = refusal("upstream_timeout");
    const answered = await api.config();
    expect(answered.status).toBe(200);
    expect(read(answered)).toMatchObject({
      enabled: true,
      seasonWeeks: 12,
      members: null,
      tradersThisWeek: null,
    });
  });
});

describe("a member's number", () => {
  it("is 1, 2, 3 in the order of joining, and the same when a member joins again", async () => {
    const api = rewards();
    const members = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const numbers = [];
    for (const member of members) numbers.push(read(await join(api, member)).memberNumber);
    expect(numbers).toEqual([1, 2, 3]);
    expect(read(await join(api, members[1])).memberNumber).toBe(2);
    expect(read(await state(api, members[2])).memberNumber).toBe(3);
  });
});

describe("the double hour", () => {
  const hourStartMs = SEASON_START_MS + 2 * WEEK_MS + 3 * DAY_MS + 18 * 3_600_000;

  it("is stated with its start and its end an hour later, in ISO 8601", async () => {
    const stated = read(await rewards({ doubleHourStartMs: hourStartMs }).config()).doubleHour;
    expect(stated).toEqual({
      startsAt: "2026-11-05T18:00:00.000Z",
      endsAt: "2026-11-05T19:00:00.000Z",
    });
  });

  it("is null where none is set, and a trade made in that same hour counts once", async () => {
    const api = rewards();
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    await join(api, member);
    clock = hourStartMs + 60_000;
    await claim(api, member, portfolio, landed(portfolio, { fee: 61_000n }));
    expect(read(await api.config()).doubleHour).toBeNull();
    expect(store.stored()).not.toContain("122000");
  });

  it("counts a trade made in it twice toward the share, and shows the member the fee really paid", async () => {
    const api = rewards({ doubleHourStartMs: hourStartMs });
    const early = Keypair.generate();
    const inTheHour = Keypair.generate();
    const portfolios = [Keypair.generate(), Keypair.generate()];
    await join(api, early);
    await join(api, inTheHour);
    clock = hourStartMs - 60_000;
    await claim(api, early, portfolios[0], landed(portfolios[0], { fee: 61_000n }));
    clock = hourStartMs + 60_000;
    const credited = await claim(
      api,
      inTheHour,
      portfolios[1],
      landed(portfolios[1], { fee: 61_000n }),
    );

    // Both paid the same. The one who traded in the hour holds two thirds of the week.
    expect(read(credited)).toMatchObject({
      feeMicroUsdc: "61000",
      state: { week: { feeMicroUsdc: "61000", shareBps: 6_666 } },
    });
    expect(read(await state(api, early)).week.shareBps).toBe(3_333);
  });
});

describe("joining", () => {
  it("gives a new key a code of eight unambiguous characters, and the running week", async () => {
    const answered = await join(rewards(), Keypair.generate());
    expect(answered.status).toBe(200);
    const { code, ...rest } = read(answered);
    expect([...code].every((character) => CODE_ALPHABET.includes(character))).toBe(true);
    expect(code).toHaveLength(8);
    expect(rest).toEqual({
      codeActive: false,
      invited: 0,
      memberNumber: 1,
      wasInvited: false,
      boostWeeksLeft: 0,
      points: "0",
      week: {
        index: 2,
        endsAt: new Date(SEASON_START_MS + 3 * WEEK_MS).toISOString(),
        feeMicroUsdc: "0",
        shareBps: 0,
        traders: 0,
      },
    });
  });

  it("changes nothing the second time: the same code, and one member", async () => {
    const api = rewards();
    const member = Keypair.generate();
    const first = read(await join(api, member));
    clock += 60_000;
    expect(read(await join(api, member)).code).toBe(first.code);
    expect(store.members.size).toBe(1);
  });

  it("takes the signed time as a JSON number only, though the signature over its digits is good", async () => {
    const api = rewards();
    const answered = await join(api, Keypair.generate(), { at: String(seconds()) });
    expect(outcome(answered)).toEqual([400, "invalid_request"]);
    expect(store.members.size).toBe(0);
  });

  it("answers 422 for nothing but an invite code: a bad signature or a stale time sent with one is a 403", async () => {
    const api = rewards();
    const inviteCode = "NOBODYS2";
    const unsigned = await join(api, Keypair.generate(), {
      inviteCode,
      signer: Keypair.generate(),
    });
    const stale = await join(api, Keypair.generate(), { inviteCode, at: seconds() - 301 });
    expect([unsigned.status, stale.status]).toEqual([403, 403]);
  });

  it("refuses a signature that is not the rewards key's own, and creates nobody", async () => {
    const answered = await join(rewards(), Keypair.generate(), { signer: Keypair.generate() });
    expect(outcome(answered)).toEqual([403, "signature_invalid"]);
    expect(store.members.size).toBe(0);
  });

  it("refuses a time more than 300 seconds from the clock, either way", async () => {
    const api = rewards();
    for (const drift of [-301, 301]) {
      const answered = await join(api, Keypair.generate(), { at: seconds() + drift });
      expect(outcome(answered), String(drift)).toEqual([403, "clock_skew"]);
    }
    expect((await join(api, Keypair.generate(), { at: seconds() - 300 })).status).toBe(200);
    expect(store.members.size).toBe(1);
  });

  it("refuses a body that is not exactly the request", async () => {
    const api = rewards();
    const rewardsKey = Keypair.generate().publicKey.toBase58();
    for (const body of [
      "not json",
      JSON.stringify({ rewardsKey, at: seconds() }),
      JSON.stringify({ rewardsKey: "not-a-key", at: seconds(), signature: "1".repeat(64) }),
      JSON.stringify({ rewardsKey, at: 1.5, signature: "1".repeat(64) }),
      JSON.stringify({ rewardsKey, at: seconds(), signature: "1".repeat(64), portfolio: "x" }),
    ]) {
      expect(outcome(await api.join(body)), body).toEqual([400, "invalid_request"]);
    }
  });

  it("makes no new member once the day has as many as it may, and still answers one who joined before", async () => {
    const api = rewards({ dailyJoinCap: 2 });
    const first = Keypair.generate();
    await join(api, first);
    await join(api, Keypair.generate());

    const late = await join(api, Keypair.generate());
    expect(outcome(late)).toEqual([429, "rate_limited"]);
    expect(store.members.size).toBe(2);
    expect((await join(api, first)).status).toBe(200);
  });

  it("counts new members by the UTC day of this server's clock", async () => {
    const api = rewards({ dailyJoinCap: 1 });
    clock = Date.UTC(2026, 10, 3, 23, 59, 59);
    await join(api, Keypair.generate());
    expect(outcome(await join(api, Keypair.generate()))).toEqual([429, "rate_limited"]);
    clock += 1_000;
    expect((await join(api, Keypair.generate())).status).toBe(200);
  });

  it("draws another code when the first is another member's", async () => {
    codes = ["AAAAAAAA", "AAAAAAAA", "BBBBBBBB"];
    const api = rewards();
    expect(read(await join(api, Keypair.generate())).code).toBe("AAAAAAAA");
    expect(read(await join(api, Keypair.generate())).code).toBe("BBBBBBBB");
  });
});

describe("an invite code", () => {
  it("ties a new member to the member whose code it is, once that member has a credited trade", async () => {
    const api = rewards();
    const { member: inviter, code } = await activeMember(api);
    const answered = await join(api, Keypair.generate(), { inviteCode: code.toLowerCase() });
    expect(read(answered).wasInvited).toBe(true);
    expect(read(await state(api, inviter)).invited).toBe(1);
  });

  it("must be the one the member signed for: a code added, swapped or removed on the way is refused", async () => {
    const api = rewards();
    const { member: inviter, code } = await activeMember(api);
    const { code: other } = await activeMember(api);
    const tampered: Extra[] = [
      { inviteCode: code, signedCode: "" },
      { inviteCode: code, signedCode: other },
      { signedCode: code },
    ];
    for (const extra of tampered) {
      const answered = await join(api, Keypair.generate(), extra);
      expect(outcome(answered), JSON.stringify(extra)).toEqual([403, "signature_invalid"]);
    }
    expect(store.members.size).toBe(2);
    expect(read(await state(api, inviter)).invited).toBe(0);
  });

  it("is signed as it is taken, trimmed and in capitals, not as it was typed", async () => {
    const api = rewards();
    const { code } = await activeMember(api);
    const typed = ` ${code.toLowerCase()} `;
    const asTyped = await join(api, Keypair.generate(), { inviteCode: typed, signedCode: typed });
    expect(outcome(asTyped)).toEqual([403, "signature_invalid"]);
    const asTaken = await join(api, Keypair.generate(), { inviteCode: typed, signedCode: code });
    expect(read(asTaken).wasInvited).toBe(true);
  });

  it("is refused when nobody has it, and nothing is created", async () => {
    const answered = await join(rewards(), Keypair.generate(), { inviteCode: "NOBODYS2" });
    expect(outcome(answered)).toEqual([422, "invite_code_invalid"]);
    expect(store.members.size).toBe(0);
  });

  it("is refused while its member has no credited trade", async () => {
    const api = rewards();
    const { code } = read(await join(api, Keypair.generate()));
    const answered = await join(api, Keypair.generate(), { inviteCode: code });
    expect(outcome(answered)).toEqual([422, "invite_code_invalid"]);
    expect(store.members.size).toBe(1);
  });

  it("counts only at the first join: a member cannot add one later, their own or anyone's", async () => {
    const api = rewards();
    const { member, code: own } = await activeMember(api);
    const { code: other } = await activeMember(api);
    for (const inviteCode of [own, other, "NOBODYS2"]) {
      const again = await join(api, member, { inviteCode });
      expect([again.status, read(again).wasInvited], inviteCode).toEqual([200, false]);
    }
  });
});

describe("the weeks of the bonus an invited member has left", () => {
  const left = async (api: Rewards, member: Keypair) =>
    read(await state(api, member)).boostWeeksLeft;

  it("are all eight in the week they joined in, one in the eighth, and none after", async () => {
    const api = rewards();
    const { code } = await activeMember(api);
    const invited = Keypair.generate();
    expect(read(await join(api, invited, { inviteCode: code })).boostWeeksLeft).toBe(8);

    clock += 7 * WEEK_MS;
    expect(await left(api, invited)).toBe(1);
    clock += WEEK_MS;
    expect(await left(api, invited)).toBe(0);
  });

  it("are none for a member who joined without a code, their inviter included", async () => {
    const api = rewards();
    const { member: inviter, code } = await activeMember(api);
    await join(api, Keypair.generate(), { inviteCode: code });
    expect(await left(api, inviter)).toBe(0);
  });

  it("are still counted once the season is over, and never below zero", async () => {
    const api = rewards();
    const { code } = await activeMember(api);
    const invited = Keypair.generate();
    clock = SEASON_START_MS + 11 * WEEK_MS;
    await join(api, invited, { inviteCode: code });

    clock = SEASON_START_MS + 13 * WEEK_MS;
    expect(read(await state(api, invited))).toMatchObject({ week: null, boostWeeksLeft: 6 });
    clock = SEASON_START_MS + 40 * WEEK_MS;
    expect(await left(api, invited)).toBe(0);
  });
});

describe("a member's state", () => {
  it("is not there for a key that has not joined", async () => {
    expect(outcome(await state(rewards(), Keypair.generate()))).toEqual([404, "not_a_member"]);
  });

  it("is read only with the key's own signature of this moment", async () => {
    const api = rewards();
    const member = Keypair.generate();
    await join(api, member);
    expect(outcome(await state(api, member, { signer: Keypair.generate() }))).toEqual([
      403,
      "signature_invalid",
    ]);
    expect(outcome(await state(api, member, { at: seconds() - 301 }))).toEqual([403, "clock_skew"]);
  });

  it("does not take a join's signature for a read", async () => {
    const api = rewards();
    const member = Keypair.generate();
    const rewardsKey = member.publicKey.toBase58();
    await join(api, member);
    const at = seconds();
    const body = { rewardsKey, at, signature: signed(member, "join", rewardsKey, String(at), "") };
    expect(outcome(await api.state(JSON.stringify(body)))).toEqual([403, "signature_invalid"]);
  });

  it("passes on the database's failure, and nothing of what it said", async () => {
    const api = rewards();
    databaseDown = refusal("upstream_timeout");
    expect(outcome(await state(api, Keypair.generate()))).toEqual([504, "upstream_timeout"]);
    expect(outcome(await join(api, Keypair.generate()))).toEqual([504, "upstream_timeout"]);
  });
});

describe("a claim", () => {
  let api: Rewards;
  let member: Keypair;
  let portfolio: Keypair;

  beforeEach(async () => {
    api = rewards();
    member = Keypair.generate();
    portfolio = Keypair.generate();
    await join(api, member);
  });

  it("credits the fee the chain shows to the member's running week, and activates their code", async () => {
    const answered = await claim(api, member, portfolio, landed(portfolio, { fee: 61_000n }));
    expect(answered.status).toBe(200);
    expect(read(answered)).toMatchObject({
      credited: true,
      feeMicroUsdc: "61000",
      state: { codeActive: true, week: { index: 2, feeMicroUsdc: "61000", shareBps: 10_000 } },
    });
  });

  it("adds up a member's trades of one week", async () => {
    await claim(api, member, portfolio, landed(portfolio, { fee: 61_000n }));
    const second = await claim(api, member, portfolio, landed(portfolio, { fee: 9_000n }));
    expect(read(second).state.week.feeMicroUsdc).toBe("70000");
  });

  it("is refused without both signatures over the claim, before the chain is read", async () => {
    const id = landed(portfolio);
    const stranger = Keypair.generate();
    expect(outcome(await claim(api, member, portfolio, id, { portfolio: stranger }))).toEqual([
      403,
      "signature_invalid",
    ]);
    expect(outcome(await claim(api, member, portfolio, id, { rewards: stranger }))).toEqual([
      403,
      "signature_invalid",
    ]);
    expect(looked).toHaveLength(0);
  });

  it("does not take signatures made for another transaction", async () => {
    const id = landed(portfolio);
    const other = landed(portfolio);
    const rewardsKey = member.publicKey.toBase58();
    const body = {
      rewardsKey,
      transaction: id,
      portfolio: portfolio.publicKey.toBase58(),
      portfolioSignature: signed(portfolio, "claim", rewardsKey, other),
      rewardsSignature: signed(member, "claim", rewardsKey, other),
    };
    expect(outcome(await api.claim(JSON.stringify(body), CALLER))).toEqual([
      403,
      "signature_invalid",
    ]);
  });

  it("refuses one key as both the rewards key and the portfolio", async () => {
    expect(outcome(await claim(api, member, member, landed(member)))).toEqual([
      400,
      "invalid_request",
    ]);
  });

  it("is not there for a key that has not joined, and the chain is not read for it", async () => {
    const stranger = Keypair.generate();
    expect(outcome(await claim(api, stranger, portfolio, landed(portfolio)))).toEqual([
      404,
      "not_a_member",
    ]);
    expect(looked).toHaveLength(0);
  });

  it("asks again later for a transaction the chain has not finalized, and credits it then", async () => {
    const id = transactionId();
    expect(outcome(await claim(api, member, portfolio, id))).toEqual([
      422,
      "transaction_not_finalized",
    ]);
    chain.set(id, trade({ portfolio: portfolio.publicKey.toBase58(), blockTime: seconds() }));
    expect((await claim(api, member, portfolio, id)).status).toBe(200);
  });

  it("refuses a failed trade, a trade with no fee and a portfolio that did not sign, and credits nothing", async () => {
    const bystander = Keypair.generate();
    const refusals: [id: string, by: Keypair, code: string][] = [
      [landed(portfolio, { succeeded: false }), portfolio, "transaction_failed"],
      [landed(portfolio, { fee: 0n }), portfolio, "no_referral_fee"],
      [landed(portfolio), bystander, "not_a_signer"],
    ];
    for (const [id, by, code] of refusals) {
      expect(outcome(await claim(api, member, by, id)), code).toEqual([422, code]);
    }
    expect(read(await state(api, member))).toMatchObject({
      codeActive: false,
      week: { feeMicroUsdc: "0" },
    });
  });

  it("takes a trade until 24 hours after its week ended, and not after", async () => {
    const early = landed(portfolio);
    const late = landed(portfolio);
    clock = SEASON_START_MS + 3 * WEEK_MS + DAY_MS - 1_000;
    expect((await claim(api, member, portfolio, early)).status).toBe(200);
    clock += 1_000;
    expect(outcome(await claim(api, member, portfolio, late))).toEqual([
      422,
      "outside_claim_window",
    ]);
  });

  it("refuses a trade made before the season began", async () => {
    clock = SEASON_START_MS - DAY_MS;
    const id = landed(portfolio);
    clock = SEASON_START_MS + DAY_MS;
    expect(outcome(await claim(api, member, portfolio, id))).toEqual([422, "outside_claim_window"]);
  });

  it("credits a transaction once, whoever claims it again", async () => {
    const id = landed(portfolio, { fee: 61_000n });
    await claim(api, member, portfolio, id);
    const other = Keypair.generate();
    await join(api, other);

    expect(outcome(await claim(api, member, portfolio, id))).toEqual([409, "already_claimed"]);
    expect(outcome(await claim(api, other, portfolio, id))).toEqual([409, "already_claimed"]);
    expect(read(await state(api, member)).week.feeMicroUsdc).toBe("61000");
    expect(read(await state(api, other)).week.feeMicroUsdc).toBe("0");
  });

  it("is told to wait when the RPC provider's allowance is spent, and the chain is not read", async () => {
    allowed = false;
    const answered = await claim(api, member, portfolio, landed(portfolio));
    expect(outcome(answered)).toEqual([429, "rate_limited"]);
    expect(answered.headers?.["Retry-After"]).toBe("1");
    expect(looked).toHaveLength(0);
  });

  it("remembers the transaction by a keyed fingerprint, and keeps and logs neither it nor the portfolio", async () => {
    const id = landed(portfolio, { fee: 61_000n });
    const bystander = Keypair.generate();
    const answers = [
      await claim(api, member, portfolio, id),
      await claim(api, member, portfolio, id),
      await claim(api, member, bystander, landed(portfolio)),
      await claim(api, member, portfolio, transactionId()),
      await claim(api, member, portfolio, landed(portfolio, { succeeded: false })),
    ];
    expect(answers.map((answered) => answered.status)).toEqual([200, 409, 422, 422, 422]);

    const fingerprint = createHmac("sha256", FINGERPRINT_SECRET).update(id).digest("hex");
    expect(store.stored()).toContain(fingerprint);
    const everything = [store.stored(), JSON.stringify(logged), JSON.stringify(answers)].join();
    for (const secret of [
      id,
      ...looked,
      portfolio.publicKey.toBase58(),
      bystander.publicKey.toBase58(),
      CALLER.sessionId,
      CALLER.ip,
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(JSON.stringify(logged)).not.toContain(member.publicKey.toBase58());
    expect(logged.map((line) => (line.event === "refusal" ? line.reason : line.event))).toEqual([
      "already_claimed",
      "not_a_signer",
      "transaction_not_finalized",
      "transaction_failed",
    ]);
  });
});

describe("settling a week", () => {
  const closesAt = (week: number) => SEASON_START_MS + (week + 1) * WEEK_MS + DAY_MS;

  it("happens on the first request after its claims close, and hands the whole pot to a lone member", async () => {
    const api = rewards();
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    await join(api, member);
    await claim(api, member, portfolio, landed(portfolio));

    clock = closesAt(2) - 1;
    expect(read(await state(api, member)).points).toBe("0");
    clock = closesAt(2);
    expect(read(await state(api, member)).points).toBe("100000");
  });

  it("splits by score: 1.1 for the invited member, 0.2 of their fees for the inviter, never over the pot", async () => {
    const api = rewards();
    const { member: inviter, code } = await activeMember(api);
    const invited = Keypair.generate();
    const portfolio = Keypair.generate();
    await join(api, invited, { inviteCode: code });
    await claim(api, invited, portfolio, landed(portfolio, { fee: 1_000n }));

    // Both paid 1,000: the inviter scores 1,000 + 200, the invited member 1,100.
    expect(read(await state(api, inviter)).week.shareBps).toBe(5_217);
    clock = closesAt(2);
    const points = [read(await state(api, inviter)).points, read(await state(api, invited)).points];
    expect(points).toEqual(["52173", "47826"]);
  });

  it("hands out nothing for a week nobody traded in", async () => {
    const api = rewards();
    const member = Keypair.generate();
    await join(api, member);
    clock = closesAt(4);
    expect(read(await state(api, member)).points).toBe("0");
    expect(store.settlements).toEqual([0, 1, 2, 3, 4]);
  });

  it("settles a week once, and asks the database once a week and not once a request", async () => {
    const api = rewards();
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    await join(api, member);
    await claim(api, member, portfolio, landed(portfolio));
    const before = settleCalls;

    clock = closesAt(2);
    await state(api, member);
    await state(api, member);
    expect(read(await join(api, member)).points).toBe("100000");
    expect(settleCalls).toBe(before + 1);

    // Another process, which has not seen the week settled, asks again: nothing is handed out twice.
    expect(read(await state(rewards(), member)).points).toBe("100000");
    expect(store.settlements.filter((week) => week === 2)).toHaveLength(1);
  });

  it("stops at twelve weeks, however long after the season a request comes", async () => {
    const api = rewards();
    const member = Keypair.generate();
    await join(api, member);
    clock = SEASON_START_MS + 60 * WEEK_MS;
    await state(api, member);
    expect(store.settlements).toHaveLength(12);
  });
});

describe("outside the season", () => {
  it("has no running week before week 0 begins, and a member can already join", async () => {
    clock = SEASON_START_MS - 1_000;
    const answered = await join(rewards(), Keypair.generate());
    expect([answered.status, read(answered).week]).toEqual([200, null]);
  });

  it("has no running week once the last has ended, and still returns the settled points", async () => {
    const api = rewards();
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    await join(api, member);
    await claim(api, member, portfolio, landed(portfolio));

    clock = SEASON_START_MS + 12 * WEEK_MS - 1_000;
    expect(read(await state(api, member)).week.index).toBe(11);
    clock = SEASON_START_MS + 12 * WEEK_MS;
    expect(read(await state(api, member))).toMatchObject({ week: null, points: "100000" });
  });
});

import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChainTransaction } from "../../src/rewards/core/claim.js";
import { CLAIM_LIMITS, REWARDS_MAX_BODY_BYTES } from "../../src/rewards/core/rewards.js";
import {
  memoryRewardsStorage,
  REFERRAL_ACCOUNT,
  signed,
  trade,
  tradeOnTheWire,
  transactionId,
  WEEK_MS,
  type MemoryRewards,
} from "../support/rewards.js";
import { startApi, type Api, type Called } from "./support/harness.js";
import type { Received, Reply } from "./support/providers.js";

/**
 * The rewards routes over real HTTP. The database is the in-memory stand-in
 * behind the REST interface the application really calls, and the RPC
 * provider answers `getTransaction` with the trades a test has landed.
 */

const DATABASE_KEY = "the-database-key-only-this-server-holds";
const FINGERPRINT_SECRET = "a-fingerprint-secret-of-32-chars!";
/** The Monday two weeks before this one, so that the suite always runs in week 2. */
const FIRST_MONDAY_MS = 4 * 24 * 3_600_000;
const SEASON_START_MS = Date.now() - ((Date.now() - FIRST_MONDAY_MS) % WEEK_MS) - 2 * WEEK_MS;

const ENV = {
  REWARDS_DATABASE_SECRET_KEY: DATABASE_KEY,
  REWARDS_FINGERPRINT_SECRET: FINGERPRINT_SECRET,
  REWARDS_SEASON_START: new Date(SEASON_START_MS).toISOString(),
  REWARDS_REFERRAL_ACCOUNT: REFERRAL_ACCOUNT,
};

const now = () => Math.floor(Date.now() / 1_000);
const keyOf = (keypair: Keypair) => keypair.publicKey.toBase58();

/** The database's REST interface over the in-memory storage: one SQL function per path, amounts as text. */
function database(store: MemoryRewards) {
  return async (request: Received): Promise<Reply> => {
    const [, name] = /^\/rest\/v1\/rpc\/(\w+)$/.exec(request.path) ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = JSON.parse(request.body || "{}") as any;
    const value = <T>(stored: { value: T } | { failed: unknown }) =>
      "value" in stored ? stored.value : null;
    if (name === "rewards_join") {
      const joined = await store.storage.join({
        rewardsKey: args.p_rewards_key,
        code: args.p_code,
        inviteCode: args.p_invite_code,
        joinedWeek: args.p_joined_week,
        joinedDay: args.p_joined_day,
        dailyJoinCap: args.p_daily_join_cap,
      });
      return { body: JSON.stringify(value(joined)), headers: JSON_REPLY };
    }
    if (name === "rewards_state") {
      const member = value(await store.storage.state(args.p_rewards_key, args.p_week));
      const row = member && {
        code: member.code,
        code_active: member.codeActive,
        invited: member.invited,
        was_invited: member.wasInvited,
        joined_week: member.joinedWeek,
        points: member.points.toString(),
        week_fee_micro_usdc: member.weekFeeMicroUsdc.toString(),
        week_score: member.weekScore.toString(),
        week_total_score: member.weekTotalScore.toString(),
        week_traders: member.weekTraders,
      };
      return { body: JSON.stringify(row), headers: JSON_REPLY };
    }
    if (name === "rewards_credit") {
      const credited = await store.storage.credit({
        rewardsKey: args.p_rewards_key,
        fingerprint: args.p_fingerprint,
        week: args.p_week,
        feeMicroUsdc: BigInt(args.p_fee_micro_usdc),
      });
      return { body: JSON.stringify(value(credited)), headers: JSON_REPLY };
    }
    if (name === "rewards_week_traders") {
      const traders = value(await store.storage.traders(args.p_week));
      return { body: JSON.stringify(traders), headers: JSON_REPLY };
    }
    if (name === "rewards_settle") {
      await store.storage.settle(args.p_weeks, args.p_weekly_points);
      return { status: 204 };
    }
    return { status: 404, body: { message: "no such function" } };
  };
}
const JSON_REPLY = { "content-type": "application/json" };

describe("the rewards routes", () => {
  let api: Api;
  let store: MemoryRewards;
  let chain: Map<string, ChainTransaction>;

  /** The identity provider and the database share one address: the key endpoint goes on answering as it did. */
  const answerDatabase = (handler: (request: Received) => Reply | Promise<Reply>) =>
    api.providers.answer("supabase", (request) =>
      request.path.startsWith("/rest/")
        ? handler(request)
        : api.providers.defaults.supabase(request),
    );
  const databaseCalls = () =>
    api.providers.sentTo("supabase").filter((request) => request.path.startsWith("/rest/"));
  const chainReads = () =>
    api.providers
      .sentTo("rpc")
      .map((request) => JSON.parse(request.body) as { method: string; params: unknown[] })
      .filter((call) => call.method === "getTransaction");

  beforeAll(async () => {
    api = await startApi(ENV);
  });
  afterAll(() => api.close());
  beforeEach(() => {
    api.providers.reset();
    api.logged.length = 0;
    store = memoryRewardsStorage();
    chain = new Map();
    answerDatabase(database(store));
    api.providers.answer("rpc", (request) => {
      const call = JSON.parse(request.body) as { id: number; method: string; params: [string] };
      if (call.method !== "getTransaction") return api.providers.defaults.rpc(request);
      const found = chain.get(call.params[0]);
      const result = found ? tradeOnTheWire(call.params[0], found) : null;
      return { body: { jsonrpc: "2.0", id: call.id, result } };
    });
  });

  /** A join signed for the invite code it sends, unless `signedCode` says the member signed for another. */
  const join = (
    member: Keypair,
    extra: { inviteCode?: string; signedCode?: string; at?: unknown } = {},
  ) => {
    const at = extra.at ?? now();
    const signedCode = extra.signedCode ?? extra.inviteCode ?? "";
    return api.call("/v1/rewards/join", {
      body: {
        rewardsKey: keyOf(member),
        at,
        signature: signed(member, "join", keyOf(member), String(at), signedCode),
        ...(extra.inviteCode ? { inviteCode: extra.inviteCode } : {}),
      },
    });
  };
  const state = (member: Keypair, signer = member) => {
    const at = now();
    return api.call("/v1/rewards/state", {
      body: {
        rewardsKey: keyOf(member),
        at,
        signature: signed(signer, "state", keyOf(member), String(at)),
      },
    });
  };
  const claimBody = (member: Keypair, portfolio: Keypair, id: string, signer = portfolio) => ({
    rewardsKey: keyOf(member),
    transaction: id,
    portfolio: keyOf(portfolio),
    portfolioSignature: signed(signer, "claim", keyOf(member), id),
    rewardsSignature: signed(member, "claim", keyOf(member), id),
  });
  const claim = (member: Keypair, portfolio: Keypair, id: string, token?: string) =>
    api.call("/v1/rewards/claims", {
      body: claimBody(member, portfolio, id),
      ...(token ? { token } : {}),
    });
  /** A trade of `portfolio` the chain has finalized. Returns its id. */
  const landed = (portfolio: Keypair, options: Partial<Parameters<typeof trade>[0]> = {}) => {
    const id = transactionId();
    chain.set(id, trade({ portfolio: keyOf(portfolio), blockTime: now(), ...options }));
    return id;
  };
  /** Every refusal has the API's one shape, so a client may map it by status. */
  const refusal = (response: Called) => [
    response.status,
    response.json.code,
    Object.keys(response.json),
  ];

  it("GET /v1/rewards/config states the season in ISO 8601 and this week's traders, and asks the database for the count alone", async () => {
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    await join(member);
    await claim(member, portfolio, landed(portfolio));
    api.providers.received.length = 0;

    const token = await api.token();
    const response = await api.call("/v1/rewards/config", { token, ip: "203.0.113.9" });
    expect([response.status, response.json]).toEqual([
      200,
      {
        enabled: true,
        seasonStart: new Date(SEASON_START_MS).toISOString(),
        seasonWeeks: 12,
        weeklyPoints: 100_000,
        tradersThisWeek: 1,
      },
    ]);
    expect(api.providers.received.map((sent) => [sent.provider, sent.path, sent.body])).toEqual([
      ["supabase", "/rest/v1/rpc/rewards_week_traders", '{"p_week":2}'],
    ]);
    expect(JSON.stringify(api.providers.received)).not.toContain(token);

    // Answered again from this server's memory: the database is not asked twice in a minute.
    expect((await api.call("/v1/rewards/config")).json.tradersThisWeek).toBe(1);
    expect(api.providers.received).toHaveLength(1);
    expect((await state(member)).json.week.traders).toBe(1);
  });

  it("POST /v1/rewards/join makes a member, with the database key in both headers and nothing of the caller", async () => {
    const token = await api.token();
    const member = Keypair.generate();
    const at = now();
    const response = await api.call("/v1/rewards/join", {
      body: {
        rewardsKey: keyOf(member),
        at,
        signature: signed(member, "join", keyOf(member), String(at), ""),
      },
      token,
      ip: "203.0.113.9",
    });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      code: expect.stringMatching(/^[2-9A-HJ-NP-Z]{8}$/),
      codeActive: false,
      invited: 0,
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

    const calls = databaseCalls();
    // Whichever request is the process's first also settles the weeks already closed.
    const settle = "/rest/v1/rpc/rewards_settle";
    expect(calls.map((call) => call.path).filter((path) => path !== settle)).toEqual([
      "/rest/v1/rpc/rewards_join",
      "/rest/v1/rpc/rewards_state",
    ]);
    for (const call of calls) {
      expect([call.headers.apikey, call.headers.authorization]).toEqual([
        DATABASE_KEY,
        `Bearer ${DATABASE_KEY}`,
      ]);
    }
    const everything = JSON.stringify(calls);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("203.0.113.9");
  });

  it("takes `at` as a JSON number and nothing else", async () => {
    const asText = await join(Keypair.generate(), { at: String(now()) });
    expect(refusal(asText)).toEqual([400, "invalid_request", ["code", "error"]]);
    expect(databaseCalls()).toHaveLength(0);
  });

  it("answers a join 422 only for its invite code: a bad signature or a stale time is a 403", async () => {
    const member = Keypair.generate();
    const invite = await join(member, { inviteCode: "NOBODYS2" });
    expect(refusal(invite)).toEqual([422, "invite_code_invalid", ["code", "error"]]);
    expect(store.members.size).toBe(0);

    const stale = await join(member, { inviteCode: "NOBODYS2", at: now() - 301 });
    expect(refusal(stale)).toEqual([403, "clock_skew", ["code", "error"]]);
    const unsigned = await api.call("/v1/rewards/join", {
      body: {
        rewardsKey: keyOf(member),
        at: now(),
        signature: signed(Keypair.generate(), "join", keyOf(member), String(now()), "NOBODYS2"),
        inviteCode: "NOBODYS2",
      },
    });
    expect(refusal(unsigned)).toEqual([403, "signature_invalid", ["code", "error"]]);
  });

  it("ties a new member to the inviter whose code they signed for, and refuses a join whose code is not the signed one", async () => {
    const inviter = Keypair.generate();
    const portfolio = Keypair.generate();
    const { code } = (await join(inviter)).json;
    await claim(inviter, portfolio, landed(portfolio));

    const swapped = await join(Keypair.generate(), { inviteCode: code, signedCode: "" });
    expect(refusal(swapped)).toEqual([403, "signature_invalid", ["code", "error"]]);
    expect((await state(inviter)).json.invited).toBe(0);

    const invited = await join(Keypair.generate(), { inviteCode: code });
    expect([invited.status, invited.json.wasInvited, invited.json.boostWeeksLeft]).toEqual([
      200,
      true,
      8,
    ]);
    expect((await state(inviter)).json.invited).toBe(1);
  });

  it("POST /v1/rewards/state answers 404 for a key that has not joined, and 403 for a signature not the key's", async () => {
    const member = Keypair.generate();
    expect(refusal(await state(member))).toEqual([404, "not_a_member", ["code", "error"]]);
    await join(member);
    expect((await state(member)).status).toBe(200);
    expect(refusal(await state(member, Keypair.generate()))).toEqual([
      403,
      "signature_invalid",
      ["code", "error"],
    ]);
  });

  it("POST /v1/rewards/claims credits the fee the chain shows, and sends the provider the transaction's id alone", async () => {
    const token = await api.token();
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    await join(member);
    const id = landed(portfolio, { feeMicroUsdc: 61_000n });

    const response = await claim(member, portfolio, id, token);
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      credited: true,
      feeMicroUsdc: "61000",
      state: { codeActive: true, points: "0", week: { feeMicroUsdc: "61000", shareBps: 10_000 } },
    });

    expect(chainReads()).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [
          id,
          { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
        ],
      },
    ]);
    const upstream = JSON.stringify(
      api.providers.received.filter((sent) => sent.provider === "rpc"),
    );
    for (const secret of [keyOf(portfolio), keyOf(member), token]) {
      expect(upstream).not.toContain(secret);
    }
  });

  it("answers a transaction the chain has not finalized as 422 transaction_not_finalized, and credits it once it is", async () => {
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    await join(member);
    const id = transactionId();
    expect(refusal(await claim(member, portfolio, id))).toEqual([
      422,
      "transaction_not_finalized",
      ["code", "error"],
    ]);
    chain.set(id, trade({ portfolio: keyOf(portfolio), blockTime: now() }));
    expect((await claim(member, portfolio, id)).status).toBe(200);
  });

  it("refuses each claim that fails a check under its own 422 code, and credits nothing", async () => {
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    const bystander = Keypair.generate();
    await join(member);
    const refusals: [id: string, by: Keypair, code: string][] = [
      [landed(portfolio, { succeeded: false }), portfolio, "transaction_failed"],
      [landed(portfolio), bystander, "not_a_signer"],
      [landed(portfolio, { feeMicroUsdc: 0n }), portfolio, "no_referral_fee"],
      [
        landed(portfolio, { blockTime: SEASON_START_MS / 1_000 - 60 }),
        portfolio,
        "outside_claim_window",
      ],
    ];
    for (const [id, by, code] of refusals) {
      expect(refusal(await claim(member, by, id)), code).toEqual([422, code, ["code", "error"]]);
    }
    expect((await state(member)).json).toMatchObject({
      codeActive: false,
      week: { feeMicroUsdc: "0" },
    });
  });

  it("answers a second claim of one transaction 409, a key that has not joined 404, and a claim the portfolio did not sign 403", async () => {
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    await join(member);
    const id = landed(portfolio);
    expect((await claim(member, portfolio, id)).status).toBe(200);
    expect(refusal(await claim(member, portfolio, id))).toEqual([
      409,
      "already_claimed",
      ["code", "error"],
    ]);

    const stranger = Keypair.generate();
    expect(refusal(await claim(stranger, portfolio, landed(portfolio)))).toEqual([
      404,
      "not_a_member",
      ["code", "error"],
    ]);

    const forged = await api.call("/v1/rewards/claims", {
      body: claimBody(member, portfolio, landed(portfolio), Keypair.generate()),
    });
    expect(refusal(forged)).toEqual([403, "signature_invalid", ["code", "error"]]);
  });

  it("requires a session, and reads no body longer than a claim", async () => {
    const member = Keypair.generate();
    const noSession = await api.call("/v1/rewards/state", {
      body: { rewardsKey: keyOf(member), at: now(), signature: "1".repeat(64) },
      token: null,
    });
    expect([noSession.status, noSession.json.code]).toEqual([401, "unauthorized"]);

    const tooLarge = await api.call("/v1/rewards/join", {
      body: { rewardsKey: keyOf(member), at: now(), signature: "1".repeat(REWARDS_MAX_BODY_BYTES) },
    });
    expect([tooLarge.status, tooLarge.json.code]).toEqual([413, "request_too_large"]);
    expect(databaseCalls()).toHaveLength(0);
  });

  it("rations claims per session, and reads the chain for none past the limit", async () => {
    const token = await api.token();
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    await join(member);
    for (let i = 0; i < CLAIM_LIMITS.perSession; i += 1) {
      expect((await claim(member, portfolio, transactionId(), token)).status).toBe(422);
    }
    const reads = chainReads().length;
    const refused = await claim(member, portfolio, transactionId(), token);
    expect([refused.status, refused.json.code]).toEqual([429, "rate_limited"]);
    expect(chainReads()).toHaveLength(reads);
  });

  it("passes on none of the database's own words, and answers its failure as a 502", async () => {
    answerDatabase(() => ({
      status: 500,
      headers: JSON_REPLY,
      body: JSON.stringify({ message: "relation rewards_members does not exist" }),
    }));
    const response = await join(Keypair.generate());
    expect([response.status, response.json.code]).toEqual([502, "upstream_failed"]);
    expect(response.text).not.toContain("rewards_members");
  });

  it("stores and logs nothing of the portfolio or the transaction, and logs nothing of the member or the keys it holds", async () => {
    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    const { code } = (await join(member)).json;
    const id = landed(portfolio);
    const failed = landed(portfolio, { succeeded: false });
    await claim(member, portfolio, id);
    await claim(member, portfolio, id);
    await claim(member, portfolio, failed);
    await state(member);

    expect(api.logged.filter((line) => line.event === "request")).toHaveLength(5);
    const logged = JSON.stringify(api.logged);
    const kept = store.stored();
    for (const secret of [keyOf(portfolio), id, failed]) {
      expect(logged).not.toContain(secret);
      expect(kept).not.toContain(secret);
    }
    for (const secret of [keyOf(member), code, DATABASE_KEY, FINGERPRINT_SECRET]) {
      expect(logged).not.toContain(secret);
    }
    expect(kept).toContain(keyOf(member));
  });
});

describe("a deployment that takes one new member a day", () => {
  let api: Api;

  beforeAll(async () => {
    api = await startApi({ ...ENV, REWARDS_DAILY_JOIN_CAP: "1" });
    const store = memoryRewardsStorage();
    api.providers.answer("supabase", (request) =>
      request.path.startsWith("/rest/")
        ? database(store)(request)
        : api.providers.defaults.supabase(request),
    );
  });
  afterAll(() => api.close());

  it("answers a second new key 429 rate_limited, and the first key's next join 200", async () => {
    const join = (member: Keypair) => {
      const at = now();
      const signature = signed(member, "join", keyOf(member), String(at), "");
      return api.call("/v1/rewards/join", { body: { rewardsKey: keyOf(member), at, signature } });
    };
    const first = Keypair.generate();
    expect((await join(first)).status).toBe(200);
    const second = await join(Keypair.generate());
    expect([second.status, second.json]).toEqual([
      429,
      { code: "rate_limited", error: "Too many requests. Wait and try again." },
    ]);
    expect((await join(first)).status).toBe(200);
  });
});

describe("a deployment whose database is down", () => {
  let api: Api;

  beforeAll(async () => {
    api = await startApi(ENV);
    api.providers.answer("supabase", (request) =>
      request.path.startsWith("/rest/")
        ? { status: 503, body: "upstream connect error" }
        : api.providers.defaults.supabase(request),
    );
  });
  afterAll(() => api.close());

  it("still says rewards are on, with no count of traders, and passes on none of the database's words", async () => {
    const response = await api.call("/v1/rewards/config");
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ enabled: true, weeklyPoints: 100_000 });
    expect(response.json.tradersThisWeek).toBeNull();
    expect(response.text).not.toContain("upstream connect error");
  });
});

describe("a deployment with no rewards configuration", () => {
  let api: Api;

  beforeAll(async () => {
    const { REWARDS_FINGERPRINT_SECRET: _unset, ...partial } = ENV;
    api = await startApi(partial);
  });
  afterAll(() => api.close());

  it("says rewards are off with every field null, and answers 404 on every other rewards route", async () => {
    const config = await api.call("/v1/rewards/config");
    expect([config.status, config.json]).toEqual([
      200,
      {
        enabled: false,
        seasonStart: null,
        seasonWeeks: null,
        weeklyPoints: null,
        tradersThisWeek: null,
      },
    ]);

    const member = Keypair.generate();
    const portfolio = Keypair.generate();
    const at = now();
    const signature = signed(member, "join", keyOf(member), String(at), "");
    const id = transactionId();
    const routes: [path: string, body: unknown][] = [
      ["/v1/rewards/join", { rewardsKey: keyOf(member), at, signature }],
      ["/v1/rewards/state", { rewardsKey: keyOf(member), at, signature }],
      [
        "/v1/rewards/claims",
        {
          rewardsKey: keyOf(member),
          transaction: id,
          portfolio: keyOf(portfolio),
          portfolioSignature: signed(portfolio, "claim", keyOf(member), id),
          rewardsSignature: signed(member, "claim", keyOf(member), id),
        },
      ],
    ];
    for (const [path, body] of routes) {
      const response = await api.call(path, { body });
      expect([response.status, response.json.code], path).toEqual([404, "not_found"]);
    }
    expect(api.providers.received).toHaveLength(0);
  });
});

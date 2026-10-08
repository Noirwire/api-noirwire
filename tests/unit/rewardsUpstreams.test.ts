import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { LogLine } from "../../src/common/core/log.js";
import { createRelay } from "../../src/common/core/relay.js";
import { createRewardsDatabase } from "../../src/rewards/core/database.js";
import { createTransactions } from "../../src/rewards/core/transactions.js";
import { trade, tradeOnTheWire, transactionId } from "../support/rewards.js";

/**
 * The two things the rewards routes ask: the database, over its REST
 * interface, and the RPC provider, for one finalized transaction. Each with
 * a stand-in for `fetch`.
 */

const DATABASE_URL = "https://project.supabase.co";
const RPC_URL = "https://rpc.example/key";
const SECRET_KEY = "the-database-key-only-this-server-holds";

type Sent = { url: string; headers: Record<string, string>; body: unknown };

function setup(reply: () => Response) {
  const sent: Sent[] = [];
  const logged: LogLine[] = [];
  const log = (line: LogLine) => void logged.push(line);
  const relay = createRelay({
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        headers: Object.fromEntries(new Headers(init.headers)),
        body: JSON.parse(init.body as string),
      });
      return reply();
    }) as unknown as typeof fetch,
    log,
  });
  return {
    sent,
    logged,
    database: createRewardsDatabase({ url: DATABASE_URL, secretKey: SECRET_KEY, relay, log }),
    transactions: createTransactions({ rpcUrl: RPC_URL, relay, log }),
  };
}

const code = (stored: object) =>
  "failed" in stored ? JSON.parse((stored.failed as { body: string }).body).code : null;

describe("the rewards database", () => {
  const rewardsKey = Keypair.generate().publicKey.toBase58();

  it("calls one SQL function by name, with the secret key in both headers and nothing else of anyone", async () => {
    const { database, sent } = setup(() => Response.json("joined"));
    const joined = await database.join({
      rewardsKey,
      code: "K7M2QX9R",
      inviteCode: null,
      joinedWeek: 3,
      joinedDay: 20_400,
      dailyJoinCap: 2_000,
    });
    expect(joined).toEqual({ value: "joined" });
    expect(sent).toEqual([
      {
        url: `${DATABASE_URL}/rest/v1/rpc/rewards_join`,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 (compatible; NoirWire)",
          apikey: SECRET_KEY,
          authorization: `Bearer ${SECRET_KEY}`,
        },
        body: {
          p_rewards_key: rewardsKey,
          p_code: "K7M2QX9R",
          p_invite_code: null,
          p_joined_week: 3,
          p_joined_day: 20_400,
          p_daily_join_cap: 2_000,
        },
      },
    ]);
  });

  it("sends a fee as digits, and the fingerprint in place of the transaction", async () => {
    const { database, sent } = setup(() => Response.json("credited"));
    await database.credit({
      rewardsKey,
      fingerprint: "ab12",
      week: 2,
      feeMicroUsdc: 9_007_199_254_740_993n,
    });
    expect(sent[0].url).toBe(`${DATABASE_URL}/rest/v1/rpc/rewards_credit`);
    expect(sent[0].body).toEqual({
      p_rewards_key: rewardsKey,
      p_fingerprint: "ab12",
      p_week: 2,
      p_fee_micro_usdc: "9007199254740993",
    });
  });

  it("reads a member's amounts without losing a digit, and a key that has not joined as null", async () => {
    const row = {
      code: "K7M2QX9R",
      code_active: true,
      invited: 2,
      was_invited: false,
      joined_week: -1,
      points: "52173",
      week_fee_micro_usdc: "9007199254740993",
      week_score: "12000",
      week_total_score: "23000",
      week_traders: 48,
    };
    const found = await setup(() => Response.json(row)).database.state(rewardsKey, 2);
    expect(found).toEqual({
      value: {
        code: "K7M2QX9R",
        codeActive: true,
        invited: 2,
        wasInvited: false,
        joinedWeek: -1,
        points: 52_173n,
        weekFeeMicroUsdc: 9_007_199_254_740_993n,
        weekScore: 12_000n,
        weekTotalScore: 23_000n,
        weekTraders: 48,
      },
    });
    const none = await setup(() => Response.json(null)).database.state(rewardsKey, 2);
    expect(none).toEqual({ value: null });
  });

  it("takes a settlement that answers with no body", async () => {
    const { database, sent } = setup(() => new Response(null, { status: 204 }));
    expect(await database.settle(3, 100_000)).toEqual({ value: null });
    expect(sent[0].body).toEqual({ p_weeks: 3, p_weekly_points: 100_000 });
  });

  it("answers the database's own error as a 502, and an answer of another shape too", async () => {
    const refused = setup(() =>
      Response.json(
        { code: "42883", message: "function rewards_join does not exist" },
        { status: 404 },
      ),
    );
    const joined = await refused.database.join({
      rewardsKey,
      code: "K7M2QX9R",
      inviteCode: null,
      joinedWeek: 0,
      joinedDay: 0,
      dailyJoinCap: 1,
    });
    expect(code(joined)).toBe("upstream_failed");
    expect(JSON.stringify([joined, refused.logged])).not.toContain("rewards_join");

    const odd = await setup(() => Response.json("something-else")).database.credit({
      rewardsKey,
      fingerprint: "ab12",
      week: 0,
      feeMicroUsdc: 1n,
    });
    expect(code(odd)).toBe("upstream_failed");
  });

  it("reports a refused secret key as the operator's to fix, and logs neither the key nor the member", async () => {
    const { database, logged } = setup(() => new Response(null, { status: 401 }));
    expect(code(await database.state(rewardsKey, 0))).toBe("upstream_refused");
    expect(logged.map((line) => line.event)).toEqual(["operator_error"]);
    expect(JSON.stringify(logged)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(logged)).not.toContain(rewardsKey);
  });
});

describe("a claimed transaction", () => {
  const id = transactionId();
  const portfolio = Keypair.generate().publicKey.toBase58();
  const genuine = trade({ portfolio, blockTime: 1_790_000_000, feeMicroUsdc: 61_000n });
  const answered = (result: unknown) => () => Response.json({ jsonrpc: "2.0", id: 1, result });

  it("is asked for by its id alone, at finalized", async () => {
    const { transactions, sent } = setup(answered(tradeOnTheWire(id, genuine)));
    await transactions.finalized(id);
    expect(sent).toEqual([
      {
        url: RPC_URL,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 (compatible; NoirWire)",
        },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [
            id,
            { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
          ],
        },
      },
    ]);
  });

  it("is read as the chain recorded it: its signers, its block time, its token balances", async () => {
    const { transactions } = setup(answered(tradeOnTheWire(id, genuine)));
    expect(await transactions.finalized(id)).toEqual({ transaction: genuine });
  });

  it("is read as failed when the chain recorded an error", async () => {
    const failed = trade({ portfolio, blockTime: 1_790_000_000, succeeded: false });
    const { transactions } = setup(answered(tradeOnTheWire(id, failed)));
    expect(await transactions.finalized(id)).toMatchObject({ transaction: { succeeded: false } });
  });

  it("is not there when the chain has none under that id", async () => {
    expect(await setup(answered(null)).transactions.finalized(id)).toEqual({ transaction: null });
  });

  it("is not there under any signature but its first, so one trade is one claim", async () => {
    const wire = tradeOnTheWire(id, genuine);
    const second = wire.transaction.signatures[1];
    const { transactions } = setup(answered(wire));
    expect(await transactions.finalized(second)).toEqual({ transaction: null });
  });

  it("answers the provider's own error, and an answer that is no transaction, as a 502", async () => {
    const refused = setup(() =>
      Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: `Invalid ${id}` } }),
    );
    const looked = await refused.transactions.finalized(id);
    expect(code(looked)).toBe("upstream_failed");
    expect(JSON.stringify([looked, refused.logged])).not.toContain(id);

    const odd = await setup(answered({ meta: "not a transaction" })).transactions.finalized(id);
    expect(code(odd)).toBe("upstream_failed");
  });
});

import { Keypair } from "@solana/web3.js";
import { base58 } from "../../src/chain/core/bytes.js";
import { usdcMint } from "../../src/chain/core/network.js";
import { signerOf } from "../../src/chain/core/signatures.js";
import type { ChainTransaction } from "../../src/rewards/core/claim.js";
import { rewardsMessage, type RewardsAction } from "../../src/rewards/core/messages.js";
import { INVITED_BONUS_WEEKS } from "../../src/rewards/core/points.js";
import type { MemberState, RewardsStorage } from "../../src/rewards/core/storage.js";

/**
 * What the rewards tests share: made-up keys, a trade in the shape the RPC
 * reports one, and a stand-in for the database that keeps everything in
 * memory.
 *
 * The stand-in scores and settles by the two functions below, which say in
 * TypeScript what `rewards_scores` and `rewards_settle` say in SQL. The
 * real rules are the SQL ones; `tests/integration/rewardsSql.test.ts` runs
 * both over the same members and fees and fails when they differ, so a
 * suite that passes against the stand-in is not passing against rules of
 * its own.
 */

export type Scorer = {
  rewardsKey: string;
  /** The member whose code this one joined with, or null. */
  invitedBy: string | null;
  /** The week the member joined in, counted from the season start. */
  joinedWeek: number;
};

/**
 * Every member's score for `week`, in tenths of a micro-USDC: their own
 * fees, times 1.1 while they are an invited member in their first weeks,
 * plus 0.2 of the fees of the members they invited. A trade from a week
 * before its member joined counts once and earns the inviter nothing.
 */
export function weeklyScores(
  week: number,
  members: readonly Scorer[],
  fees: ReadonlyMap<string, bigint>,
): Map<string, bigint> {
  const scores = new Map<string, bigint>();
  const add = (rewardsKey: string, tenths: bigint) =>
    scores.set(rewardsKey, (scores.get(rewardsKey) ?? 0n) + tenths);
  for (const member of members) {
    const fee = fees.get(member.rewardsKey) ?? 0n;
    if (fee === 0n) continue;
    const invited = member.invitedBy !== null && week >= member.joinedWeek;
    const boosted = invited && week - member.joinedWeek < INVITED_BONUS_WEEKS;
    add(member.rewardsKey, fee * (boosted ? 11n : 10n));
    if (invited && member.invitedBy !== null) add(member.invitedBy, fee * 2n);
  }
  return scores;
}

/** `pot` split by score, each share rounded down. A week with no score hands out nothing. */
export function splitPoints(scores: ReadonlyMap<string, bigint>, pot: bigint): Map<string, bigint> {
  let total = 0n;
  for (const score of scores.values()) total += score;
  const points = new Map<string, bigint>();
  if (total === 0n) return points;
  for (const [rewardsKey, score] of scores) points.set(rewardsKey, (pot * score) / total);
  return points;
}

/** A Monday, 00:00 UTC. */
export const SEASON_START_MS = Date.UTC(2026, 9, 19);
export const DAY_MS = 24 * 3_600_000;
export const WEEK_MS = 7 * DAY_MS;

/** The mint the application itself reads fees in when it runs on devnet, as the integration suite runs it. */
export const USDC_MINT = usdcMint("devnet");
export const REFERRAL_ACCOUNT = Keypair.generate().publicKey.toBase58();

/** `action`'s message for `rewardsKey`, signed by `signer`, in base58. A join's is about the time and the invite code. */
export function signed(
  signer: Keypair,
  action: RewardsAction,
  rewardsKey: string,
  ...about: string[]
): string {
  return base58(signerOf(signer.secretKey)(rewardsMessage(action, rewardsKey, ...about)));
}

/** A transaction id nobody has seen before. */
export const transactionId = () => base58(Keypair.generate().secretKey);

export type Trade = {
  portfolio: string;
  feeMicroUsdc?: bigint;
  /** Unix seconds. */
  blockTime: number;
  succeeded?: boolean;
};

/**
 * A relayed trade as the chain records it: the relayer's key and the
 * portfolio sign, and the referral account's USDC token account, third
 * among the accounts, holds the fee more after it than before.
 */
export function trade(options: Trade): ChainTransaction {
  const before = 1_250_000n;
  const referral = { accountIndex: 2, mint: USDC_MINT, owner: REFERRAL_ACCOUNT };
  const trader = { accountIndex: 3, mint: USDC_MINT, owner: options.portfolio };
  const fee = options.feeMicroUsdc ?? 61_000n;
  return {
    succeeded: options.succeeded ?? true,
    blockTime: options.blockTime,
    signers: [Keypair.generate().publicKey.toBase58(), options.portfolio],
    preTokenBalances: [
      { ...referral, amount: before },
      { ...trader, amount: 500_000_000n },
    ],
    postTokenBalances: [
      { ...referral, amount: before + fee },
      { ...trader, amount: 400_000_000n },
    ],
  };
}

/** The same trade as `getTransaction` answers it with `jsonParsed`, under `id`. */
export function tradeOnTheWire(id: string, transaction: ChainTransaction) {
  const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const balances = (entries: ChainTransaction["preTokenBalances"]) =>
    entries.map((entry) => ({
      accountIndex: entry.accountIndex,
      mint: entry.mint,
      owner: entry.owner,
      programId: TOKEN_PROGRAM,
      uiTokenAmount: {
        amount: entry.amount.toString(),
        decimals: 6,
        uiAmount: Number(entry.amount) / 1e6,
        uiAmountString: (Number(entry.amount) / 1e6).toString(),
      },
    }));
  const others = [0, 1].map(() => Keypair.generate().publicKey.toBase58());
  return {
    blockTime: transaction.blockTime,
    slot: 1,
    version: 0,
    meta: {
      err: transaction.succeeded ? null : { InstructionError: [2, { Custom: 6001 }] },
      fee: 5_000,
      preTokenBalances: balances(transaction.preTokenBalances),
      postTokenBalances: balances(transaction.postTokenBalances),
      logMessages: [],
    },
    transaction: {
      signatures: [id, transactionId()],
      message: {
        accountKeys: [
          ...transaction.signers.map((pubkey) => ({
            pubkey,
            signer: true,
            writable: true,
            source: "transaction",
          })),
          ...others.map((pubkey) => ({
            pubkey,
            signer: false,
            writable: true,
            source: "transaction",
          })),
        ],
        instructions: [],
      },
    },
  };
}

type Member = Scorer & { code: string; joinedDay: number };

/** The database, in memory. `stored()` is every value it holds, to look through for what must not be there. */
export function memoryRewardsStorage() {
  const members = new Map<string, Member>();
  const fees = new Map<number, Map<string, bigint>>();
  const fingerprints = new Set<string>();
  const points = new Map<number, Map<string, bigint>>();
  const settlements: number[] = [];

  const feesOf = (week: number | null) =>
    (week === null ? undefined : fees.get(week)) ?? new Map<string, bigint>();
  const active = (rewardsKey: string) => [...fees.values()].some((week) => week.has(rewardsKey));

  const storage: RewardsStorage = {
    join({ rewardsKey, code, inviteCode, joinedWeek, joinedDay, dailyJoinCap }) {
      if (members.has(rewardsKey)) return Promise.resolve({ value: "member" });
      const all = [...members.values()];
      if (all.filter((member) => member.joinedDay === joinedDay).length >= dailyJoinCap) {
        return Promise.resolve({ value: "cap_reached" });
      }
      const inviter = all.find((member) => member.code === inviteCode);
      if (inviteCode !== null && (!inviter || !active(inviter.rewardsKey))) {
        return Promise.resolve({ value: "invite_invalid" });
      }
      if (all.some((member) => member.code === code)) {
        return Promise.resolve({ value: "code_taken" });
      }
      members.set(rewardsKey, {
        rewardsKey,
        code,
        invitedBy: inviter?.rewardsKey ?? null,
        joinedWeek,
        joinedDay,
      });
      return Promise.resolve({ value: "joined" });
    },

    state(rewardsKey, week) {
      const member = members.get(rewardsKey);
      if (!member) return Promise.resolve({ value: null });
      const scores =
        week === null
          ? new Map<string, bigint>()
          : weeklyScores(week, [...members.values()], feesOf(week));
      const state: MemberState = {
        code: member.code,
        codeActive: active(rewardsKey),
        invited: [...members.values()].filter((other) => other.invitedBy === rewardsKey).length,
        wasInvited: member.invitedBy !== null,
        points: [...points.values()].reduce((sum, week) => sum + (week.get(rewardsKey) ?? 0n), 0n),
        weekFeeMicroUsdc: feesOf(week).get(rewardsKey) ?? 0n,
        weekScore: scores.get(rewardsKey) ?? 0n,
        weekTotalScore: [...scores.values()].reduce((sum, score) => sum + score, 0n),
      };
      return Promise.resolve({ value: state });
    },

    credit({ rewardsKey, fingerprint, week, feeMicroUsdc }) {
      if (!members.has(rewardsKey)) return Promise.resolve({ value: "not_member" });
      if (points.has(week)) return Promise.resolve({ value: "settled" });
      if (fingerprints.has(fingerprint)) return Promise.resolve({ value: "duplicate" });
      fingerprints.add(fingerprint);
      const ofWeek = feesOf(week);
      ofWeek.set(rewardsKey, (ofWeek.get(rewardsKey) ?? 0n) + feeMicroUsdc);
      fees.set(week, ofWeek);
      return Promise.resolve({ value: "credited" });
    },

    settle(weeks, weeklyPoints) {
      for (let week = 0; week < weeks; week += 1) {
        if (points.has(week)) continue;
        settlements.push(week);
        const scores = weeklyScores(week, [...members.values()], feesOf(week));
        points.set(week, splitPoints(scores, BigInt(weeklyPoints)));
      }
      return Promise.resolve({ value: null });
    },
  };

  return {
    storage,
    members,
    /** The weeks settled, in the order they were. */
    settlements,
    stored: () =>
      JSON.stringify({
        members: [...members.values()],
        fees: [...fees].map(([week, ofWeek]) => [week, [...ofWeek].map(String)]),
        fingerprints: [...fingerprints],
        points: [...points].map(([week, ofWeek]) => [week, [...ofWeek].map(String)]),
      }),
  };
}

export type MemoryRewards = ReturnType<typeof memoryRewardsStorage>;

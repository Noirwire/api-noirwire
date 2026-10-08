import { createHmac, randomInt } from "node:crypto";
import { z } from "zod";
import { isAddress } from "../../chain/core/network.js";
import {
  answer,
  busyRefusal,
  refusal,
  type Answer,
  type ErrorCode,
} from "../../common/core/answer.js";
import type { Log } from "../../common/core/log.js";
import { PROVIDER_RETRY_AFTER_SECONDS } from "../../common/core/providerGate.js";
import type { Caller, RouteLimits } from "../../common/core/quota.js";
import { readClaim } from "./claim.js";
import { REWARDS_ROUTE } from "./database.js";
import { rewardsMessage, signatureVerifies, timely } from "./messages.js";
import { shareBps, WEEKLY_POINTS } from "./points.js";
import type { MemberState, RewardsStorage } from "./storage.js";
import type { Transactions } from "./transactions.js";
import { closedWeeks, SEASON_WEEKS, seasonWeekAt, weekAt, weekEndsAt } from "./weeks.js";

/**
 * Points for trades, for a wallet that asks for them. A wallet that never
 * joins sends nothing here.
 *
 * A member is a rewards key: a key the wallet derives for this alone, which
 * is not a Solana account and holds nothing. It is never the profile key,
 * the funding wallet's or a portfolio's. What is kept under it is a
 * referral code, who invited it, a fee total per week and points
 * (storage.ts).
 *
 * A claim is the one request that names a portfolio and a transaction next
 * to a rewards key. Both are used to check the claim and then dropped: what
 * is kept of the transaction is a keyed fingerprint, and of the portfolio
 * nothing. Neither is logged or put in an error.
 *
 * Nothing a caller says decides what a trade is worth. The transaction is
 * read from this server's own RPC provider once the chain has finalized it,
 * and the fee is what NoirWire's referral account received in it (claim.ts).
 */

/** The largest request is a claim: three keys' worth of base58 and two signatures. */
export const REWARDS_MAX_BODY_BYTES = 1_024;
/** A wallet reads its state when the screen opens and after a trade. */
export const REWARDS_LIMITS: RouteLimits = { perSession: 30, perIp: 300, total: 600 };
/**
 * A claim costs this server a read of the chain, so claims are counted on
 * their own and lower. A wallet claims a trade once, and asks again a few
 * times while the chain finalizes it.
 */
export const CLAIM_ROUTE = "rewards-claim";
export const CLAIM_LIMITS: RouteLimits = { perSession: 12, perIp: 120, total: 240 };

/** No 0 or 1, no I or O: a code read aloud or copied by hand has one spelling. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 8;
const DAY_MS = 24 * 3_600_000;
/** How long one count of the week's traders is answered with. */
export const TRADERS_TTL_MS = 60_000;
/** How many codes are tried for a new member before giving up: two members drawing one code is already a rare thing. */
const CODE_ATTEMPTS = 3;

function randomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

const key = z.string().refine(isAddress);
const signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
/** Unix seconds, as a JSON number. What is signed is its decimal form. */
const at = z.number().int().positive().max(9_999_999_999);

const stateRequest = z.strictObject({ rewardsKey: key, at, signature });
const joinRequest = z.strictObject({
  rewardsKey: key,
  at,
  signature,
  inviteCode: z.string().min(1).max(32).optional(),
});
const claimRequest = z.strictObject({
  rewardsKey: key,
  transaction: signature,
  portfolio: key,
  portfolioSignature: signature,
  rewardsSignature: signature,
});

/** The request in `body` when it is exactly what `schema` describes, or null. */
function requested<T>(schema: z.ZodType<T>, body: string): T | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const request = schema.safeParse(json);
  return request.success ? request.data : null;
}

/** The season, where it is kept, and how a trade is read from the chain. */
export type RewardsUpstream = {
  storage: RewardsStorage;
  transactions: Transactions;
  /** Waits for this server's turn at its RPC provider, in the line of the session asking. False when it would wait too long. */
  rpcAllowance: (sessionId: string) => Promise<boolean>;
  seasonStartMs: number;
  /** The most new members one UTC day may have, whoever asks. A member who joins again is not counted. */
  dailyJoinCap: number;
  referralAccount: string;
  usdcMint: string;
  fingerprintSecret: string;
};

export type RewardsDeps = {
  /** Null when this deployment hands out no points. */
  upstream: RewardsUpstream | null;
  log: Log;
  now?: () => number;
  newCode?: () => string;
};

export type Rewards = {
  /** Whether points are handed out here, the season's shape, and how many members traded this week. */
  config(): Promise<Answer>;
  join(body: string): Promise<Answer>;
  state(body: string): Promise<Answer>;
  claim(body: string, caller: Caller): Promise<Answer>;
};

export function createRewards(deps: RewardsDeps): Rewards {
  const { upstream, log } = deps;
  const now = deps.now ?? Date.now;
  const newCode = deps.newCode ?? randomCode;

  const invalid = () => refusal("invalid_request");
  /** Every route but `config` when there is nothing configured: as if it were not there. */
  const absent = () => refusal("not_found");

  /** A fixed word for the operator, and one of this API's errors for the caller. */
  function failed(code: ErrorCode, reason: string = code): Answer {
    const answered = refusal(code);
    log({ event: "refusal", route: REWARDS_ROUTE, status: answered.status, reason });
    return answered;
  }

  /** How many weeks this process has seen settled, so the database is asked once a week and not once a request. */
  let weeksSettled = 0;

  /**
   * Settles every week whose claims have closed, on the first request that
   * comes after. The database does it in one call and at most once per
   * week, whoever asks and however many ask at once.
   */
  async function settleDue({ storage, seasonStartMs }: RewardsUpstream): Promise<Answer | null> {
    const due = closedWeeks(seasonStartMs, now());
    if (due <= weeksSettled) return null;
    const settled = await storage.settle(due, WEEKLY_POINTS);
    if ("failed" in settled) return settled.failed;
    weeksSettled = Math.max(weeksSettled, due);
    return null;
  }

  /** A member as the wallet shows one. Outside the season there is no running week, and the points stand. */
  function shown(member: MemberState, week: number | null, seasonStartMs: number) {
    return {
      code: member.code,
      codeActive: member.codeActive,
      invited: member.invited,
      wasInvited: member.wasInvited,
      points: member.points.toString(),
      week:
        week === null
          ? null
          : {
              index: week,
              endsAt: new Date(weekEndsAt(seasonStartMs, week)).toISOString(),
              feeMicroUsdc: member.weekFeeMicroUsdc.toString(),
              shareBps: shareBps(member.weekScore, member.weekTotalScore),
              traders: member.weekTraders,
            },
    };
  }

  /** A member's state as the wallet shows it, null when the key has not joined, or the error to answer with. */
  async function stateOf(
    { storage, seasonStartMs }: RewardsUpstream,
    rewardsKey: string,
  ): Promise<{ state: ReturnType<typeof shown> | null } | { failed: Answer }> {
    const week = seasonWeekAt(seasonStartMs, now());
    const read = await storage.state(rewardsKey, week);
    if ("failed" in read) return read;
    return { state: read.value && shown(read.value, week, seasonStartMs) };
  }

  /** Why a join or a state request is not its key's own and of this moment, or null when it is. */
  function unsigned(
    action: "join" | "state",
    request: { rewardsKey: string; at: number; signature: string },
    ...also: string[]
  ): Answer | null {
    if (!timely(request.at, now())) return failed("clock_skew");
    const message = rewardsMessage(action, request.rewardsKey, String(request.at), ...also);
    return signatureVerifies(request.rewardsKey, message, request.signature)
      ? null
      : failed("signature_invalid");
  }

  /** The last count of the running week's traders, and when and for which week it was asked for. */
  let counted: { week: number; at: number; traders: Promise<number | null> } | null = null;

  /**
   * How many members have a fee credited in the running week, or null
   * outside the season. Every wallet asks, joined or not, so the database is
   * asked once a minute at most and everyone in between is told the same.
   * When the database gives no answer the count is null, for that minute
   * too: whether rewards are on never depends on the database being up.
   */
  function tradersThisWeek({ storage, seasonStartMs }: RewardsUpstream): Promise<number | null> {
    const week = seasonWeekAt(seasonStartMs, now());
    if (week === null) return Promise.resolve(null);
    if (counted?.week !== week || now() - counted.at >= TRADERS_TTL_MS) {
      const traders = storage.traders(week).then((read) => ("failed" in read ? null : read.value));
      counted = { week, at: now(), traders };
    }
    return counted.traders;
  }

  return {
    async config() {
      return answer(
        200,
        upstream
          ? {
              enabled: true,
              seasonStart: new Date(upstream.seasonStartMs).toISOString(),
              seasonWeeks: SEASON_WEEKS,
              weeklyPoints: WEEKLY_POINTS,
              tradersThisWeek: await tradersThisWeek(upstream),
            }
          : {
              enabled: false,
              seasonStart: null,
              seasonWeeks: null,
              weeklyPoints: null,
              tradersThisWeek: null,
            },
      );
    },

    async join(body) {
      if (!upstream) return absent();
      const request = requested(joinRequest, body);
      if (!request) return invalid();
      // The code as it is looked up is the code that was signed for: nobody
      // on the way can tie a new member to an inviter of their choosing.
      const inviteCode = request.inviteCode?.trim().toUpperCase() ?? "";
      const refused = unsigned("join", request, inviteCode) ?? (await settleDue(upstream));
      if (refused) return refused;

      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
        const joined = await upstream.storage.join({
          rewardsKey: request.rewardsKey,
          code: newCode(),
          inviteCode: inviteCode || null,
          joinedWeek: weekAt(upstream.seasonStartMs, now()),
          joinedDay: Math.floor(now() / DAY_MS),
          dailyJoinCap: upstream.dailyJoinCap,
        });
        if ("failed" in joined) return joined.failed;
        if (joined.value === "invite_invalid") return failed("invite_code_invalid");
        if (joined.value === "cap_reached") return failed("rate_limited", "daily_join_cap_reached");
        if (joined.value === "code_taken") continue;
        const read = await stateOf(upstream, request.rewardsKey);
        if ("failed" in read) return read.failed;
        return read.state ? answer(200, read.state) : failed("upstream_failed", "member_not_read");
      }
      return failed("upstream_failed", "no_free_code");
    },

    async state(body) {
      if (!upstream) return absent();
      const request = requested(stateRequest, body);
      if (!request) return invalid();
      const refused = unsigned("state", request) ?? (await settleDue(upstream));
      if (refused) return refused;
      const read = await stateOf(upstream, request.rewardsKey);
      if ("failed" in read) return read.failed;
      return read.state ? answer(200, read.state) : failed("not_a_member");
    },

    async claim(body, caller) {
      if (!upstream) return absent();
      const request = requested(claimRequest, body);
      // A rewards key that is also the portfolio would tie the two together for good.
      if (!request || request.rewardsKey === request.portfolio) return invalid();
      const message = rewardsMessage("claim", request.rewardsKey, request.transaction);
      if (
        !signatureVerifies(request.rewardsKey, message, request.rewardsSignature) ||
        !signatureVerifies(request.portfolio, message, request.portfolioSignature)
      ) {
        return failed("signature_invalid");
      }
      const unsettled = await settleDue(upstream);
      if (unsettled) return unsettled;
      const member = await stateOf(upstream, request.rewardsKey);
      if ("failed" in member) return member.failed;
      if (!member.state) return failed("not_a_member");

      if (!(await upstream.rpcAllowance(caller.sessionId))) {
        return busyRefusal(PROVIDER_RETRY_AFTER_SECONDS);
      }
      const looked = await upstream.transactions.finalized(request.transaction);
      if ("failed" in looked) return looked.failed;
      if (!looked.transaction) return failed("transaction_not_finalized");
      const claim = readClaim(looked.transaction, {
        portfolio: request.portfolio,
        referralAccount: upstream.referralAccount,
        usdcMint: upstream.usdcMint,
        seasonStartMs: upstream.seasonStartMs,
        nowMs: now(),
      });
      if (!claim.ok) return failed(claim.code);

      const credited = await upstream.storage.credit({
        rewardsKey: request.rewardsKey,
        fingerprint: createHmac("sha256", upstream.fingerprintSecret)
          .update(request.transaction)
          .digest("hex"),
        week: claim.week,
        feeMicroUsdc: claim.feeMicroUsdc,
      });
      if ("failed" in credited) return credited.failed;
      if (credited.value === "duplicate") return failed("already_claimed");
      if (credited.value === "not_member") return failed("not_a_member");
      // The week was settled between the check above and this write.
      if (credited.value === "settled") return failed("outside_claim_window");

      const read = await stateOf(upstream, request.rewardsKey);
      if ("failed" in read) return read.failed;
      if (!read.state) return failed("upstream_failed", "member_not_read");
      return answer(200, {
        credited: true,
        feeMicroUsdc: claim.feeMicroUsdc.toString(),
        state: read.state,
      });
    },
  };
}

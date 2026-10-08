import { z } from "zod";
import { codeOf, parsed, refusal, type Answer, type ErrorCode } from "../../common/core/answer.js";
import type { Log } from "../../common/core/log.js";
import type { Relay } from "../../common/core/relay.js";
import type { RewardsStorage, Stored } from "./storage.js";

/**
 * The rewards tables in the Supabase project's Postgres, reached over its
 * REST interface. Every read and write is one SQL function
 * (`supabase/migrations`), called by name: nothing here builds a query, and
 * no table is read directly. The tables have row level security on and no
 * policy, so only the secret key sent here reads or writes them.
 *
 * The secret key travels in two headers, as Supabase requires. The relay
 * logs a route name, a status and a fixed word, never a header or a body.
 */

export const REWARDS_ROUTE = "rewards";

/** The database is next door; one call that has not answered by now is treated as down. */
const DATABASE_TIMEOUT_MS = 8_000;
/** The largest answer is one member's state: a few hundred bytes. */
const MAX_RESPONSE_BYTES = 16 * 1024;

/** The relay's own failures, which are passed on as they are. */
const RELAY_FAILURES: readonly ErrorCode[] = [
  "rate_limited",
  "upstream_failed",
  "upstream_refused",
  "upstream_not_reached",
  "upstream_timeout",
];

const amount = z
  .string()
  .regex(/^\d+$/)
  .transform((digits) => BigInt(digits));

const joined = z.enum(["joined", "member", "invite_invalid", "code_taken", "cap_reached"]);
const credited = z.enum(["credited", "duplicate", "not_member", "settled"]);
const memberState = z
  .object({
    code: z.string(),
    code_active: z.boolean(),
    invited: z.number().int().nonnegative(),
    was_invited: z.boolean(),
    joined_week: z.number().int(),
    member_number: z.number().int().positive(),
    points: amount,
    week_fee_micro_usdc: amount,
    week_score: amount,
    week_total_score: amount,
    week_traders: z.number().int().nonnegative(),
  })
  .transform((row) => ({
    code: row.code,
    codeActive: row.code_active,
    invited: row.invited,
    wasInvited: row.was_invited,
    joinedWeek: row.joined_week,
    memberNumber: row.member_number,
    points: row.points,
    weekFeeMicroUsdc: row.week_fee_micro_usdc,
    weekScore: row.week_score,
    weekTotalScore: row.week_total_score,
    weekTraders: row.week_traders,
  }));
const totals = z
  .object({
    members: z.number().int().nonnegative(),
    week_traders: z.number().int().nonnegative(),
  })
  .transform((row) => ({ members: row.members, weekTraders: row.week_traders }));

/**
 * Supabase answers 401 to a secret key sent with a browser's user agent, and
 * the relay's neutral one starts like a browser's. This one names a server.
 */
export const DATABASE_USER_AGENT = "noirwire-api";

export function createRewardsDatabase(deps: {
  url: string;
  secretKey: string;
  relay: Relay;
  log: Log;
}): RewardsStorage {
  const { url, secretKey, relay, log } = deps;

  const unusable = (reason: string): { failed: Answer } => {
    const failed = refusal("upstream_failed");
    log({ event: "refusal", route: REWARDS_ROUTE, status: failed.status, reason });
    return { failed };
  };

  /** One SQL function's answer, when it is what `schema` describes. */
  async function call<T>(
    name: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<Stored<T>> {
    const replied = await relay(REWARDS_ROUTE, `${url}/rest/v1/rpc/${name}`, {
      method: "POST",
      body: JSON.stringify(args),
      headers: {
        apikey: secretKey,
        Authorization: `Bearer ${secretKey}`,
        "User-Agent": DATABASE_USER_AGENT,
      },
      maxResponseBytes: MAX_RESPONSE_BYTES,
      timeoutMs: DATABASE_TIMEOUT_MS,
    });
    if (replied.status !== 200 && replied.status !== 204) {
      const failure = RELAY_FAILURES.find((code) => code === codeOf(replied));
      // The database's own error bodies name tables and functions: they are not passed on.
      return failure ? { failed: refusal(failure) } : unusable("database_error_status");
    }
    const reply = schema.safeParse(parsed(replied));
    return reply.success ? { value: reply.data } : unusable("database_answer_unusable");
  }

  return {
    join: (member) =>
      call(
        "rewards_join",
        {
          p_rewards_key: member.rewardsKey,
          p_code: member.code,
          p_invite_code: member.inviteCode,
          p_joined_week: member.joinedWeek,
          p_joined_day: member.joinedDay,
          p_daily_join_cap: member.dailyJoinCap,
        },
        joined,
      ),

    state: (rewardsKey, week) =>
      // A null week matches no row, so the week's amounts come back as zero.
      call("rewards_state", { p_rewards_key: rewardsKey, p_week: week }, memberState.nullable()),

    credit: (credit) =>
      call(
        "rewards_credit",
        {
          p_rewards_key: credit.rewardsKey,
          p_fingerprint: credit.fingerprint,
          p_week: credit.week,
          p_fee_micro_usdc: credit.feeMicroUsdc.toString(),
          p_counted_micro_usdc: credit.countedMicroUsdc.toString(),
        },
        credited,
      ),

    settle: (weeks, weeklyPoints) =>
      call("rewards_settle", { p_weeks: weeks, p_weekly_points: weeklyPoints }, z.null()),

    totals: (week) => call("rewards_totals", { p_week: week }, totals),
  };
}

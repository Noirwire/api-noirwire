import type { Answer } from "../../common/core/answer.js";

/**
 * Everything the rewards routes keep, and the only way they reach it. What
 * is kept is a rewards key, its referral code, who invited it, the week
 * and the day it joined, its fee total per week, its points per settled
 * week, and one fingerprint per claimed transaction. There is no field for a
 * portfolio, a transaction, a session, an address or a time of day.
 *
 * Each call is one atomic step in the database.
 */

/** What was read or done, or the error the caller is answered with when the database gave nothing usable. */
export type Stored<T> = { value: T } | { failed: Answer };

export type NewMember = {
  rewardsKey: string;
  /** The referral code this member is given, if they are new. */
  code: string;
  /** The code they joined with, or null. */
  inviteCode: string | null;
  /** The week they join in, counted from the season start. */
  joinedWeek: number;
  /** The UTC day they join on, in days since 1970-01-01, and the most new members that day may have. */
  joinedDay: number;
  dailyJoinCap: number;
};

/**
 * `member`: already one, and nothing changed. `invite_invalid`: the invite
 * code is unknown or not active, and nothing was created. `code_taken`:
 * another member holds `code`, and nothing was created. `cap_reached`: the
 * day already has as many new members as it may, and nothing was created.
 */
export type Joined = "joined" | "member" | "invite_invalid" | "code_taken" | "cap_reached";

export type MemberState = {
  code: string;
  /** Whether the member has one credited trade. */
  codeActive: boolean;
  /** How many members joined with this member's code. */
  invited: number;
  wasInvited: boolean;
  /** Settled points. */
  points: bigint;
  /** The member's fees in the week asked about, in micro-USDC. */
  weekFeeMicroUsdc: bigint;
  /** The member's score in that week and every member's together, in the same unit as each other. */
  weekScore: bigint;
  weekTotalScore: bigint;
};

export type Credit = {
  rewardsKey: string;
  /** What the claimed transaction is remembered by. Never the transaction's own signature. */
  fingerprint: string;
  week: number;
  feeMicroUsdc: bigint;
};

/**
 * `duplicate`: the fingerprint is already there, and nothing changed.
 * `settled`: the week's points were already handed out, and nothing changed.
 */
export type Credited = "credited" | "duplicate" | "not_member" | "settled";

export type RewardsStorage = {
  join(member: NewMember): Promise<Stored<Joined>>;
  /** A member as of `week` (null outside the season: no week's fees are read), or null when the key has not joined. */
  state(rewardsKey: string, week: number | null): Promise<Stored<MemberState | null>>;
  /** Records the fingerprint and adds the fee to the member's week, or does neither. */
  credit(credit: Credit): Promise<Stored<Credited>>;
  /** Hands out `weeklyPoints` for each of the first `weeks` weeks that has not been settled. Settling twice changes nothing. */
  settle(weeks: number, weeklyPoints: number): Promise<Stored<null>>;
};

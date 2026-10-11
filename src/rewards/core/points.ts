/**
 * The numbers of the scoring rules that this server itself states or uses.
 * No points are handed out while rewards are in a preview; these rules
 * describe how a member's recorded fees will be weighed once they are.
 * `rewards_scores` in the migration works out a member's score from a
 * week's recorded fees: their own, times 1.1 while they are an invited
 * member in their first weeks, plus 0.2 of the fees of the members they
 * invited.
 */

/** An invited member's own fees count for more during this many weeks, the week they joined in being the first. */
export const INVITED_BONUS_WEEKS = 8;

/**
 * How many weeks of the bonus an invited member has left in `week`, that
 * week included: all of them in the week they joined in, one in the last
 * week the database still counts their fees 1.1 times, none after, and none
 * for a member who joined without a code. A member who joined before
 * `week` 0 has already used up the weeks in between.
 */
export function boostWeeksLeft(wasInvited: boolean, joinedWeek: number, week: number): number {
  if (!wasInvited) return 0;
  return Math.min(INVITED_BONUS_WEEKS, Math.max(0, INVITED_BONUS_WEEKS - (week - joinedWeek)));
}

/** A score's share of the total, in basis points, rounded down. */
export function shareBps(score: bigint, total: bigint): number {
  return total === 0n ? 0 : Number((10_000n * score) / total);
}

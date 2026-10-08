/**
 * The numbers of the points rules that this server itself states or uses.
 * The rules are applied in the database, where a week is settled in one
 * call (`rewards_scores` and `rewards_settle` in the migration): a member's
 * score is their own fees, times 1.1 while they are an invited member in
 * their first weeks, plus 0.2 of the fees of the members they invited, and a
 * week's points are split by score, each share rounded down.
 */

/** The points one week hands out, split by score. */
export const WEEKLY_POINTS = 100_000;
/** An invited member's own fees count for more during this many weeks, the week they joined in being the first. */
export const INVITED_BONUS_WEEKS = 8;

/** A score's share of the total, in basis points, rounded down. */
export function shareBps(score: bigint, total: bigint): number {
  return total === 0n ? 0 : Number((10_000n * score) / total);
}

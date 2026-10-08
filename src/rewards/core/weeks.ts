/**
 * The season's calendar. A week runs from Monday 00:00 UTC to the next;
 * week 0 begins at the configured season start, and the season is twelve
 * weeks long. Everything here is arithmetic on milliseconds, so the clock
 * is whatever the caller passes in.
 */

export const WEEK_MS = 7 * 24 * 3_600_000;
export const SEASON_WEEKS = 12;
/** A trade may be claimed until this long after its week ended. */
export const CLAIM_GRACE_MS = 24 * 3_600_000;

/** 1970-01-05, the first Monday there is to count from. */
const FIRST_MONDAY_MS = 4 * 24 * 3_600_000;

/** Whether `ms` is a Monday, 00:00 UTC. */
export function isWeekStart(ms: number): boolean {
  return Number.isInteger(ms) && (ms - FIRST_MONDAY_MS) % WEEK_MS === 0;
}

/** The week `atMs` falls in, counted from the season start: negative before it, 12 or more after it. */
export function weekAt(seasonStartMs: number, atMs: number): number {
  return Math.floor((atMs - seasonStartMs) / WEEK_MS);
}

/** The same, or null outside the season: a trade made then earns nothing. */
export function seasonWeekAt(seasonStartMs: number, atMs: number): number | null {
  const week = weekAt(seasonStartMs, atMs);
  return week >= 0 && week < SEASON_WEEKS ? week : null;
}

export function weekEndsAt(seasonStartMs: number, week: number): number {
  return seasonStartMs + (week + 1) * WEEK_MS;
}

/** Whether a trade made in `week` may still be claimed at `nowMs`. */
export function claimOpen(seasonStartMs: number, week: number, nowMs: number): boolean {
  return nowMs < weekEndsAt(seasonStartMs, week) + CLAIM_GRACE_MS;
}

/** How many of the season's weeks, from week 0 on, take no more claims at `nowMs`: the weeks that may be settled. */
export function closedWeeks(seasonStartMs: number, nowMs: number): number {
  const closed = Math.floor((nowMs - seasonStartMs - CLAIM_GRACE_MS) / WEEK_MS);
  return Math.min(SEASON_WEEKS, Math.max(0, closed));
}

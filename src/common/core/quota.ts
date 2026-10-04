/**
 * Every rate limit and budget in this service goes through this one
 * interface. The implementation below keeps its counters in the memory of
 * one process, so the numbers only hold while the service runs as a single
 * replica: a second replica would count separately and double every limit.
 * A shared store would implement the same interface.
 *
 * A key is a session id or a client address, held for the length of its
 * window (a minute, or an hour for the hourly budgets) and then dropped.
 * Nothing is written anywhere.
 */

/** Which table a budget is counted in. Each is bounded on its own, so a flood of one kind cannot push out another. */
export type QuotaScope = "session" | "ip" | "global";

export type Budget = { scope: QuotaScope; key: string; limit: number; windowMs: number };

export interface QuotaStore {
  /**
   * Takes one from every budget, or from none of them when any is spent or
   * cannot be counted. A request that is refused is not counted.
   */
  take(budgets: readonly Budget[], now?: number): boolean;
}

/**
 * The most keys counted at once per scope, so the tables cannot grow without
 * limit. One caller holds a key per budget it has touched in the last minute
 * (about ten), so this is room for some ten thousand callers at once, in a
 * few megabytes.
 */
export const MAX_TRACKED_KEYS = 100_000;
/** A full table is searched for finished windows at most this often, so a flood cannot make every request pay for a search. */
const SWEEP_INTERVAL_MS = 1_000;

type Window = { startedAt: number; windowMs: number; count: number };
type Table = { windows: Map<string, Window>; sweptAt: number };

const live = (window: Window | undefined, now: number): window is Window =>
  window !== undefined && now - window.startedAt < window.windowMs;

/**
 * Fixed windows per key. When a table is full of live windows a newcomer is
 * refused: letting it through uncounted would give a flood of made-up keys
 * as many requests as it liked, and dropping counters to make room would
 * hand everyone already over their limit a fresh one. A key that is already
 * counted is unaffected.
 */
export function createMemoryQuotaStore(maxTrackedKeys = MAX_TRACKED_KEYS): QuotaStore {
  const tables: Record<QuotaScope, Table> = {
    session: { windows: new Map(), sweptAt: 0 },
    ip: { windows: new Map(), sweptAt: 0 },
    global: { windows: new Map(), sweptAt: 0 },
  };

  function roomFor(table: Table, newcomers: number, now: number): boolean {
    if (table.windows.size + newcomers <= maxTrackedKeys) return true;
    if (now - table.sweptAt < SWEEP_INTERVAL_MS) return false;
    table.sweptAt = now;
    for (const [key, window] of table.windows) {
      if (!live(window, now)) table.windows.delete(key);
    }
    return table.windows.size + newcomers <= maxTrackedKeys;
  }

  return {
    take(budgets, now = Date.now()) {
      const newcomers: Record<QuotaScope, number> = { session: 0, ip: 0, global: 0 };
      for (const budget of budgets) {
        const { windows } = tables[budget.scope];
        const current = windows.get(budget.key);
        if (live(current, now)) {
          if (current.count >= budget.limit) return false;
        } else {
          if (budget.limit < 1) return false;
          if (!current) newcomers[budget.scope] += 1;
        }
      }
      for (const scope of ["session", "ip", "global"] as const) {
        if (newcomers[scope] > 0 && !roomFor(tables[scope], newcomers[scope], now)) return false;
      }
      for (const budget of budgets) {
        const { windows } = tables[budget.scope];
        const current = windows.get(budget.key);
        if (live(current, now)) current.count += 1;
        else windows.set(budget.key, { startedAt: now, windowMs: budget.windowMs, count: 1 });
      }
      return true;
    },
  };
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/** Who is asking: the session the token names, and the address the request arrived from. */
export type Caller = { sessionId: string; ip: string };

export type RouteLimits = {
  /** Requests a minute for one session. */
  perSession: number;
  /**
   * Requests a minute from one address. Higher than the session's, because
   * the web app's host forwards every browser's request from its own few
   * addresses: an address is many people, a session is one.
   */
  perIp: number;
  /** Requests a minute in total, whoever asks: what this service will spend of a provider's quota. */
  total: number;
};

/** The three budgets one request to `route` is counted against. */
export function routeBudgets(route: string, caller: Caller, limits: RouteLimits): Budget[] {
  return [
    {
      scope: "session",
      key: `${route}|${caller.sessionId}`,
      limit: limits.perSession,
      windowMs: MINUTE_MS,
    },
    { scope: "ip", key: `${route}|${caller.ip}`, limit: limits.perIp, windowMs: MINUTE_MS },
    { scope: "global", key: route, limit: limits.total, windowMs: MINUTE_MS },
  ];
}

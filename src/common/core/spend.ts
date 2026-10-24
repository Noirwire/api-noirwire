import { parsed } from "./answer.js";
import type { Log } from "./log.js";
import type { Budget, QuotaReceipt, QuotaStore } from "./quota.js";
import type { Relay } from "./relay.js";

/**
 * The budgets that bound what this service really spends (a day's profile
 * creations, the relayer's signatures per minute and per hour) are counted
 * in the database, so a deploy or a crash cannot refill them and two
 * replicas share one count. Everything else stays in the memory of one
 * process, in a `QuotaStore`.
 *
 * It has the shape of `QuotaStore`'s `reserve` and `refund`, but answers
 * later, because the count is somewhere else. A budget here has the same
 * windows as in a `QuotaStore`: one starts at the budget's first use and
 * runs for its length. The database's clock starts and ends it, so every
 * replica names the same window.
 */
export interface SpendStore {
  /**
   * One from every budget, or from none when any is spent or cannot be
   * counted. The database store ignores `now`: its own clock decides.
   */
  reserve(budgets: readonly Budget[], now?: number): Promise<QuotaReceipt | null>;
  /** Gives back what one `reserve` counted, once, and only in the very windows it counted. Never throws. */
  refund(receipt: QuotaReceipt): Promise<void>;
}

/** The spend store over a memory `QuotaStore`: for a deployment with no database, and for tests. */
export function spendInMemory(quotas: QuotaStore): SpendStore {
  return {
    reserve: (budgets, now) => Promise.resolve(quotas.reserve(budgets, now)),
    refund: (receipt) => Promise.resolve(quotas.refund(receipt)),
  };
}

/** The two SQL functions, as calls. A failed call is `null`: it is never read as an answer. */
export type SpendCalls = {
  /**
   * The start of the window one was taken in (as the database wrote it,
   * to be handed back to `refund` unchanged), or `false` when the budget is
   * spent.
   */
  take(budget: string, windowMs: number, limit: number): Promise<string | false | null>;
  /** Whether the refund reached the database. */
  refund(budget: string, windowStart: string): Promise<boolean>;
};

export const SPEND_ROUTE = "spend";
/** The database is next door; one call that has not answered by now is treated as down. */
const DATABASE_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024;
/** Supabase answers 401 to a secret key sent with a browser's user agent. */
const DATABASE_USER_AGENT = "noirwire-api";

/** The spend functions of the Supabase project's Postgres, over its REST interface. */
export function createSpendCalls(deps: {
  url: string;
  secretKey: string;
  relay: Relay;
  log: Log;
}): SpendCalls {
  const { url, secretKey, relay, log } = deps;

  async function call(name: string, args: Record<string, unknown>) {
    const replied = await relay(SPEND_ROUTE, `${url}/rest/v1/rpc/${name}`, {
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
    // The database's own error bodies name tables and functions: none is logged.
    if (replied.status !== 200 && replied.status !== 204) {
      log({
        event: "refusal",
        route: SPEND_ROUTE,
        status: replied.status,
        reason: "database_error_status",
      });
      return null;
    }
    return { body: parsed(replied) };
  }

  return {
    async take(budget, windowMs, limit) {
      const answer = await call("spend_take", {
        p_budget: budget,
        p_window_ms: windowMs,
        p_limit: limit,
      });
      if (answer === null) return null;
      const { body } = answer;
      if (typeof body === "object" && body !== null && "taken" in body) {
        if (body.taken === false) return false;
        if (
          body.taken === true &&
          "window_start" in body &&
          typeof body.window_start === "string" &&
          body.window_start !== ""
        ) {
          return body.window_start;
        }
      }
      log({
        event: "refusal",
        route: SPEND_ROUTE,
        status: 502,
        reason: "database_answer_unusable",
      });
      return null;
    },

    async refund(budget, windowStart) {
      const answer = await call("spend_refund", {
        p_budget: budget,
        p_window_start: windowStart,
      });
      return answer !== null;
    },
  };
}

/**
 * The database when there is one, and otherwise the memory of this process
 * (a local run with no database secret key). Says which, once. A deployment
 * that must not count in memory refuses to start without the key (see
 * `loadConfig`).
 */
export function chooseSpendStore(deps: {
  database: { url: string; secretKey: string } | null;
  quotas: QuotaStore;
  relay: Relay;
  log: Log;
}): SpendStore {
  const { database, quotas, relay, log } = deps;
  if (!database) {
    log({ event: "lifecycle", state: "spend_in_memory" });
    return spendInMemory(quotas);
  }
  log({ event: "lifecycle", state: "spend_in_database" });
  return createDurableQuotaStore(createSpendCalls({ ...database, relay, log }), log);
}

type Counted = { budget: string; windowStart: string };

/**
 * Takes from each budget in turn and, when one is spent or the database does
 * not answer, gives back what it already took. It fails closed: a take that
 * cannot be counted is refused, as if the budget were spent. A refund that
 * does not reach the database leaves the slot spent, which errs the same
 * way.
 */
export function createDurableQuotaStore(calls: SpendCalls, log: Log): SpendStore {
  const claimed = new WeakMap<QuotaReceipt, Counted[]>();

  const giveBack = async (counted: readonly Counted[]) => {
    for (const { budget, windowStart } of counted) {
      let reached = false;
      try {
        reached = await calls.refund(budget, windowStart);
      } catch {
        // Treated as not reached, below.
      }
      if (!reached) {
        log({ event: "refusal", route: SPEND_ROUTE, status: 502, reason: "refund_not_reached" });
      }
    }
  };

  return {
    async reserve(budgets) {
      const counted: Counted[] = [];
      for (const { key, limit, windowMs } of budgets) {
        let windowStart: string | false | null = null;
        try {
          windowStart = await calls.take(key, windowMs, limit);
        } catch {
          log({ event: "refusal", route: SPEND_ROUTE, status: 502, reason: "database_failed" });
        }
        if (!windowStart) {
          await giveBack(counted);
          return null;
        }
        counted.push({ budget: key, windowStart });
      }
      const receipt = {} as QuotaReceipt;
      claimed.set(receipt, counted);
      return receipt;
    },

    async refund(receipt) {
      const counted = claimed.get(receipt);
      if (!counted) return;
      claimed.delete(receipt);
      await giveBack(counted);
    },
  };
}

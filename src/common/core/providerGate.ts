/**
 * What this server may ask of one provider, a second. A provider allows this
 * server's key only so many requests, and counts them all together, whoever
 * they were for: without this, a few sessions asking as fast as they can
 * would spend the whole allowance and every other wallet would be answered
 * with the provider's 429.
 *
 * A token bucket set BELOW the provider's allowance: `ratePerSecond` tokens
 * a second, and a small burst on top. A request that finds no token waits,
 * briefly, in its session's own line, and the lines are served in turn: one
 * session asking a hundred times and another asking once each get the next
 * token alternately, so a quiet session is served however loud its
 * neighbour is. A request that would wait too long is refused instead, and
 * the caller is told when to try again.
 *
 * The turn is per session, and a session is cheap, so this is fairness
 * between wallets, not a defence against someone holding many sessions:
 * that is what rationing session starts is for.
 *
 * Like every counter here it lives in one process: see quota.ts.
 */
export type ProviderGate = {
  /** Resolves true once a request may be sent upstream, false when it is refused. */
  acquire(sessionKey: string): Promise<boolean>;
};

export type ProviderGateOptions = {
  ratePerSecond: number;
  /** Tokens that may be spent at once. Defaults to a quarter of a second's worth, at least one. */
  burst?: number;
  /** The longest a request waits for a token. */
  maxWaitMs?: number;
  now?: () => number;
};

/** How long a refused caller is told to wait, in seconds. */
export const PROVIDER_RETRY_AFTER_SECONDS = 1;
export const GATE_MAX_WAIT_MS = 400;

/** The key the server's own reads of a provider wait under, like one more session. */
export const SERVER_KEY = "server";

/** How many of one session's requests wait at once; the rest are refused at once. */
export const MAX_WAITING_PER_SESSION = 2;
const MAX_SESSIONS_WAITING = 1_024;

type Waiter = { deadline: number; resolve: (granted: boolean) => void };

export function burstFor(ratePerSecond: number): number {
  return Math.max(1, Math.floor(ratePerSecond / 4));
}

export function createProviderGate(options: ProviderGateOptions): ProviderGate {
  const rate = options.ratePerSecond;
  const burst = options.burst ?? burstFor(rate);
  const maxWaitMs = options.maxWaitMs ?? GATE_MAX_WAIT_MS;
  const now = options.now ?? Date.now;

  let tokens = burst;
  let refilledAt = now();
  let waiting = 0;
  /** Each session's line, and the order the lines are served in. */
  const lines = new Map<string, Waiter[]>();
  let turns: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function refill() {
    const at = now();
    tokens = Math.min(burst, tokens + ((at - refilledAt) * rate) / 1000);
    refilledAt = at;
  }

  function schedule() {
    if (timer !== null || waiting === 0) return;
    const untilToken = tokens >= 1 ? 0 : Math.ceil(((1 - tokens) * 1000) / rate);
    let untilDeadline = Infinity;
    for (const line of lines.values()) {
      for (const waiter of line) untilDeadline = Math.min(untilDeadline, waiter.deadline - now());
    }
    timer = setTimeout(serve, Math.max(1, Math.min(untilToken, untilDeadline)));
  }

  function serve() {
    timer = null;
    refill();
    const at = now();
    for (const [key, line] of lines) {
      const kept = line.filter((waiter) => {
        if (waiter.deadline > at) return true;
        waiting -= 1;
        waiter.resolve(false);
        return false;
      });
      if (kept.length > 0) lines.set(key, kept);
      else lines.delete(key);
    }
    turns = turns.filter((key) => lines.has(key));
    while (tokens >= 1 && turns.length > 0) {
      const key = turns.shift() as string;
      const line = lines.get(key) as Waiter[];
      const waiter = line.shift() as Waiter;
      tokens -= 1;
      waiting -= 1;
      waiter.resolve(true);
      if (line.length > 0) turns.push(key);
      else lines.delete(key);
    }
    schedule();
  }

  return {
    acquire(sessionKey) {
      refill();
      if (waiting === 0 && tokens >= 1) {
        tokens -= 1;
        return Promise.resolve(true);
      }
      const line = lines.get(sessionKey) ?? [];
      // A session's own line is short, so asking more often buys it nothing
      // and costs nobody else their place. Only the number of lines is
      // bounded, and only so that memory is.
      const full = line.length === 0 && lines.size >= MAX_SESSIONS_WAITING;
      if (full || line.length >= MAX_WAITING_PER_SESSION) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        if (line.length === 0) {
          lines.set(sessionKey, line);
          turns.push(sessionKey);
        }
        line.push({ deadline: now() + maxWaitMs, resolve });
        waiting += 1;
        schedule();
      });
    },
  };
}

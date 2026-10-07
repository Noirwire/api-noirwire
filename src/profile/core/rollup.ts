import { z } from "zod";
import { codeOf, parsed, refusal, type Answer, type ErrorCode } from "../../common/core/answer.js";
import type { Log } from "../../common/core/log.js";
import type { Relay } from "../../common/core/relay.js";

/**
 * The private rollup the profiles live on, as this server asks it: its two
 * sign-in calls, and one JSON-RPC call at a time on behalf of a read token.
 * Every request goes through the relay, so the rollup sees this server's
 * address and nothing of the caller but what is named here.
 *
 * A read token travels in the query string, as the rollup requires. It is
 * never logged: the relay logs a route name, a status and a fixed word.
 */

export const PROFILE_ROUTE = "profile";

/** The rollup answers in tens of milliseconds; one that has not by now is treated as down. */
const ROLLUP_TIMEOUT_MS = 8_000;
/** The largest answer is one profile account: at most 4,096 bytes of record, base64, in its envelope. */
const MAX_RESPONSE_BYTES = 32 * 1024;

/** The relay's own failures, which are passed on as they are. */
const RELAY_FAILURES: readonly ErrorCode[] = [
  "rate_limited",
  "upstream_failed",
  "upstream_refused",
  "upstream_not_reached",
  "upstream_timeout",
];

/** What the rollup said, or the error the caller is answered with when it said nothing usable. */
export type Asked = { json: unknown } | { failed: Answer };

/** A JSON-RPC error as the rollup writes one. `data.err` is the transaction's own failure, when it has one. */
export type RpcError = { message?: string; data?: { err?: unknown } };
export type Called = { result: unknown } | { error: RpcError } | { failed: Answer };

export type Rollup = {
  challenge(owner: string): Promise<Asked>;
  login(owner: string, challenge: string, signature: string): Promise<Asked>;
  call(token: string, method: string, params: unknown[]): Promise<Called>;
};

const rpcReply = z.object({
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string().optional(),
      data: z.object({ err: z.unknown().optional() }).nullish(),
    })
    .optional(),
});

export function createRollup(deps: { url: string; relay: Relay; log: Log }): Rollup {
  const { url, relay, log } = deps;

  const unusable = (reason: string): { failed: Answer } => {
    const failed = refusal("upstream_failed");
    log({ event: "refusal", route: PROFILE_ROUTE, status: failed.status, reason });
    return { failed };
  };

  async function ask(target: string, body?: unknown): Promise<Asked> {
    const replied = await relay(PROFILE_ROUTE, target, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      maxResponseBytes: MAX_RESPONSE_BYTES,
      timeoutMs: ROLLUP_TIMEOUT_MS,
    });
    if (replied.status === 200) return { json: parsed(replied) };
    const failure = RELAY_FAILURES.find((code) => code === codeOf(replied));
    // The rollup's own error bodies are not passed on: they are not this API's to vouch for.
    return failure ? { failed: refusal(failure) } : unusable("rollup_error_status");
  }

  return {
    challenge: (owner) => ask(`${url}/auth/challenge?pubkey=${encodeURIComponent(owner)}`),

    login: (owner, challenge, signature) =>
      ask(`${url}/auth/login`, { pubkey: owner, challenge, signature }),

    async call(token, method, params) {
      const asked = await ask(`${url}?token=${encodeURIComponent(token)}`, {
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      });
      if ("failed" in asked) return asked;
      const reply = rpcReply.safeParse(asked.json);
      if (!reply.success) return unusable("rollup_answer_not_rpc");
      const { error, result } = reply.data;
      if (error) return { error: { message: error.message, data: error.data ?? undefined } };
      return { result };
    },
  };
}

import { refusal, type Answer, type ErrorCode } from "./answer.js";
import type { Log } from "./log.js";
import { readCapped } from "./readCapped.js";

/**
 * What the relay routes share. A wallet talks to this API instead of to the
 * provider, so the provider sees this server's address and never a user's.
 *
 * A wallet address is a secret here, so the relay keeps nothing: no storage,
 * and no log line that carries a body, an address, an amount or an IP. What
 * is logged is a route name, a status code and a fixed reason.
 */

export const NEUTRAL_USER_AGENT = "Mozilla/5.0 (compatible; NoirWire)";
export const UPSTREAM_TIMEOUT_MS = 30_000;

/** The failures that happen before a single byte of the request is sent: no such host, or nothing listening. */
const NEVER_CONNECTED = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"];

function neverReached(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" && NEVER_CONNECTED.includes(cause.code);
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export type RelayInit = {
  method: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  maxResponseBytes: number;
  /** For an upstream with a stand-in to turn to: how long it is waited for before the next is tried. */
  timeoutMs?: number;
};

export type Relay = (route: string, url: string, init: RelayInit) => Promise<Answer>;

/**
 * Sends one request upstream and hands the answer back. Nothing of the
 * caller's request travels except `body`: the upstream request is built
 * from scratch, so no IP, token, cookie, referer, origin or browser name can
 * ride along.
 *
 * Coming back, only the status and the body pass, and the body only when it
 * is JSON of at most `maxResponseBytes`. Anything else, HTML above all, is
 * replaced by a fixed error: a provider must not be able to put content of
 * its choosing behind this API's name. Two statuses never pass as they are:
 * a provider's 429 becomes this API's `rate_limited`, and its 401 or 403
 * becomes a 502 `upstream_refused`.
 */
export function createRelay(deps: { fetch: typeof fetch; log: Log }): Relay {
  return async (route, url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
    const failed = (code: ErrorCode, reason: string) => {
      const answered = refusal(code);
      deps.log({ event: "refusal", route, status: answered.status, reason });
      return answered;
    };
    try {
      const upstream = await deps.fetch(url, {
        method: init.method,
        headers: {
          Accept: "application/json",
          "User-Agent": NEUTRAL_USER_AGENT,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
        },
        body: init.body,
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      });
      if (upstream.status === 429) {
        // A provider's rate limit is not an outage. Its body is plain text,
        // which would otherwise be reported as a broken answer; passed on as
        // 429, the wallet's own retry with backoff handles it.
        await upstream.body?.cancel();
        return failed("rate_limited", "upstream_rate_limit");
      }
      if (upstream.status === 401 || upstream.status === 403) {
        // The provider turned down this server's own key. That is ours to
        // fix and never the caller's session: passed on as a 401 it would
        // tell a wallet its token was refused and that nothing was sent.
        await upstream.body?.cancel();
        deps.log({
          event: "operator_error",
          route,
          status: upstream.status,
          reason: "upstream_refused_credentials",
        });
        return refusal("upstream_refused");
      }
      const body = await readCapped(upstream.body, init.maxResponseBytes, controller.signal);
      if (!body) return failed("upstream_failed", "upstream_answer_too_large");
      if (body.byteLength === 0) return { status: upstream.status, body: null };
      const text = body.toString("utf8");
      if (!isJson(text)) return failed("upstream_failed", "upstream_answer_not_json");
      return { status: upstream.status, body: text };
    } catch (error) {
      if (controller.signal.aborted) return failed("upstream_timeout", "upstream_timed_out");
      // A connection that was never made is told apart from one that broke:
      // the first means the upstream never saw the request, which matters to
      // a caller deciding whether what it sent may still be acted on.
      return neverReached(error)
        ? failed("upstream_not_reached", "upstream_not_reached")
        : failed("upstream_failed", "upstream_unreachable");
    } finally {
      clearTimeout(timer);
    }
  };
}

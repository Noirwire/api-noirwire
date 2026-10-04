import { z } from "zod";
import { AuthError, type Verifier } from "../../auth/core/verifier.js";
import { answer, refusal, type Answer, type ErrorCode } from "../../common/core/answer.js";
import type { Log } from "../../common/core/log.js";
import { readCapped } from "../../common/core/readCapped.js";
import { NEUTRAL_USER_AGENT } from "../../common/core/relay.js";

/**
 * Starts and renews the anonymous sessions every other route asks for. The
 * wallets never talk to Supabase: this server does, so Supabase sees this
 * server's address and never a user's, and nothing of the caller's request
 * (address, browser, headers) is passed on.
 *
 * A session is a quota bucket and nothing more. It names nobody, anyone can
 * ask for another, and it is allowed to live only so long: past its maximum
 * age it is not renewed, the wallet starts a fresh one, and the key that
 * joins a wallet's requests together changes with it.
 */

export type SessionsConfig = { supabaseUrl: string; publishableKey: string };

export type Sessions = {
  start(now?: number): Promise<Answer>;
  refresh(body: string, now?: number): Promise<Answer>;
};

const SUPABASE_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ROUTE = "session";

const refreshRequest = z.strictObject({
  refreshToken: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
});

const issued = z.object({
  access_token: z.string().min(1).max(4_096),
  refresh_token: z.string().min(1).max(512),
  expires_at: z.number().int().positive(),
});

export function createSessions(
  config: SessionsConfig,
  deps: { fetch: typeof fetch; verify: Verifier; log: Log },
): Sessions {
  const refused = (code: ErrorCode, reason: string) => {
    const answered = refusal(code);
    deps.log({ event: "refusal", route: ROUTE, status: answered.status, reason });
    return answered;
  };

  /**
   * Supabase turned down the publishable key this server sent. That is an
   * operator's to fix and says nothing about the caller's session, so it is
   * never answered as a 401.
   */
  const keyRefused = (status: number) => {
    deps.log({
      event: "operator_error",
      route: ROUTE,
      status,
      reason: "supabase_refused_credentials",
    });
    return refusal("upstream_refused");
  };

  /** One request to Supabase Auth, built from scratch: the status and the JSON it answered, or null. */
  async function ask(
    path: string,
    body: unknown,
  ): Promise<{ status: number; json: unknown } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
    try {
      const response = await deps.fetch(`${config.supabaseUrl}/auth/v1/${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": NEUTRAL_USER_AGENT,
          apikey: config.publishableKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      });
      const bytes = await readCapped(response.body, MAX_RESPONSE_BYTES, controller.signal);
      if (!bytes) return null;
      let json: unknown = null;
      try {
        json = JSON.parse(bytes.toString("utf8"));
      } catch {
        json = null;
      }
      return { status: response.status, json };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The session as the wallet gets it, once this server's own verifier
   * accepts the token: a session it would refuse on the next request (past
   * its maximum age, or of an age that cannot be told) is not handed out.
   */
  async function handOut(json: unknown, now: number): Promise<Answer> {
    const session = issued.safeParse(json);
    if (!session.success) return refused("unavailable", "supabase_answer_not_a_session");
    try {
      await deps.verify(session.data.access_token, now);
    } catch (error) {
      if (error instanceof AuthError && error.failure === "session_expired") {
        return refused("session_expired", "session_past_max_age");
      }
      return refused("unavailable", "issued_token_not_verified");
    }
    return answer(200, {
      accessToken: session.data.access_token,
      refreshToken: session.data.refresh_token,
      expiresAt: session.data.expires_at,
    });
  }

  return {
    async start(now = Date.now()) {
      const reply = await ask("signup", {});
      if (!reply) return refused("unavailable", "supabase_not_reached");
      if (reply.status === 429) return refused("rate_limited", "supabase_rate_limit");
      if (reply.status === 401 || reply.status === 403) return keyRefused(reply.status);
      if (reply.status !== 200) return refused("unavailable", "supabase_refused_signup");
      return handOut(reply.json, now);
    },

    async refresh(body, now = Date.now()) {
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return refusal("invalid_request");
      }
      const request = refreshRequest.safeParse(json);
      if (!request.success) return refusal("invalid_request");
      const reply = await ask("token?grant_type=refresh_token", {
        refresh_token: request.data.refreshToken,
      });
      if (!reply) return refused("unavailable", "supabase_not_reached");
      if (reply.status === 429) return refused("rate_limited", "supabase_rate_limit");
      if (reply.status === 401 || reply.status === 403) return keyRefused(reply.status);
      // Supabase turns down a refresh token it does not know, has already
      // exchanged or has revoked with a 400. The wallet's answer to all of
      // them is the same: start a new session.
      if (reply.status >= 400 && reply.status < 500) {
        return refused("session_invalid", "refresh_token_refused");
      }
      if (reply.status !== 200) return refused("unavailable", "supabase_failed");
      return handOut(reply.json, now);
    },
  };
}

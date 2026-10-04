import { createHmac } from "node:crypto";
import type { RouteLimits } from "../../common/core/quota.js";
import { NEUTRAL_USER_AGENT } from "../../common/core/relay.js";
import type { AnalyticsConfig } from "../../config/core/config.js";
import { cleanEvent, isOnChain, type CleanEvent } from "./usageEvents.js";

/**
 * The only way a usage event leaves a wallet. The wallet posts here; this
 * checks the event against the closed list and forwards it to NoirWire's own
 * analytics server.
 *
 * Three things are decided here rather than in the wallet.
 *
 * The event is rebuilt from allowed values, so nothing free-form is
 * forwarded.
 *
 * Nothing that identifies the caller is forwarded or stored: no IP, no
 * token and no session id. The analytics server sees this server's address
 * and a one-way code made from the session and the month, enough to count
 * visits and useless for finding anyone. The code is keyed with a secret
 * that only this server holds (ANALYTICS_SALT); without the secret no code
 * is sent at all. The wallet has no say in it either way.
 *
 * An event that coincides with a transaction on chain is forwarded with no
 * visitor code and no browser details, so it adds to a total and cannot be
 * attached to anyone's visit.
 */

export const EVENT_MAX_BODY_BYTES = 1024;
export const EVENT_LIMITS: RouteLimits = { perSession: 120, perIp: 2_400, total: 12_000 };
export const ANALYTICS_TIMEOUT_MS = 5_000;
const MAX_BROWSER_CHARS = 512;

/** A code that is the same for one session within one month and tells nothing about either. */
export function visitorCode(secret: string | null, sessionId: string, now: number): string | null {
  if (!secret) return null;
  const month = new Date(now).toISOString().slice(0, 7);
  return createHmac("sha256", secret)
    .update([sessionId, month].join("|"))
    .digest("hex")
    .slice(0, 48);
}

/** Campaign tags, put back on the URL where the analytics server reads them from. */
function campaignQuery(arrival: CleanEvent["arrival"]) {
  const query = new URLSearchParams(
    Object.entries(arrival ?? {}).map(([key, value]): [string, string] => [`utm_${key}`, value]),
  ).toString();
  return query ? `?${query}` : "";
}

export type ForwardedEvent = { url: string; headers: Record<string, string>; body: string };

/**
 * What is sent to the analytics server for `body`, or null when the body is
 * not an event from the closed list.
 */
export function forwardedEvent(
  body: string,
  from: { sessionId: string; browser: string | undefined },
  analytics: AnalyticsConfig,
  now: number,
): ForwardedEvent | null {
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const event = cleanEvent(json);
  if (!event) return null;

  const anonymous = event.name !== undefined && isOnChain(event.name);
  const browser = (from.browser ?? "").slice(0, MAX_BROWSER_CHARS) || NEUTRAL_USER_AGENT;
  const visitor = anonymous ? null : visitorCode(analytics.salt, from.sessionId, now);
  return {
    url: `${analytics.url}/api/send`,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": anonymous ? NEUTRAL_USER_AGENT : browser,
    },
    body: JSON.stringify({
      type: "event",
      payload: {
        website: analytics.website,
        hostname: analytics.hostname,
        url: event.path + campaignQuery(event.arrival),
        title: "NoirWire",
        ...(visitor ? { id: visitor } : {}),
        ...(event.display && !anonymous ? { screen: event.display } : {}),
        ...(event.name ? { name: event.name, data: event.data } : {}),
      },
    }),
  };
}

import { z } from "zod";
import { refusal, type Answer } from "../../common/core/answer.js";
import type { RouteLimits } from "../../common/core/quota.js";

/**
 * The wallet's only way to Jupiter: quotes and orders, landing a signed
 * swap, and Jupiter Lend. Jupiter sees this server's address rather than the
 * user's next to the portfolio that is trading. The API key stays here.
 *
 * Not an open proxy: only the paths below, with the method the wallet uses.
 *
 * Jupiter takes some requests as a GET with the address in the query. The
 * wallet still sends those here as a POST with a JSON body, and the query is
 * built on this side, so an address never sits in a URL that an access log
 * on the way would record.
 */

type Route = {
  /** Sent upstream as a GET, with exactly these fields of the JSON body as its query. */
  asQuery?: readonly string[];
};

export const JUPITER_ROUTES: Readonly<Record<string, Route>> = {
  "POST swap/v2/order": {
    asQuery: [
      "inputMint",
      "outputMint",
      "amount",
      "taker",
      "slippageBps",
      "referralAccount",
      "referralFee",
    ],
  },
  "POST swap/v2/execute": {},
  "GET lend/v1/earn/tokens": {},
  "POST lend/v1/earn/earnings": { asQuery: ["user", "positions"] },
  "POST lend/v1/earn/deposit": {},
  "POST lend/v1/earn/withdraw": {},
  // The same two as instructions, for a transaction the fee relayer pays for.
  "POST lend/v1/earn/deposit-instructions": {},
  "POST lend/v1/earn/withdraw-instructions": {},
};

export const JUPITER_MAX_BODY_BYTES = 16 * 1024;
/** An order with its route and transaction is about ten kilobytes; the list of lending vaults is the largest answer. */
export const JUPITER_MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * From what Jupiter allows this server's key: the route's total for a minute
 * is what the provider gate lets through in one; a session may take at most
 * half. A pie reviews and places up to ten orders back to back.
 */
export function jupiterLimits(providerRps: number): RouteLimits {
  const total = providerRps * 60;
  return { perSession: Math.ceil(total / 2), perIp: total, total };
}

/** A flat object of strings: what a body that becomes a query has to be. */
const flatStrings = z.record(z.string(), z.string());

/** The body's fields as a query string, or null unless it is a flat object of the allowed fields. */
export function queryFrom(body: string, allowed: readonly string[]): string | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const fields = flatStrings.safeParse(json);
  if (!fields.success) return null;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(fields.data)) {
    if (!allowed.includes(key)) return null;
    query.set(key, value);
  }
  return query.toString();
}

export function jupiterRoute(method: string, path: string): Route | undefined {
  const key = `${method} ${path}`;
  return Object.hasOwn(JUPITER_ROUTES, key) ? JUPITER_ROUTES[key] : undefined;
}

export type JupiterPlan =
  | { upstream: { method: "GET" | "POST"; pathAndQuery: string; body?: string } }
  | { refused: Answer };

/** What is sent to Jupiter for an admitted request on a listed route. */
export function planJupiter(route: Route, method: string, path: string, body: string): JupiterPlan {
  const invalid = { refused: refusal("invalid_request") };
  if (route.asQuery) {
    const query = queryFrom(body, route.asQuery);
    if (query === null) return invalid;
    return { upstream: { method: "GET", pathAndQuery: `${path}?${query}` } };
  }
  if (method === "GET") return { upstream: { method: "GET", pathAndQuery: path } };
  return { upstream: { method: "POST", pathAndQuery: path, body } };
}

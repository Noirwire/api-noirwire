import type { NextFunction, Request, Response } from "express";
import type { Config } from "../../config/core/config.js";
import { NO_DOCUMENT_POLICY, refusal } from "../core/answer.js";
import type { Log } from "../core/log.js";
import { routeOf } from "./route.js";
import { send } from "./send.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

/** The documentation page loads its own script and styles from this origin, and nothing from anywhere else. */
const DOCS_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const isDocsPage = (path: string) => path === "/docs" || path.startsWith("/docs/");

/**
 * The headers every response carries. This is a JSON API: nothing it
 * answers is a document, so the policy lets a response load and run
 * nothing, it may not be framed, its type may not be guessed and it is
 * never cached. The documentation page alone gets a policy it can render
 * under.
 */
export function securityHeaders(): Middleware {
  return (req, res, next) => {
    res.set({
      "Content-Security-Policy": isDocsPage(req.path) ? DOCS_POLICY : NO_DOCUMENT_POLICY,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
      "Cache-Control": "no-store",
    });
    next();
  };
}

/** One line per request: the route's pattern, the status and how long it took. Nothing else. */
export function requestLog(log: Log, now: () => number = Date.now): Middleware {
  return (req, res, next) => {
    const startedAt = now();
    res.on("finish", () => {
      log({ event: "request", route: routeOf(req), status: res.statusCode, ms: now() - startedAt });
    });
    next();
  };
}

export const RESPONSE_DEADLINE_MS = 60_000;

/**
 * No request is left open for ever. Each upstream call has a timeout of its
 * own, well inside this one; this is the bound on the whole response.
 */
export function responseDeadline(ms = RESPONSE_DEADLINE_MS): Middleware {
  return (_req, res, next) => {
    const timer = setTimeout(() => {
      send(res, refusal("response_timeout"));
    }, ms);
    res.on("close", () => clearTimeout(timer));
    next();
  };
}

const ALLOWED_METHODS = "GET, POST";
const ALLOWED_HEADERS = "Authorization, Content-Type";
/** How old a cached price is, and when to try again: a browser may not read either unless it is named here. */
const EXPOSED_HEADERS = "Age, Retry-After";
const PREFLIGHT_MAX_AGE_SECONDS = "600";

/**
 * Cross-origin access for callers that reach this API directly from a
 * browser. Only the configured origins, exactly as written, get the headers
 * a browser asks for; credentials are never allowed, since the token
 * travels in a header and no cookie is used. A request that names any other
 * origin is refused outright, preflight or not. A request with no `Origin`
 * (the mobile app, or the web app's own server forwarding for its pages) is
 * not a cross-origin browser request and passes through to the token check.
 */
export function cors(config: Pick<Config, "allowedOrigins">): Middleware {
  const allowed = new Set(config.allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    res.vary("Origin");
    if (!allowed.has(origin)) {
      return send(res, refusal("origin_not_allowed"));
    }
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
    if (req.method === "OPTIONS" && req.headers["access-control-request-method"] !== undefined) {
      res.set({
        "Access-Control-Allow-Methods": ALLOWED_METHODS,
        "Access-Control-Allow-Headers": ALLOWED_HEADERS,
        "Access-Control-Max-Age": PREFLIGHT_MAX_AGE_SECONDS,
      });
      res.status(204).end();
      return;
    }
    next();
  };
}

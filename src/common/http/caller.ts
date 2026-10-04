import type { Request } from "express";
import type { Session } from "../../auth/core/verifier.js";
import type { Config } from "../../config/core/config.js";
import { clientIp } from "../core/clientIp.js";
import type { Caller } from "../core/quota.js";

/** A request once the guard has verified its token. */
export type SessionRequest = Request & { session?: Session };

/** The address the request arrived from, as a rate limit key. */
export function ipOf(req: Request, config: Config): string {
  return clientIp({
    trustedProxyHops: config.trustedProxyHops,
    socketAddress: req.socket.remoteAddress,
    header: (name) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value.join(",") : value;
    },
  });
}

/** Who is asking, as rate limits count them. Only ever a key of an in-memory counter. */
export function callerOf(req: SessionRequest, config: Config): Caller {
  if (!req.session) throw new Error("No session on a route that requires one.");
  return { sessionId: req.session.sessionId, ip: ipOf(req, config) };
}

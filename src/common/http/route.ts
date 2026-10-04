import type { Request } from "express";

/**
 * The route a request matched, as its pattern: `POST /v1/history/:symbol/:range`,
 * never the path that was asked for. A path can carry a symbol and a query
 * string anything at all, so neither is ever logged.
 */
export function routeOf(req: Request): string {
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof pattern === "string") return `${req.method} ${pattern}`;
  if (req.path === "/docs" || req.path.startsWith("/docs/") || req.path === "/docs-json") {
    return `${req.method} /docs`;
  }
  return "unmatched";
}

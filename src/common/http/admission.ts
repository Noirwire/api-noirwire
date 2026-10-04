import { Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import type { Config } from "../../config/core/config.js";
import { CONFIG, QUOTAS } from "../../tokens.js";
import { admit, type Admitted } from "../core/admit.js";
import { routeBudgets, type Budget, type QuotaStore, type RouteLimits } from "../core/quota.js";
import { callerOf, type SessionRequest } from "./caller.js";

export type RouteRule = { route: string; limits: RouteLimits; maxBodyBytes: number };

/** Admits a request to a route: its budgets, then its body, read with a size cap and a deadline. */
@Injectable()
export class Admission {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(QUOTAS) private readonly quotas: QuotaStore,
  ) {}

  /** For a route behind a session: counted per session, per address and in total. */
  forSession(req: SessionRequest, rule: RouteRule): Promise<Admitted> {
    const budgets = routeBudgets(rule.route, callerOf(req, this.config), rule.limits);
    return this.with(req, budgets, rule.maxBodyBytes);
  }

  with(req: Request, budgets: readonly Budget[], maxBodyBytes: number): Promise<Admitted> {
    const length = req.headers["content-length"];
    return admit({ contentLength: length, body: req }, { budgets, maxBodyBytes }, this.quotas);
  }
}

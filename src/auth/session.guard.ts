import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { rateRefusal, refusal } from "../common/core/answer.js";
import { MINUTE_MS, type QuotaStore } from "../common/core/quota.js";
import { ipOf, type SessionRequest } from "../common/http/caller.js";
import { ApiRefusal } from "../common/http/refusal.js";
import type { Config } from "../config/core/config.js";
import { CONFIG, QUOTAS, VERIFIER } from "../tokens.js";
import { AuthError, bearerToken, type Verifier } from "./core/verifier.js";
import { IS_PUBLIC } from "./public.decorator.js";

/**
 * Tokens are checked for at most this many requests a minute from one
 * address, valid or not, so that verifying signatures cannot be made this
 * server's main occupation. Far above what the route limits allow together.
 */
export const VERIFICATIONS_PER_MINUTE_PER_IP = 12_000;

const CHALLENGE = { "WWW-Authenticate": "Bearer" };

/**
 * Every route requires `Authorization: Bearer <token>` with a session this
 * project issued, unless it is marked public. Applied globally, so a new
 * route is closed until someone says otherwise.
 *
 * Nothing of the token is kept past the request: its session id becomes the
 * key of a counter and is never stored or logged.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(QUOTAS) private readonly quotas: QuotaStore,
    @Inject(VERIFIER) private readonly verify: Verifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<SessionRequest>();
    const token = bearerToken(req.headers.authorization);
    if (!token) throw new ApiRefusal(refusal("unauthorized", CHALLENGE));

    const budget = {
      scope: "ip" as const,
      key: `verify|${ipOf(req, this.config)}`,
      limit: VERIFICATIONS_PER_MINUTE_PER_IP,
      windowMs: MINUTE_MS,
    };
    if (!this.quotas.take([budget])) throw new ApiRefusal(rateRefusal());

    try {
      req.session = await this.verify(token);
      return true;
    } catch (error) {
      const failure = error instanceof AuthError ? error.failure : "unavailable";
      if (failure === "unavailable") throw new ApiRefusal(refusal("unavailable"));
      throw new ApiRefusal(refusal(failure, CHALLENGE));
    }
  }
}

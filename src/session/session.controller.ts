import { Controller, Inject, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { Public } from "../auth/public.decorator.js";
import { HOUR_MS, MINUTE_MS, type Budget } from "../common/core/quota.js";
import { Admission } from "../common/http/admission.js";
import { ApiErrors, EXAMPLE, ok } from "../common/http/api-docs.js";
import { ipOf } from "../common/http/caller.js";
import { send } from "../common/http/send.js";
import type { Config } from "../config/core/config.js";
import { CONFIG, SESSIONS } from "../tokens.js";
import type { Sessions } from "./core/sessions.js";

/**
 * Starting a session is the one thing anyone can ask for without a token,
 * and each one is a new set of quotas, so it is rationed harder than
 * anything else: per address and in total, by the hour, at limits the
 * operator sets. A wallet starts one only when it has none or its last was
 * retired; everything else is a refresh.
 */
export const SESSION_REFRESH_LIMITS = { perIpPerMinute: 60, totalPerMinute: 1_200 };
const START_MAX_BODY_BYTES = 1024;
const REFRESH_MAX_BODY_BYTES = 2 * 1024;

const startBudgets = (ip: string, limits: Config["sessionStarts"]): Budget[] => [
  { scope: "ip", key: `session-start|${ip}`, limit: limits.perIpPerHour, windowMs: HOUR_MS },
  { scope: "global", key: "session-start", limit: limits.perHour, windowMs: HOUR_MS },
];

const refreshBudgets = (ip: string): Budget[] => [
  {
    scope: "ip",
    key: `session-refresh|${ip}`,
    limit: SESSION_REFRESH_LIMITS.perIpPerMinute,
    windowMs: MINUTE_MS,
  },
  {
    scope: "global",
    key: "session-refresh",
    limit: SESSION_REFRESH_LIMITS.totalPerMinute,
    windowMs: MINUTE_MS,
  },
];

const SESSION_EXAMPLE = {
  accessToken: EXAMPLE.token,
  refreshToken: EXAMPLE.refreshToken,
  expiresAt: 1790000000,
};

const WHAT_A_SESSION_IS = [
  "**What a session proves:** that this API issued it and that it has not expired. **What it does not prove:** anything about who holds it. It is not a login and not an identity: it carries no wallet, no email and no device, anyone can have one for the asking, and anyone can have another. It exists so that requests can be counted per caller instead of only per address. It is a quota bucket.",
  "",
  "**The wallet never talks to the identity provider.** This server asks Supabase Auth for the anonymous session, so Supabase sees this server's address and never the caller's, and nothing of the caller's request is passed on to it.",
].join("\n");

const RATIONED = {
  why: "This address's quota, or the total, is spent, or the identity provider itself is rate limiting. Wait and retry with backoff.",
  codes: { rate_limited: "Quota spent" },
} as const;

const KEY_REFUSED = {
  why: "The identity provider refused this server's own key (it answered 401 or 403). That is an operator's to fix and is logged as such. It is never passed on as a 401, which here always means the caller's own session.",
  codes: { upstream_refused: "The identity provider refused this server's key" },
} as const;

const NO_PROVIDER = {
  why: "The identity provider could not be reached, failed, or issued something this API would not accept. No session was handed out.",
  codes: { unavailable: "Session service unavailable" },
} as const;

const SESSION_SHAPE = {
  type: "object" as const,
  required: ["accessToken", "refreshToken", "expiresAt"],
  properties: {
    accessToken: {
      type: "string" as const,
      description: "Send as `Authorization: Bearer <accessToken>` on every other route.",
    },
    refreshToken: {
      type: "string" as const,
      description: "Exchange at `POST /v1/session/refresh` for a new pair. Single use.",
    },
    expiresAt: {
      type: "integer" as const,
      description:
        "When the access token expires, as Unix time in SECONDS (not milliseconds). About an hour after it was issued.",
    },
  },
};

const session = (description: string) =>
  ok(description, SESSION_SHAPE, {
    session: { summary: "A session (dummy values)", value: SESSION_EXAMPLE },
  });

@ApiTags("Session")
@Controller("v1/session")
export class SessionController {
  constructor(
    private readonly admission: Admission,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(SESSIONS) private readonly sessions: Sessions,
  ) {}

  @Public()
  @Post()
  @ApiOperation({
    summary: "Start an anonymous session",
    description: [
      "Hands out the token every other `/v1` route asks for. Needs no token itself and takes no input: any body is ignored.",
      "",
      "**Who calls it:** a wallet with no session, or one whose session was refused as `session_expired` or `session_invalid`. In every other case a wallet renews the session it has with `POST /v1/session/refresh`: starting sessions is rationed far harder than renewing them.",
      "",
      WHAT_A_SESSION_IS,
      "",
      "**What comes back:** `{ accessToken, refreshToken, expiresAt }`. `accessToken` is sent as `Authorization: Bearer <accessToken>`. `expiresAt` is the moment it expires, as Unix time in **seconds** (not milliseconds), about an hour on. `refreshToken` is exchanged for a new pair at `POST /v1/session/refresh`. Keep both in memory or in the wallet's own storage; they are worth one quota bucket and nothing else.",
      "",
      "**Contains wallet addresses: no.** Nothing about a wallet is asked for, and a session is never tied to one.",
      "",
      "**Quotas:** per hour, 10 per client address and 600 in total unless the operator has configured otherwise (`SESSION_STARTS_PER_IP_PER_HOUR`, `SESSION_STARTS_PER_HOUR`). Past either the answer is `429 rate_limited`.",
      "",
      "**The client address** is the one the hosting platform reports. One operator mechanism exists beside it and is not for third parties: the web app's own server, which forwards its pages' requests, proves itself with a shared secret in `X-NoirWire-Edge` and reports the browser's address in `X-NoirWire-Client-IP`, so web users are counted by their own address and not by that server's. Without the matching secret both headers are ignored.",
      "",
      "**Kept by this API:** nothing. The session lives at the identity provider as an anonymous user with no attributes. This server holds a counter per session for at most an hour and writes it nowhere.",
    ].join("\n"),
  })
  @session("A new session. `expiresAt` is Unix time in seconds.")
  @ApiErrors({
    body: START_MAX_BODY_BYTES,
    own: { 429: RATIONED, 502: KEY_REFUSED, 503: NO_PROVIDER },
  })
  async start(@Req() req: Request, @Res() res: Response): Promise<void> {
    const budgets = startBudgets(ipOf(req, this.config), this.config.sessionStarts);
    const admitted = await this.admission.with(req, budgets, START_MAX_BODY_BYTES);
    if ("refused" in admitted) return send(res, admitted.refused);
    send(res, await this.sessions.start());
  }

  @Public()
  @Post("refresh")
  @ApiOperation({
    summary: "Renew a session, until it is too old to renew",
    description: [
      "Exchanges a refresh token for a new access token and a new refresh token. The old refresh token stops working. Needs no access token: the refresh token is the credential.",
      "",
      "**Who calls it:** a wallet whose access token is about to expire.",
      "",
      "**What comes back:** the same shape as `POST /v1/session`, `{ accessToken, refreshToken, expiresAt }`, with `expiresAt` in Unix **seconds**.",
      "",
      "**Sessions are short-lived on purpose.** A session older than this deployment's maximum age (24 hours unless configured otherwise) is not renewed, however valid its refresh token: the answer is `401` with code `session_expired`, the wallet starts a fresh session with `POST /v1/session`, and the key that joined its requests together is replaced by an unrelated one. The same age limit is applied to access tokens on every other route.",
      "",
      WHAT_A_SESSION_IS,
      "",
      "**Contains wallet addresses: no.**",
      "",
      "**Quotas:** 60 a minute per address; 1,200 a minute in total.",
    ].join("\n"),
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["refreshToken"],
      additionalProperties: false,
      properties: { refreshToken: { type: "string", maxLength: 512 } },
    },
    examples: {
      refresh: { summary: "Renew (dummy value)", value: { refreshToken: EXAMPLE.refreshToken } },
    },
  })
  @session("The renewed session. Replace both tokens. `expiresAt` is Unix time in seconds.")
  @ApiErrors({
    body: REFRESH_MAX_BODY_BYTES,
    own: {
      400: {
        why: "The body is not JSON, or is not exactly `{ refreshToken }`.",
        codes: { invalid_request: "Malformed request, or a query string" },
      },
      401: {
        why: "The session is not accepted and cannot be renewed. Either way the wallet starts a new one with `POST /v1/session`.",
        codes: {
          session_expired: "The session is past its maximum age",
          session_invalid: "The refresh token is unknown, already used or revoked",
        },
      },
      429: RATIONED,
      502: KEY_REFUSED,
      503: NO_PROVIDER,
    },
  })
  async refresh(@Req() req: Request, @Res() res: Response): Promise<void> {
    const budgets = refreshBudgets(ipOf(req, this.config));
    const admitted = await this.admission.with(req, budgets, REFRESH_MAX_BODY_BYTES);
    if ("refused" in admitted) return send(res, admitted.refused);
    send(res, await this.sessions.refresh(admitted.body));
  }
}

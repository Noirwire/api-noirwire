import { Controller, Inject, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { Public } from "../auth/public.decorator.js";
import { HOUR_MS, MINUTE_MS, type Budget } from "../common/core/quota.js";
import { Admission } from "../common/http/admission.js";
import { BodyLimits, errorResponse, EXAMPLE } from "../common/http/api-docs.js";
import { ipOf } from "../common/http/caller.js";
import { send } from "../common/http/send.js";
import type { Config } from "../config/core/config.js";
import { CONFIG, SESSIONS } from "../tokens.js";
import type { Sessions } from "./core/sessions.js";

/**
 * Starting a session is the one thing anyone can ask for without a token,
 * and each one is a new set of quotas, so it is rationed harder than
 * anything else: per address, and in total.
 */
export const SESSION_START_LIMITS = {
  perIpPerMinute: 20,
  perIpPerHour: 300,
  totalPerMinute: 300,
  totalPerHour: 6_000,
};
export const SESSION_REFRESH_LIMITS = { perIpPerMinute: 60, totalPerMinute: 1_200 };
const START_MAX_BODY_BYTES = 1024;
const REFRESH_MAX_BODY_BYTES = 2 * 1024;

const startBudgets = (ip: string): Budget[] => [
  {
    scope: "ip",
    key: `session-start|minute|${ip}`,
    limit: SESSION_START_LIMITS.perIpPerMinute,
    windowMs: MINUTE_MS,
  },
  {
    scope: "ip",
    key: `session-start|hour|${ip}`,
    limit: SESSION_START_LIMITS.perIpPerHour,
    windowMs: HOUR_MS,
  },
  {
    scope: "global",
    key: "session-start|minute",
    limit: SESSION_START_LIMITS.totalPerMinute,
    windowMs: MINUTE_MS,
  },
  {
    scope: "global",
    key: "session-start|hour",
    limit: SESSION_START_LIMITS.totalPerHour,
    windowMs: HOUR_MS,
  },
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

const UNAVAILABLE = errorResponse(
  503,
  "The identity provider could not be reached, failed, or issued something this API would not accept. No session was handed out.",
  { unavailable: "Session service unavailable" },
);

const KEY_REFUSED = errorResponse(
  502,
  "The identity provider refused this server's own key (it answered 401 or 403). That is an operator's to fix and is logged as such. It is never passed on as a 401, which here always means the caller's own session.",
  { upstream_refused: "The identity provider refused this server's key" },
);

const RATE_LIMITED = errorResponse(
  429,
  "This address's quota, or the total, is spent, or the identity provider itself is rate limiting. Wait and retry with backoff.",
  { rate_limited: "Quota spent" },
);

const FOREIGN_ORIGIN = errorResponse(
  403,
  "The request names an `Origin` that is not on this API's list.",
  { origin_not_allowed: "Foreign origin" },
);

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
  ApiResponse({
    status: 200,
    description,
    content: {
      "application/json": {
        schema: SESSION_SHAPE,
        examples: { session: { summary: "A session (dummy values)", value: SESSION_EXAMPLE } },
      },
    },
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
      "**Who calls it:** a wallet with no session, or one whose session was refused as expired or invalid.",
      "",
      WHAT_A_SESSION_IS,
      "",
      "**What comes back:** `{ accessToken, refreshToken, expiresAt }`. `accessToken` is sent as `Authorization: Bearer <accessToken>`. `expiresAt` is the moment it expires, as Unix time in **seconds** (not milliseconds), about an hour on. `refreshToken` is exchanged for a new pair at `POST /v1/session/refresh`. Keep both in memory or in the wallet's own storage; they are worth one quota bucket and nothing else.",
      "",
      "**Contains wallet addresses: no.** Nothing about a wallet is asked for, and a session is never tied to one.",
      "",
      "**Quotas:** 20 a minute and 300 an hour per address; 300 a minute and 6,000 an hour in total.",
      "",
      "**Kept by this API:** nothing. The session lives at the identity provider as an anonymous user with no attributes. This server holds a counter per session for at most an hour and writes it nowhere.",
    ].join("\n"),
  })
  @session("A new session. `expiresAt` is Unix time in seconds.")
  @FOREIGN_ORIGIN
  @RATE_LIMITED
  @KEY_REFUSED
  @UNAVAILABLE
  @BodyLimits(START_MAX_BODY_BYTES)
  async start(@Req() req: Request, @Res() res: Response): Promise<void> {
    const budgets = startBudgets(ipOf(req, this.config));
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
  @errorResponse(400, "The body is not JSON, or is not exactly `{ refreshToken }`.", {
    invalid_request: "Malformed request",
  })
  @errorResponse(
    401,
    "The session is not accepted and cannot be renewed. Either way the wallet starts a new one with `POST /v1/session`.",
    {
      session_expired: "The session is past its maximum age",
      session_invalid: "The refresh token is unknown, already used or revoked",
    },
  )
  @FOREIGN_ORIGIN
  @RATE_LIMITED
  @KEY_REFUSED
  @UNAVAILABLE
  @BodyLimits(REFRESH_MAX_BODY_BYTES)
  async refresh(@Req() req: Request, @Res() res: Response): Promise<void> {
    const budgets = refreshBudgets(ipOf(req, this.config));
    const admitted = await this.admission.with(req, budgets, REFRESH_MAX_BODY_BYTES);
    if ("refused" in admitted) return send(res, admitted.refused);
    send(res, await this.sessions.refresh(admitted.body));
  }
}

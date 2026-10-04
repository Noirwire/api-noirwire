import { Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Admission } from "../common/http/admission.js";
import { ApiErrors } from "../common/http/api-docs.js";
import type { SessionRequest } from "../common/http/caller.js";
import { send } from "../common/http/send.js";
import type { Config } from "../config/core/config.js";
import { CONFIG } from "../tokens.js";
import {
  ANALYTICS_TIMEOUT_MS,
  EVENT_LIMITS,
  EVENT_MAX_BODY_BYTES,
  forwardedEvent,
} from "./core/forward.js";

@ApiTags("Usage events")
@Controller("v1/events")
export class EventsController {
  constructor(
    private readonly admission: Admission,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({
    summary: "Report one usage event from the closed list",
    description: [
      "The only way a usage event leaves a wallet. The event is checked against a closed list of screens, event names and values, rebuilt field by field from that list, and forwarded to NoirWire's own analytics server (a self-hosted Umami). If analytics is not configured, nothing is sent anywhere.",
      "",
      "**Who calls it:** the wallets, only while the user has analytics switched on.",
      "",
      "**What an event may say:** a screen path with ids removed (`/portfolios/:id`, never a portfolio's id), optionally a display size, and either where a first visit came from (a source, medium and campaign from approved lists) or one named event with values from fixed sets: bands and yes/no answers, never an exact count, an asset, a size, an address or free text. Any unknown field, name or value makes the whole event disappear.",
      "",
      "**Contains wallet addresses: no,** and the list leaves no field one could be put in.",
      "",
      "**Forwarded to the analytics server:** the rebuilt event, the site's host name, the caller's browser name, and a one-way code derived from the session and the month with a secret only this server holds, which counts visits and cannot be turned back into a session. Without that secret no code is sent. **Never forwarded:** the caller's IP, token or session id, a country, or anything the wallet wrote freely.",
      "",
      "**Events that coincide with a transaction** (a trade placed or failed, funding, a send, an Earn action) are forwarded with no visitor code, no browser name and no display size, so they add to a total and cannot be matched to a visit or to a transaction.",
      "",
      "**Always answers 204** once the session is verified, whatever happened: analytics off, a refused event, a spent quota, an oversized body or an analytics server that is down. The response says nothing, so it cannot be used to probe the list.",
      "",
      "**Quotas (per minute):** 120 per session, 2,400 per address, 12,000 in total. Past them the event is dropped, still with a 204.",
    ].join("\n"),
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "A screen path from the closed list." },
        display: { type: "string", description: "Display size, such as 390x844." },
        arrival: {
          type: "object",
          description: "Page views only: where the first visit came from.",
          properties: {
            source: { type: "string" },
            medium: { type: "string" },
            campaign: { type: "string" },
          },
        },
        name: { type: "string", description: "An event name from the closed list." },
        data: { type: "object", description: "Exactly the fields that event carries." },
      },
    },
    examples: {
      view: { summary: "A screen view", value: { path: "/markets/:symbol", display: "390x844" } },
      event: {
        summary: "A named event",
        value: { path: "/portfolios/:id", name: "account_created", data: { kind: "pie" } },
      },
    },
  })
  @ApiResponse({
    status: 204,
    description: "Always, once the session is verified. No body. Says nothing about what was done.",
  })
  @ApiErrors({ session: true })
  async report(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    const done = () => send(res, { status: 204, body: null });
    const { analytics } = this.config;
    if (!analytics || !req.session) return done();
    const admitted = await this.admission.forSession(req, {
      route: "events",
      limits: EVENT_LIMITS,
      maxBodyBytes: EVENT_MAX_BODY_BYTES,
    });
    if ("refused" in admitted) return done();
    const forwarded = forwardedEvent(
      admitted.body,
      { sessionId: req.session.sessionId, browser: req.headers["user-agent"] },
      analytics,
      Date.now(),
    );
    if (!forwarded) return done();
    await fetch(forwarded.url, {
      method: "POST",
      headers: forwarded.headers,
      body: forwarded.body,
      signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS),
      redirect: "error",
    })
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
    done();
  }
}

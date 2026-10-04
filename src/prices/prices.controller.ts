import { Controller, Get, Inject, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { answer, refusal } from "../common/core/answer.js";
import type { Cached } from "../common/core/cached.js";
import type { RouteLimits } from "../common/core/quota.js";
import { Admission } from "../common/http/admission.js";
import { errorResponse, jsonResponse, SessionRequired } from "../common/http/api-docs.js";
import type { SessionRequest } from "../common/http/caller.js";
import { send } from "../common/http/send.js";
import { LIVE_PRICES } from "../tokens.js";
import type { LivePrice } from "./core/liveSource.js";

/** A wallet asks every thirty seconds while a screen that shows prices is open. */
export const PRICES_LIMITS: RouteLimits = { perSession: 120, perIp: 2_400, total: 30_000 };

@ApiTags("Market data")
@Controller("v1/prices")
export class PricesController {
  constructor(
    private readonly admission: Admission,
    @Inject(LIVE_PRICES) private readonly prices: () => Promise<Cached<Record<string, LivePrice>>>,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Live prices of every listed asset",
    description: [
      "Every listed tracker's price and SOL's, in dollars, keyed by symbol, with the change over 24 hours. Read from Jupiter's price index, the venue every trade is routed through, so the price on a row and the price at review come from one source.",
      "",
      "**Who calls it:** the wallets, every thirty seconds while a screen that shows prices is open.",
      "",
      "**Read once for everyone.** The index is read at most once every thirty seconds, however many callers ask; a copy up to thirty seconds past that is still served while a fresh one is fetched. The `Age` header says how many seconds old the prices are. A failed read is never kept. Responses are never cached on the way (`Cache-Control: no-store`).",
      "",
      "**Contains wallet addresses: no.** The request carries nothing, and the same answer goes to everyone. **Received by:** Jupiter, which is asked for the listed mints by this server on its own schedule, not per caller, so it learns nothing about who asked.",
      "",
      "**Refused:** any query string (404): the route takes none.",
      "",
      "**Quotas (per minute):** 120 per session, 2,400 per address, 30,000 in total.",
    ].join("\n"),
  })
  @jsonResponse(200, "The prices, by symbol. An asset the index did not price is absent.", {
    prices: {
      summary: "Prices",
      value: {
        prices: { SOL: { usd: 150.12, change24h: -1.2 }, NVDAx: { usd: 764.15, change24h: 0.33 } },
      },
    },
  })
  @errorResponse(404, "The request carries a query string.", {
    not_found: "Query string present",
  })
  @errorResponse(502, "The price index could not be read at all.", {
    upstream_failed: "Index unavailable",
  })
  @SessionRequired()
  async get(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    if (req.originalUrl.includes("?")) return send(res, refusal("not_found"));
    const admitted = await this.admission.forSession(req, {
      route: "prices",
      limits: PRICES_LIMITS,
      maxBodyBytes: 0,
    });
    if ("refused" in admitted) return send(res, admitted.refused);
    try {
      const { value, ageSeconds } = await this.prices();
      send(res, answer(200, { prices: value }, { Age: String(ageSeconds) }));
    } catch {
      send(res, refusal("upstream_failed"));
    }
  }
}

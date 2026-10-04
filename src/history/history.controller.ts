import { Controller, Get, Inject, Param, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { answer, refusal } from "../common/core/answer.js";
import { createCache, type Cached } from "../common/core/cached.js";
import type { RouteLimits } from "../common/core/quota.js";
import { Admission } from "../common/http/admission.js";
import { errorResponse, jsonResponse, SessionRequired } from "../common/http/api-docs.js";
import type { SessionRequest } from "../common/http/caller.js";
import { send } from "../common/http/send.js";
import type { Config } from "../config/core/config.js";
import { CONFIG } from "../tokens.js";
import {
  loadPriceHistory,
  PRICE_RANGES,
  SERIES_TTL_SECONDS,
  seriesOf,
  STALE_FACTOR,
} from "./core/historySource.js";

/** A markets screen draws a sparkline for every listed stock at once. */
export const HISTORY_LIMITS: RouteLimits = { perSession: 600, perIp: 6_000, total: 30_000 };

class NoHistory extends Error {}

@ApiTags("Market data")
@Controller("v1/history")
export class HistoryController {
  /** One cache per listed stock and range: a bounded set, whatever is asked for. */
  private readonly series = new Map<string, () => Promise<Cached<number[]>>>();

  constructor(
    private readonly admission: Admission,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get(":symbol/:range")
  @ApiParam({ name: "symbol", description: "A listed tracker's symbol.", example: "NVDAx" })
  @ApiParam({ name: "range", enum: PRICE_RANGES, description: "One day, one week or one month." })
  @ApiOperation({
    summary: "One tracker's price history over one range",
    description: [
      "Candle closes for a listed tracker, oldest first: hourly for `1D`, four-hourly for `1W`, daily for `1M`. Read from Jupiter's chart data. Only candles inside the asked window are kept and they are put in order here, so a response for another period cannot be drawn as this one.",
      "",
      "**Who calls it:** the wallets, for charts and sparklines.",
      "",
      "**Read once for everyone.** A series is read from the source at most once per 5 minutes (`1D`), 30 minutes (`1W`) or 6 hours (`1M`), however many callers ask, and a stale copy stands in for a while as a fresh one is fetched. The `Age` header says how many seconds old the series is. A failure is never kept.",
      "",
      "**Contains wallet addresses: no.** The path names a public symbol, not an account. **Received by:** Jupiter, which is asked for a listed mint's candles by this server, not per caller. Which tracker a caller looked at is never logged: the log records the route's pattern, not the symbol.",
      "",
      "**Refused:** a symbol that is not a listed tracker, a range other than the three, or any query string (all 404).",
      "",
      "**Quotas (per minute):** 600 per session, 6,000 per address, 30,000 in total.",
    ].join("\n"),
  })
  @jsonResponse(200, "The closes, oldest first. At least two.", {
    series: { summary: "A series", value: { points: [761.2, 762.9, 764.15] } },
  })
  @errorResponse(
    404,
    "Not a listed tracker or range, a query string is present, or the source has no usable history for it.",
    { not_found: "Nothing to draw" },
  )
  @errorResponse(502, "The chart source could not be read.", {
    upstream_failed: "Source unavailable",
  })
  @SessionRequired()
  async get(
    @Param("symbol") symbol: string,
    @Param("range") range: string,
    @Req() req: SessionRequest,
    @Res() res: Response,
  ): Promise<void> {
    const none = () => send(res, refusal("not_found"));
    const named = req.originalUrl.includes("?") ? null : seriesOf(symbol, range);
    if (!named) return none();
    const admitted = await this.admission.forSession(req, {
      route: "history",
      limits: HISTORY_LIMITS,
      maxBodyBytes: 0,
    });
    if ("refused" in admitted) return send(res, admitted.refused);
    try {
      const { value, ageSeconds } = await this.cacheFor(named)();
      send(res, answer(200, { points: value }, { Age: String(ageSeconds) }));
    } catch (error) {
      if (error instanceof NoHistory) return none();
      send(res, refusal("upstream_failed"));
    }
  }

  private cacheFor({ stock, range }: NonNullable<ReturnType<typeof seriesOf>>) {
    const key = `${stock.symbol}:${range}`;
    let cache = this.series.get(key);
    if (!cache) {
      const ttlMs = SERIES_TTL_SECONDS[range] * 1000;
      cache = createCache({
        load: async () => {
          const points = await loadPriceHistory(stock, range, {
            url: this.config.priceHistoryUrl,
            fetch,
          });
          // No usable history is an answer for this request, and is not kept.
          if (!points) throw new NoHistory();
          return points;
        },
        ttlMs,
        staleMs: ttlMs * STALE_FACTOR,
      });
      this.series.set(key, cache);
    }
    return cache;
  }
}

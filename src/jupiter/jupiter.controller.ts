import { Controller, Get, Inject, Param, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { busyRefusal, refusal } from "../common/core/answer.js";
import { PROVIDER_RETRY_AFTER_SECONDS, type ProviderGate } from "../common/core/providerGate.js";
import type { Relay } from "../common/core/relay.js";
import { Admission } from "../common/http/admission.js";
import { ApiErrors, EXAMPLE, ok, passedThrough } from "../common/http/api-docs.js";
import { callerOf, type SessionRequest } from "../common/http/caller.js";
import { send } from "../common/http/send.js";
import type { Config } from "../config/core/config.js";
import { CONFIG, JUPITER_GATE, RELAY } from "../tokens.js";
import {
  JUPITER_ROUTES,
  jupiterLimits,
  JUPITER_MAX_BODY_BYTES,
  JUPITER_MAX_RESPONSE_BYTES,
  jupiterRoute,
  planJupiter,
} from "./core/jupiter.js";

const SHARED = [
  "**Received by:** Jupiter, which sees the portfolio that trades or lends, from this server's address and never the caller's. The funding wallet is never part of these requests.",
  "",
  "**Forwarded upstream:** the listed fields or the body, a fixed user agent and this server's Jupiter API key. **Not forwarded:** the caller's IP, token, session id, origin, referer, cookies or browser name, or any query string. **Returned:** Jupiter's status and body, only when the body is JSON and at most 1 MB; none of its headers.",
  "",
  "**Quotas follow Jupiter's allowance.** This server sends Jupiter fewer requests a second than Jupiter allows its key (`JUPITER_PROVIDER_RPS`, 5 unless configured), across every Jupiter path and its own price reads. Requests wait in a line per session, served in turn; one that would wait more than about 400 ms is answered `429 rate_limited` with `Retry-After`. Per minute, a session may take at most half of what that rate allows and an address at most all of it (at the default: 150 and 300).",
  "",
  "**Logged:** the route pattern, the status and the duration. Never the path's fields, an address or a transaction.",
].join("\n");

const NOT_LISTED = {
  why: "The path, or the method on that path, is not one the wallets use. This is not an open proxy: nothing else is forwarded anywhere.",
  codes: { not_found: "Unlisted path or method" },
} as const;

const pathOf = (method: "GET" | "POST") =>
  ApiParam({
    name: "path",
    description:
      "The Jupiter path, exactly as written. These are the only ones this method takes; the slashes are part of the path and are not escaped.",
    enum: Object.keys(JUPITER_ROUTES)
      .filter((route) => route.startsWith(`${method} `))
      .map((route) => route.slice(method.length + 1)),
  });

@ApiTags("Jupiter")
@Controller("v1/jupiter")
export class JupiterController {
  constructor(
    private readonly admission: Admission,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(RELAY) private readonly relay: Relay,
    @Inject(JUPITER_GATE) private readonly gate: ProviderGate,
  ) {}

  @Get("*path")
  @pathOf("GET")
  @ApiOperation({
    summary: "Jupiter: the list of lending vaults",
    description: [
      "The wallets' only way to Jupiter for reads that name nobody. One path is allowed with GET:",
      "",
      "| Path | What it is |",
      "| --- | --- |",
      "| `lend/v1/earn/tokens` | The Jupiter Lend vaults and their rates |",
      "",
      "**Who calls it:** the wallets' Earn screen.",
      "",
      "**Refused:** any other path (404). As on every route, a query string is refused (400): the wallet sends none, so none is ever passed on.",
      "",
      "**Contains wallet addresses: no.**",
      "",
      SHARED,
    ].join("\n"),
  })
  @ok(
    "Jupiter's answer, passed back as it came.",
    {
      type: "array",
      description: "The Jupiter Lend vaults, as Jupiter lists them.",
      items: passedThrough("One vault, as Jupiter describes it.", {
        symbol: { type: "string", description: "The vault's asset." },
      }),
    },
    { vaults: { summary: "Vault list (shape is Jupiter's)", value: [{ symbol: "USDC" }] } },
  )
  @ApiErrors({ session: true, upstream: "Jupiter", own: { 404: NOT_LISTED } })
  get(@Param("path") path: string | string[], @Req() req: SessionRequest, @Res() res: Response) {
    return this.handle("GET", path, req, res);
  }

  @Post("*path")
  @pathOf("POST")
  @ApiOperation({
    summary: "Jupiter: quote, order, land a swap, lend",
    description: [
      "The wallets' only way to Jupiter for trades and for Jupiter Lend. These paths are allowed with POST:",
      "",
      "| Path | Sent to Jupiter as | Body |",
      "| --- | --- | --- |",
      "| `swap/v2/order` | GET with a query | Only `inputMint`, `outputMint`, `amount`, `taker`, `slippageBps`, `referralAccount`, `referralFee`, all strings |",
      "| `swap/v2/execute` | POST, body unchanged | A signed swap and its request id |",
      "| `lend/v1/earn/earnings` | GET with a query | Only `user`, `positions`, both strings |",
      "| `lend/v1/earn/deposit` | POST, body unchanged | Jupiter Lend's deposit request |",
      "| `lend/v1/earn/withdraw` | POST, body unchanged | Jupiter Lend's withdraw request |",
      "| `lend/v1/earn/deposit-instructions` | POST, body unchanged | The same deposit, as instructions |",
      "| `lend/v1/earn/withdraw-instructions` | POST, body unchanged | The same withdrawal, as instructions |",
      "",
      "Jupiter takes an order and an earnings read as a GET with the address in the query. The wallet still posts them here as a JSON body and the query is built on this side, so an address never sits in a URL that an access log on the way would record.",
      "",
      "**Who calls it:** the wallets, when a trade is quoted, reviewed and placed, and on the Earn screen.",
      "",
      "**Refused:** any other path or method (404); for the two paths that become a query, a body that is not a flat object of the listed string fields (400), which is what stops a request from naming a separate payer, a receiver or a router.",
      "",
      "**Contains wallet addresses: yes.** An order names the portfolio as `taker`; an earnings read names it as `user`; a signed swap is a whole transaction.",
      "",
      SHARED,
    ].join("\n"),
  })
  @ApiBody({
    description: "The fields of the listed path. Shown: an order.",
    schema: { type: "object" },
    examples: {
      order: {
        summary: "An order (swap/v2/order)",
        value: {
          inputMint: EXAMPLE.mint,
          outputMint: EXAMPLE.mint,
          amount: "10000000",
          taker: EXAMPLE.address,
          slippageBps: "50",
        },
      },
      execute: {
        summary: "Land a signed swap (swap/v2/execute)",
        value: { signedTransaction: EXAMPLE.transaction, requestId: "example-request-id" },
      },
    },
  })
  @ok(
    "Jupiter's answer, passed back as it came. Jupiter's own errors also arrive as Jupiter wrote them, with whatever status it used, except 401, 403 and 429 (see 502 and 429).",
    passedThrough(
      "Jupiter's own response for the path asked, unchanged. The fields the wallets read are named here; Jupiter may send others.",
      {
        transaction: {
          type: "string",
          nullable: true,
          description:
            "Orders and lending: the unsigned transaction to review and sign, base64. Null on an order that names no taker.",
        },
        requestId: { type: "string", description: "Orders: sent back when the swap is landed." },
        inAmount: {
          type: "string",
          description: "Orders: what is spent, in raw units of the input mint.",
        },
        outAmount: {
          type: "string",
          description: "Orders: what is expected back, in raw units of the output mint.",
        },
        status: { type: "string", description: "Landing a swap: `Success` or `Failed`." },
        signature: { type: "string", description: "Landing a swap: the transaction's id, base58." },
      },
    ),
    {
      order: {
        summary: "An order (shape is Jupiter's)",
        value: {
          transaction: EXAMPLE.transaction,
          requestId: "example-request-id",
          inAmount: "10000000",
          outAmount: "65432100",
        },
      },
      landed: {
        summary: "A landed swap (shape is Jupiter's)",
        value: { status: "Success", signature: EXAMPLE.signature },
      },
    },
  )
  @ApiErrors({
    session: true,
    body: JUPITER_MAX_BODY_BYTES,
    upstream: "Jupiter",
    own: {
      400: {
        why: "The body of a path that becomes a query is not a flat object of its listed string fields.",
        codes: { invalid_request: "Unknown or non-string field, or a query string" },
      },
      404: NOT_LISTED,
    },
  })
  post(@Param("path") path: string | string[], @Req() req: SessionRequest, @Res() res: Response) {
    return this.handle("POST", path, req, res);
  }

  private async handle(
    method: "GET" | "POST",
    segments: string | string[],
    req: SessionRequest,
    res: Response,
  ): Promise<void> {
    const path = Array.isArray(segments) ? segments.join("/") : segments;
    const route = jupiterRoute(method, path);
    if (!route) return send(res, refusal("not_found"));

    const admitted = await this.admission.forSession(req, {
      route: "jupiter",
      limits: jupiterLimits(this.config.jupiterProviderRps),
      maxBodyBytes: JUPITER_MAX_BODY_BYTES,
    });
    if ("refused" in admitted) return send(res, admitted.refused);

    const plan = planJupiter(route, method, path, admitted.body);
    if ("refused" in plan) return send(res, plan.refused);
    // Jupiter's own allowance for this server's key, shared fairly between the sessions asking.
    if (!(await this.gate.acquire(callerOf(req, this.config).sessionId))) {
      return send(res, busyRefusal(PROVIDER_RETRY_AFTER_SECONDS));
    }
    const { apiKey, url } = this.config.jupiter;
    send(
      res,
      await this.relay("jupiter", `${url}/${plan.upstream.pathAndQuery}`, {
        method: plan.upstream.method,
        body: plan.upstream.body,
        headers: apiKey ? { "x-api-key": apiKey } : {},
        maxResponseBytes: JUPITER_MAX_RESPONSE_BYTES,
      }),
    );
  }
}

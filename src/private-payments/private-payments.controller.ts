import { Controller, Inject, Param, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { refusal } from "../common/core/answer.js";
import type { Relay } from "../common/core/relay.js";
import { Admission } from "../common/http/admission.js";
import { ApiErrors, EXAMPLE, ok, passedThrough } from "../common/http/api-docs.js";
import type { SessionRequest } from "../common/http/caller.js";
import { send } from "../common/http/send.js";
import type { Config } from "../config/core/config.js";
import { CONFIG, RELAY } from "../tokens.js";
import {
  PRIVATE_PAYMENT_PATHS,
  PRIVATE_PAYMENTS_LIMITS,
  PRIVATE_PAYMENTS_MAX_BODY_BYTES,
  PRIVATE_PAYMENTS_MAX_RESPONSE_BYTES,
} from "./core/privatePayments.js";

@ApiTags("Private payments")
@Controller("v1/private-payments")
export class PrivatePaymentsController {
  constructor(
    private readonly admission: Admission,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(RELAY) private readonly relay: Relay,
  ) {}

  @Post("*path")
  @ApiParam({
    name: "path",
    description:
      "The MagicBlock path, exactly as written. These are the only ones there are; the slashes are part of the path and are not escaped.",
    enum: [...PRIVATE_PAYMENT_PATHS],
  })
  @ApiOperation({
    summary: "MagicBlock private payments",
    description: [
      "The wallets' only way to MagicBlock's private-payment API, which moves USDC from the funding wallet to a portfolio without a direct on-chain link between the two. These paths are allowed, all with POST, and each is passed on with its body unchanged:",
      "",
      "| Path | What it is |",
      "| --- | --- |",
      "| `v1/spl/transfer` | Build a private transfer (a gasless one is a field of the same request) |",
      "| `v1/transaction/send` | Land a signed transfer |",
      "| `v1/spl/transfer-queue/ensure-crank` | Make sure the transfer queue is being processed |",
      "",
      "**Who calls it:** the wallets, when a portfolio is funded privately.",
      "",
      "**Refused:** any other path (404). This is not an open proxy.",
      "",
      "**Contains wallet addresses: yes, two of them.** A transfer names the funding wallet and the portfolio in one request. **Received by:** MagicBlock, from this server's address and never the caller's. MagicBlock can therefore link the two addresses: a private transfer cannot be built without naming both, and that is the service's role. This API does not change that; it only keeps the caller's IP out of it.",
      "",
      "**Forwarded upstream:** the body, a JSON content type and a fixed user agent. **Not forwarded:** the caller's IP, token, session id, origin, referer, cookies or browser name. **Returned:** MagicBlock's status and body, only when the body is JSON and at most 256 KB; none of its headers.",
      "",
      "**Quotas (per minute):** 60 per session, 600 per address, 1,200 in total.",
      "",
      "**Logged:** the route pattern, the status and the duration. Never an address, an amount or a transaction.",
    ].join("\n"),
  })
  @ApiBody({
    description: "The request of the listed path, as MagicBlock defines it. Shown: a transfer.",
    schema: { type: "object" },
    examples: {
      transfer: {
        summary: "Build a transfer (v1/spl/transfer)",
        value: { from: EXAMPLE.address, to: EXAMPLE.otherAddress, amount: 1000000 },
      },
    },
  })
  @ok(
    "MagicBlock's answer, passed back as it came. Its own errors also arrive as it wrote them, with whatever status it used, except 401, 403 and 429 (see 502 and 429).",
    passedThrough(
      "MagicBlock's own response for the path asked, unchanged. The fields the wallets read are named here; it may send others.",
      {
        transaction: {
          type: "string",
          description: "Building a transfer: the transaction to review and sign, base64.",
        },
        signature: {
          type: "string",
          description: "Landing a transfer: the transaction's id, base58.",
        },
      },
    ),
    {
      transfer: {
        summary: "An unsigned transfer (shape is MagicBlock's)",
        value: { transaction: EXAMPLE.transaction },
      },
      landed: {
        summary: "A landed transfer (shape is MagicBlock's)",
        value: { signature: EXAMPLE.signature },
      },
    },
  )
  @ApiErrors({
    session: true,
    body: PRIVATE_PAYMENTS_MAX_BODY_BYTES,
    upstream: "MagicBlock",
    own: {
      404: { why: "The path is not one the wallets use.", codes: { not_found: "Unlisted path" } },
    },
  })
  async post(
    @Param("path") segments: string | string[],
    @Req() req: SessionRequest,
    @Res() res: Response,
  ): Promise<void> {
    const path = Array.isArray(segments) ? segments.join("/") : segments;
    if (!PRIVATE_PAYMENT_PATHS.has(path)) return send(res, refusal("not_found"));

    const admitted = await this.admission.forSession(req, {
      route: "private-payments",
      limits: PRIVATE_PAYMENTS_LIMITS,
      maxBodyBytes: PRIVATE_PAYMENTS_MAX_BODY_BYTES,
    });
    if ("refused" in admitted) return send(res, admitted.refused);

    send(
      res,
      await this.relay("private-payments", `${this.config.privatePaymentsUrl}/${path}`, {
        method: "POST",
        body: admitted.body,
        maxResponseBytes: PRIVATE_PAYMENTS_MAX_RESPONSE_BYTES,
      }),
    );
  }
}

import { Controller, Inject, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { busyRefusal, rateRefusal } from "../common/core/answer.js";
import { PROVIDER_RETRY_AFTER_SECONDS } from "../common/core/providerGate.js";
import { routeBudgets, type QuotaStore } from "../common/core/quota.js";
import type { Relay } from "../common/core/relay.js";
import { Admission } from "../common/http/admission.js";
import {
  BodyLimits,
  errorResponse,
  EXAMPLE,
  jsonResponse,
  SessionRequired,
  UpstreamFailures,
} from "../common/http/api-docs.js";
import { callerOf, type SessionRequest } from "../common/http/caller.js";
import { send } from "../common/http/send.js";
import type { Config } from "../config/core/config.js";
import type { RpcGates } from "../core.module.js";
import { CONFIG, QUOTAS, RELAY, RPC_GATES } from "../tokens.js";
import {
  ALLOWED_METHODS,
  readRpcCall,
  rpcHeavyLimits,
  rpcLimits,
  RPC_MAX_BODY_BYTES,
  RPC_MAX_RESPONSE_BYTES,
} from "./core/rpc.js";

@ApiTags("Solana RPC")
@Controller("v1/rpc")
export class RpcController {
  constructor(
    private readonly admission: Admission,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(QUOTAS) private readonly quotas: QuotaStore,
    @Inject(RELAY) private readonly relay: Relay,
    @Inject(RPC_GATES) private readonly gates: RpcGates,
  ) {}

  @Post()
  @ApiOperation({
    summary: "One Solana JSON-RPC call",
    description: [
      "The wallets' only way to the Solana RPC. The wallet posts one JSON-RPC call; this server passes it to the RPC provider exactly as it came and returns the provider's status and JSON body.",
      "",
      "**Who calls it:** the web and mobile wallets, for every balance read, simulation, transaction send and status check.",
      "",
      `**What is allowed:** one call per request, and only these methods: ${[...ALLOWED_METHODS].map((method) => `\`${method}\``).join(", ")}. A method outside the list is refused: it has no business going through this server's provider key.`,
      "",
      "**Batches are refused.** The wallet sends each address's reads separately so the provider cannot see two of a user's addresses arrive together in one request, and this server never merges two calls. A JSON array could only be someone multiplying their rate limit.",
      "",
      "**Contains wallet addresses: yes.** The body names the address being read, or is a whole transaction. **Received by:** the RPC provider, which sees the address or the transaction, from this server's address and never the caller's.",
      "",
      "**Forwarded upstream:** the body, a JSON content type and a fixed user agent. **Not forwarded:** the caller's IP, token, session id, origin, referer, cookies, browser name, or any other header. **Returned:** the provider's status and body, only when the body is JSON and at most 4 MB; none of its headers.",
      "",
      "**Quotas follow the provider's allowance.** The RPC provider allows this server's key a fixed number of requests a second, counted together whoever they are for. This server sends it fewer than that (`RPC_PROVIDER_RPS`, 8 a second unless configured), so no caller can spend the allowance for everyone. Requests wait in a line per session and the lines are served in turn, so a quiet session is served however loud another is; a request that would wait more than about 400 ms is answered `429 rate_limited` with a `Retry-After` header. The calls that cost the provider real work or reach the chain (`getTokenAccountsByOwner`, `getTransaction`, `sendTransaction`, `simulateTransaction`) are held to half of that rate as well. Per minute, a session may take at most half of what the provider rate allows, an address at most all of it (at the default: 240 and 480; for the costly calls 60 and 240). The costliest reads (`getProgramAccounts`, `getSignaturesForAddress`) are not on the list and never pass.",
      "",
      "**Logged:** the route, the status and the duration. Never the method's parameters, an address or a transaction.",
    ].join("\n"),
  })
  @ApiBody({
    description: "One JSON-RPC 2.0 call. Unknown top-level fields are refused.",
    schema: {
      type: "object",
      required: ["jsonrpc", "id", "method"],
      additionalProperties: false,
      properties: {
        jsonrpc: { type: "string", enum: ["2.0"] },
        id: { oneOf: [{ type: "string", maxLength: 64 }, { type: "number" }] },
        method: { type: "string", enum: [...ALLOWED_METHODS] },
        params: { type: "array", items: {} },
      },
    },
    examples: {
      balance: {
        summary: "Read one address's balance",
        value: { jsonrpc: "2.0", id: 1, method: "getBalance", params: [EXAMPLE.address] },
      },
    },
  })
  @jsonResponse(
    200,
    "The provider's answer, passed back as it came. The provider's own JSON-RPC errors also arrive as the provider wrote them, with whatever status the provider used, except 401, 403 and 429 (see 502 and 429).",
    {
      balance: {
        summary: "A balance",
        value: { jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: 0 } },
      },
    },
  )
  @errorResponse(
    400,
    "The body is not JSON, is a batch, or is not one well-formed JSON-RPC call.",
    {
      invalid_request: "Not JSON, a batch, or a malformed call",
    },
  )
  @SessionRequired({
    403: { method_not_allowed: "Method not on the list" },
    503: { upstream_not_reached: "Provider not reached: it never saw the request" },
    describe503:
      "The provider could not be connected to at all, so it never saw the request; or the token keys could not be read.",
  })
  @BodyLimits(RPC_MAX_BODY_BYTES)
  @UpstreamFailures("The RPC provider")
  async call(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    const admitted = await this.admission.forSession(req, {
      route: "rpc",
      limits: rpcLimits(this.config.rpcProviderRps),
      maxBodyBytes: RPC_MAX_BODY_BYTES,
    });
    if ("refused" in admitted) return send(res, admitted.refused);
    const reading = readRpcCall(admitted.body);
    if ("refused" in reading) return send(res, reading.refused);
    const caller = callerOf(req, this.config);
    const heavy = routeBudgets("rpc-heavy", caller, rpcHeavyLimits(this.config.rpcProviderRps));
    if (reading.heavy && !this.quotas.take(heavy)) return send(res, rateRefusal());
    // The provider's own allowance, shared fairly between the sessions asking.
    const granted =
      (!reading.heavy || (await this.gates.heavy.acquire(caller.sessionId))) &&
      (await this.gates.all.acquire(caller.sessionId));
    if (!granted) return send(res, busyRefusal(PROVIDER_RETRY_AFTER_SECONDS));
    send(
      res,
      await this.relay("rpc", this.config.rpcUrl, {
        method: "POST",
        body: admitted.body,
        maxResponseBytes: RPC_MAX_RESPONSE_BYTES,
      }),
    );
  }
}

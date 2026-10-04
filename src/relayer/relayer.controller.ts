import { Controller, Get, Inject, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Admission } from "../common/http/admission.js";
import {
  BodyLimits,
  errorResponse,
  EXAMPLE,
  jsonResponse,
  SessionRequired,
} from "../common/http/api-docs.js";
import { callerOf, type SessionRequest } from "../common/http/caller.js";
import { send } from "../common/http/send.js";
import type { Config } from "../config/core/config.js";
import { CONFIG, RELAYER } from "../tokens.js";
import { RELAYER_LIMITS, RELAYER_MAX_BODY_BYTES, type Relayer } from "./core/relayer.js";

const RULE = { route: "relayer", limits: RELAYER_LIMITS };

@ApiTags("Fee relayer")
@Controller("v1/relayer")
export class RelayerController {
  constructor(
    private readonly admission: Admission,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(RELAYER) private readonly relayer: Relayer,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Whether there is a fee relayer, and the keys it is pinned to",
    description: [
      "Says whether this deployment has a fee relayer and, when it does, the only keys a relayer-paid transaction may be built against: the fee payer of each relayer replica and the wallet the network cost is paid to. These come from this server's own configuration, never from the relayer, so a misrouted or compromised relayer cannot hand a wallet a key of its choosing.",
      "",
      "**Who calls it:** the wallets, before they offer to pay a network cost in USDC.",
      "",
      "**Contains wallet addresses: no.** The keys returned are NoirWire's own and are public on chain. Nothing is sent to the relayer for this request.",
      "",
      "**Quotas (per minute):** 60 per session, 600 per address, 3,000 in total, shared with `POST /v1/relayer`.",
    ].join("\n"),
  })
  @jsonResponse(200, "The relayer's pinned keys, or that there is none.", {
    available: {
      summary: "A relayer is configured",
      value: {
        available: true,
        feePayers: [EXAMPLE.address],
        paymentWallet: EXAMPLE.otherAddress,
        accountCreation: true,
      },
    },
    none: { summary: "No relayer", value: { available: false } },
  })
  @SessionRequired()
  async pins(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    const admitted = await this.admission.forSession(req, { ...RULE, maxBodyBytes: 0 });
    if ("refused" in admitted) return send(res, admitted.refused);
    send(res, this.relayer.pins());
  }

  @Post()
  @ApiOperation({
    summary: "Find a fee payer, price a transaction, or have the relayer sign it",
    description: [
      "The wallets' only way to the fee relayer: a server that signs a transaction as its fee payer, so a portfolio that holds no SOL can still act, and is paid back in USDC inside that same transaction. The relayer's address, API key and signing secret stay on this server.",
      "",
      "**Who calls it:** the wallets, when a send, an Earn deposit or withdrawal, or opening a holding is paid for in USDC.",
      "",
      "Three methods, one call per request (a JSON array is refused):",
      "",
      "| `method` | `params` | Answer |",
      "| --- | --- | --- |",
      "| `getPayerSigner` | optional `not`: fee payers just seen to fail | The fee payer of a replica that answered, and the payment wallet |",
      "| `estimateTransactionFee` | `transaction`, `signer_key`, `fee_token` (USDC) | What this transaction must pay, in raw USDC units |",
      "| `signTransaction` | `transaction`, `signer_key` | The same transaction with the fee payer's signature added |",
      "",
      "**This is not a signing service, and the session does not make it one.** A session token proves nothing about who holds it, so every check below is made on the transaction itself, for a price and for a signature alike, before the relayer hears of it:",
      "",
      "- It is a legacy transaction with no address lookup table, so every account is in plain sight.",
      "- Its fee payer is one of the pinned keys and equals `signer_key`; the only other signer is one portfolio.",
      "- It carries no priority fee and no System instruction (which also rules out a durable nonce).",
      "- Its instructions are, in order and with nothing else: at most one idempotent creation of a token account funded by the fee payer; at most one action; and the payment.",
      "- The action is a transfer of USDC or a listed tracker out of the portfolio's own account, or Jupiter Lend's deposit or withdrawal for this portfolio in the one layout its API builds.",
      "- An account is opened only for the action beside it: the recipient's account for the token sent, or the portfolio's own account for what it is paid in.",
      "- The payment is one USDC transfer from the portfolio's own account into the pinned payment wallet's account, no larger than a fixed cap (0.05 USDC, or 2.5 USDC when an account is opened).",
      "- The fee payer appears nowhere except as the funder of that one account.",
      "",
      "**The price is set here, not by the relayer:** twice the network fee, plus, for an account the relayer opens, that account's rent and a tenth more. The rent is that of the account the mint really needs, read from the chain, and is charged whether or not the account already exists. The SOL price is read by this server from Pyth's SOL/USD account, independently of the relayer, used for at most thirty seconds, refused when stale or uncertain, and never taken below a fixed floor. Nothing is priced or signed while it and the price behind the relayer's own estimate differ by more than 5%.",
      "",
      "**Before a signature**, on top of all of the above: the payment must cover this server's price (to within 2% for a price that moved since the review), the transaction must already carry the portfolio's own valid signature, and the relayer is asked what it would charge first. Signatures are rationed: 10 a minute per session, 30 a minute per address, and 60 a minute and 600 an hour in total, whoever asks. A transaction that was refused is not counted against the total.",
      "",
      "**Replicas.** Each relayer replica signs as its own key. `getPayerSigner` asks them in random order and returns the first that answers as the key pinned for it; one that does not answer is passed over, which costs nothing because nothing is signed yet. A built transaction names its fee payer, so only that replica is ever asked to price or sign it. A `503` means the replica never received the request, so the wallet may build again for another; a `502` means what the replica did is not known, and the wallet must let the chain settle before trying again.",
      "",
      "**Contains wallet addresses: yes.** The transaction names the portfolio, its counterparty and the amount. **Received by:** the relayer (a NoirWire service) and, through it, its RPC provider, from this server's address and never the caller's. One relayed transaction names one portfolio and never the funding wallet.",
      "",
      "**Forwarded upstream:** only the named parameters, rebuilt here, with `sig_verify` always false and authentication computed by this server. Nothing else in the request body and no header of the caller's travels. **Returned:** only the fields listed, and only when every key in the relayer's answer is one this server pins. The relayer's own messages name accounts and are never passed on.",
      "",
      "**On-chain, regardless:** a relayed transaction names NoirWire's fee payer and pays its USDC account, so anyone can see that a portfolio used the relayer. That is public whatever this API does.",
      "",
      "**Quotas (per minute):** 60 per session, 600 per address, 3,000 in total, plus the signature budgets above.",
      "",
      "**Logged:** the route, the status, the duration, and for a refusal one fixed word (such as `insufficient_payment`). Never an address, an amount, a transaction or the relayer's message.",
    ].join("\n"),
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["method"],
      properties: {
        method: {
          type: "string",
          enum: ["getPayerSigner", "estimateTransactionFee", "signTransaction"],
        },
        params: {
          type: "object",
          properties: {
            transaction: {
              type: "string",
              maxLength: 2048,
              description: "The whole transaction, base64.",
            },
            signer_key: { type: "string", description: "The pinned fee payer it is built for." },
            fee_token: { type: "string", description: "The USDC mint. Estimates only." },
            not: {
              type: "array",
              items: { type: "string" },
              description: "getPayerSigner only: fee payers not to ask.",
            },
          },
        },
      },
    },
    examples: {
      payer: { summary: "Find a fee payer", value: { method: "getPayerSigner" } },
      estimate: {
        summary: "Price a transaction",
        value: {
          method: "estimateTransactionFee",
          params: {
            transaction: EXAMPLE.transaction,
            signer_key: EXAMPLE.address,
            fee_token: EXAMPLE.mint,
          },
        },
      },
      sign: {
        summary: "Have a signed-by-the-portfolio transaction co-signed",
        value: {
          method: "signTransaction",
          params: { transaction: EXAMPLE.transaction, signer_key: EXAMPLE.address },
        },
      },
    },
  })
  @jsonResponse(200, "The answer to the method called.", {
    payer: {
      summary: "getPayerSigner",
      value: {
        result: { signer_address: EXAMPLE.address, payment_address: EXAMPLE.otherAddress },
      },
    },
    estimate: {
      summary: "estimateTransactionFee",
      value: {
        result: {
          fee_in_token: 20000,
          signer_pubkey: EXAMPLE.address,
          payment_address: EXAMPLE.otherAddress,
        },
      },
    },
    sign: {
      summary: "signTransaction",
      value: {
        result: { signed_transaction: EXAMPLE.transaction, signer_pubkey: EXAMPLE.address },
      },
    },
  })
  @errorResponse(400, "The body is not JSON, is a batch, or `params` is not an object.", {
    invalid_request: "Malformed request",
  })
  @errorResponse(
    422,
    "The transaction failed a check, here or on the relayer. Nothing was signed. The wallet is told whether the payment was too small, the one refusal it can act on by asking for a new price; every other reason is the single code `refused`.",
    {
      insufficient_payment: "The payment is below this server's price",
      refused:
        "Any other failed check: not the template, a missing or invalid portfolio signature, a fee payer that is not pinned, a price disagreement, a price above the cap",
    },
  )
  @errorResponse(
    502,
    "The relayer was reached and gave no answer this server can use. `no_answer`: it answered with an error status, with something unreadable, or with keys this server does not pin, so what it did with the request is not known; for a signature, treat the transaction as possibly signed. `upstream_refused`: it turned down this server's own credentials (it answered 401 or 403); that is an operator's to fix, is logged as such, and is never passed on as a 401.",
    {
      no_answer: "No usable answer: what the relayer did is not known",
      upstream_refused: "The relayer refused this server's credentials",
    },
  )
  @SessionRequired({
    403: {
      method_not_allowed:
        "Not one of the three methods. Everything else the relayer can do, sending a transaction above all, is unreachable through this API",
    },
    describe503:
      "There is no relayer, no replica could be used, no SOL price or rent could be read to charge by, or the replica never received the request. Nothing was signed. (Also: the token keys could not be read.)",
  })
  @BodyLimits(RELAYER_MAX_BODY_BYTES)
  async call(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    const admitted = await this.admission.forSession(req, {
      ...RULE,
      maxBodyBytes: RELAYER_MAX_BODY_BYTES,
    });
    if ("refused" in admitted) return send(res, admitted.refused);
    send(res, await this.relayer.call(admitted.body, callerOf(req, this.config)));
  }
}

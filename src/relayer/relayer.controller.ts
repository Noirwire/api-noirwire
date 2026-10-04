import { Controller, Get, Inject, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { Admission } from "../common/http/admission.js";
import { address, ApiErrors, EXAMPLE, ok, transaction } from "../common/http/api-docs.js";
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
  @ok(
    "The relayer's pinned keys, or that there is none.",
    {
      type: "object",
      required: ["available"],
      properties: {
        available: {
          type: "boolean",
          description:
            "Whether this deployment has a fee relayer. When false, no other field is sent.",
        },
        feePayers: {
          type: "array",
          items: address("A relayer replica's fee payer."),
          description:
            "The only keys a relayer-paid transaction may name as fee payer: one per replica.",
        },
        paymentWallet: address("The wallet whose USDC account the network cost is paid into."),
        accountCreation: {
          type: "boolean",
          description: "Whether the relayer will open a token account as part of an action.",
        },
      },
    },
    {
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
    },
  )
  @ApiErrors({ session: true })
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
      "| `signTransaction` | `transaction`, `signer_key` | `{ transaction, signature }`: the same transaction with the fee payer's signature added, and its id |",
      "",
      "**This is not a signing service, and the session does not make it one.** A session token proves nothing about who holds it, so every check below is made on the transaction itself, for a price and for a signature alike, before the relayer hears of it:",
      "",
      "- It is a legacy transaction with no address lookup table, so every account is in plain sight.",
      "- Its fee payer is one of the pinned keys and equals `signer_key`; the only other signer is one portfolio.",
      "- It carries no priority fee and no System instruction (which also rules out a durable nonce).",
      "- Its instructions are, in order and with nothing else: at most one idempotent creation of a token account funded by the fee payer; at most one action; and the payment.",
      "- The action is a transfer of USDC or a listed tracker out of the portfolio's own account, or Jupiter Lend's deposit, withdrawal (an amount of USDC) or redemption (a number of receipt shares, which is how a whole position is taken back) for this portfolio, each in the one layout the program takes: the same accounts, in the same order, and nothing more.",
      "- An account is opened only for the action beside it: the recipient's account for the token sent, or the portfolio's own account for what it is paid in (the receipt token for a deposit, USDC for a withdrawal or a redemption).",
      "- The payment is one USDC transfer from the portfolio's own account into the pinned payment wallet's account, no larger than a fixed cap (0.05 USDC, or 2.5 USDC when an account is opened).",
      "- The fee payer appears nowhere except as the funder of that one account.",
      "",
      "**The price is set here, not by the relayer:** twice the network fee, plus, for an account the relayer opens, that account's rent and a tenth more. The rent is that of the account the mint really needs, read from the chain, and is charged whether or not the account already exists. The SOL price is read by this server from Pyth's SOL/USD account, independently of the relayer, used for at most thirty seconds, refused when stale or uncertain, and never taken below a fixed floor. Nothing is priced or signed while it and the price behind the relayer's own estimate differ by more than 5%.",
      "",
      "**Before a signature**, on top of all of the above: the payment must cover this server's price (to within 2% for a price that moved since the review), the transaction must already carry the portfolio's own valid signature, and the relayer is asked what it would charge first. Signatures are rationed: 10 a minute per session, 30 a minute per address, and 60 a minute and 600 an hour in total, whoever asks. A transaction that was refused is not counted against the total.",
      "",
      "**Signing never broadcasts.** The relayer is asked to sign only. The answer is `{ transaction, signature }`: the fully signed transaction in base64, and its id in base58 (the fee payer's signature, which exists only once the relayer has signed). Before it is returned, it is checked to be the transaction that was sent in: the same message byte for byte, the portfolio's signature untouched, and a valid signature of the pinned fee payer. The wallet records the `signature` durably and then sends the transaction itself with `POST /v1/rpc` `sendTransaction`. This order is the point: if this server sent it, a wallet that died right after would hold no id to look for, could conclude the action never went through, and the user would pay twice. A transaction that is signed and never sent costs the relayer nothing, but it still counts against the signature budgets, which are taken at signing.",
      "",
      "**Replicas and failover.** Each relayer replica signs as its own key. `getPayerSigner` asks them in random order and returns the first that answers as the key pinned for it; one that is unreachable, errors, or refuses this server's credentials is passed over for the next, which costs nothing because nothing is signed yet. Only when every replica has failed is the answer `503 relayer_unavailable`. A built transaction names its fee payer, so only that replica can price or sign it: if it is unreachable or turns the request away before signing (including for this server's credentials, which is never reported as a `401`), the answer is the same `503 relayer_unavailable`, nothing was signed, and the wallet builds again for another replica. Once a replica has answered the signing call there is no failover: an answer this server cannot use is a `502 no_answer`, what the replica did is not known, and the wallet must let the chain settle that transaction before trying again.",
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
  @ok(
    "The answer to the method called: one of three shapes.",
    {
      oneOf: [
        {
          title: "getPayerSigner",
          type: "object",
          required: ["result"],
          properties: {
            result: {
              type: "object",
              required: ["signer_address", "payment_address"],
              properties: {
                signer_address: address("The fee payer to build the transaction against."),
                payment_address: address("The wallet whose USDC account the payment goes to."),
              },
            },
          },
        },
        {
          title: "estimateTransactionFee",
          type: "object",
          required: ["result"],
          properties: {
            result: {
              type: "object",
              required: ["fee_in_token", "signer_pubkey", "payment_address"],
              properties: {
                fee_in_token: {
                  type: "integer",
                  description:
                    "What the transaction must pay, in raw USDC units: millionths of a USDC (20000 is 0.02 USDC).",
                },
                signer_pubkey: address("The fee payer the price is for."),
                payment_address: address("The wallet whose USDC account the payment goes to."),
              },
            },
          },
        },
        {
          title: "signTransaction",
          type: "object",
          required: ["transaction", "signature"],
          properties: {
            transaction: transaction(
              "The transaction that was sent in, now also signed by the fee payer. Not broadcast: send it with `POST /v1/rpc` `sendTransaction`.",
            ),
            signature: {
              type: "string",
              description:
                "The transaction's id: the fee payer's signature, base58 (86 to 88 characters). Record it before sending.",
            },
          },
        },
      ],
    },
    {
      payer: {
        summary: "getPayerSigner",
        value: {
          result: { signer_address: EXAMPLE.address, payment_address: EXAMPLE.otherAddress },
        },
      },
      estimate: {
        summary: "estimateTransactionFee: 0.02 USDC",
        value: {
          result: {
            fee_in_token: 20000,
            signer_pubkey: EXAMPLE.address,
            payment_address: EXAMPLE.otherAddress,
          },
        },
      },
      sign: {
        summary:
          "signTransaction: signed, not broadcast. Record `signature`, then send it yourself",
        value: { transaction: EXAMPLE.transaction, signature: EXAMPLE.signature },
      },
    },
  )
  @ApiErrors({
    session: true,
    body: RELAYER_MAX_BODY_BYTES,
    own: {
      400: {
        why: "The body is not JSON, is a batch, or `params` is not an object.",
        codes: { invalid_request: "Malformed request, or a query string" },
      },
      403: {
        why: "The method is not one of the three. Everything else the relayer can do, sending a transaction above all, is unreachable through this API.",
        codes: { method_not_allowed: "Not one of the three methods" },
      },
      422: {
        why: "The transaction failed a check, here or on the relayer. Nothing was signed. The wallet is told whether the payment was too small, the one refusal it can act on by asking for a new price; every other reason is the single code `refused`.",
        codes: {
          insufficient_payment: "The payment is below this server's price",
          refused:
            "Any other failed check: not the template, a missing or invalid portfolio signature, a fee payer that is not pinned, a price disagreement, a price above the cap",
        },
      },
      502: {
        why: "The relayer answered the call and this server cannot use the answer: an error status, something unreadable, keys this server does not pin, or a signed transaction that is not the one sent in with a valid fee payer signature. What it did with the request is not known. For a signature, treat the transaction as possibly signed, and do not build it again until the chain has settled it.",
        codes: { no_answer: "No usable answer: what the relayer did is not known" },
      },
      503: {
        why: "`relayer_unavailable`: nothing was signed, so the action may be built again, for another replica if there is one. A replica that refuses this server's own credentials lands here too (and is logged as an operator error): never as a `401`.",
        codes: {
          relayer_unavailable:
            "No relayer, every replica failed, no price to charge by, or this transaction's replica is unreachable or turned the request away before signing",
        },
      },
    },
  })
  async call(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    const admitted = await this.admission.forSession(req, {
      ...RULE,
      maxBodyBytes: RELAYER_MAX_BODY_BYTES,
    });
    if ("refused" in admitted) return send(res, admitted.refused);
    send(res, await this.relayer.call(admitted.body, callerOf(req, this.config)));
  }
}

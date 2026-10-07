import { Controller, Get, Inject, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { Answer } from "../common/core/answer.js";
import { Admission } from "../common/http/admission.js";
import {
  address,
  ApiErrors,
  EXAMPLE,
  ok,
  transaction,
  type RouteErrors,
} from "../common/http/api-docs.js";
import { callerOf, type SessionRequest } from "../common/http/caller.js";
import { send } from "../common/http/send.js";
import type { Config } from "../config/core/config.js";
import { CONFIG, PROFILES } from "../tokens.js";
import {
  CREATIONS_PER_HOUR_PER_IP,
  CREATIONS_PER_HOUR_PER_SESSION,
  PROFILE_LIMITS,
  PROFILE_MAX_BODY_BYTES,
  WRITES_PER_HOUR_PER_SESSION,
  type Profiles,
} from "./core/profiles.js";
import { PROFILE_ROUTE } from "./core/rollup.js";

const RULE = { route: PROFILE_ROUTE, limits: PROFILE_LIMITS };

const EXAMPLE_READ_TOKEN = "example-read-token";
const EXAMPLE_CHALLENGE = "example-challenge-1790000000";

const WHAT_A_PROFILE_IS =
  "A profile is one small record of a wallet's own labels (portfolio names, icons, the watchlist), encrypted on the device before it leaves it and kept on a private rollup, so that restoring the recovery phrase on another device brings the labels back. This server and the rollup only ever see ciphertext. The wallet works the same without it.";

const NO_WALLET_ADDRESS =
  "**Contains wallet addresses: no.** The owner is a key derived from the recovery phrase for the profile alone. It is never the funding wallet's key and never a portfolio's, and nothing that names one is accepted here.";

const QUOTAS =
  "**Quotas (per minute):** 60 per session, 600 per address, 1,200 in total, shared by the six profile routes.";

const LOGGED =
  "**Logged:** the route pattern, the status and the duration, and for a refusal one fixed word. Never a key, a token, a challenge, a transaction or a record.";

const owner = address("The profile's owner: the key the wallet derives for its profile.");
const readToken = {
  type: "string",
  maxLength: 2048,
  description:
    "The rollup's read token from `POST /v1/profile/session`. It is bound to the owner key that signed for it.",
};

const OFF = {
  why: "This deployment keeps no profiles (`GET /v1/profile/config` says `enabled: false`), so this route is not there.",
  codes: { not_found: "Profiles are not configured" },
} as const;

/** What every route that asks the rollup can answer with, beside its own. */
const ROLLUP_ERRORS: NonNullable<RouteErrors["own"]> = {
  404: OFF,
  502: {
    why: "The rollup gave no usable answer (an error, not JSON, too large, or the connection broke), or refused the request outright (it answered 401 or 403, which is never passed on as such: a `401` here only ever means the caller's session). A read token that the rollup no longer accepts lands here: sign in again.",
    codes: {
      upstream_failed: "Unusable answer from the rollup",
      upstream_refused: "The rollup refused the request: sign in again",
    },
  },
  503: {
    why: "The rollup could not be connected to at all, so it never saw the request.",
    codes: { upstream_not_reached: "Rollup not reached: it never saw the request" },
  },
  504: {
    why: "The rollup did not answer within 8 seconds.",
    codes: { upstream_timeout: "The rollup timed out" },
  },
};

const errors = (malformed: string, own: RouteErrors["own"] = {}) =>
  ApiErrors({
    session: true,
    body: PROFILE_MAX_BODY_BYTES,
    own: {
      400: { why: malformed, codes: { invalid_request: "Malformed request, or a query string" } },
      ...ROLLUP_ERRORS,
      ...own,
    },
  });

@ApiTags("Profile")
@Controller("v1/profile")
export class ProfileController {
  constructor(
    private readonly admission: Admission,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(PROFILES) private readonly profiles: Profiles,
  ) {}

  @Get("config")
  @ApiOperation({
    summary: "Whether profiles are kept here, and what a profile transaction is built against",
    description: [
      WHAT_A_PROFILE_IS,
      "",
      "Says whether this deployment keeps profiles and, when it does, the program they live in, the gate key that must be the fee payer of every creation and write, and the largest record accepted. These come from this server's own configuration. When `enabled` is false every other profile route answers `404`.",
      "",
      "**Who calls it:** the wallets, before they sync their labels.",
      "",
      "**Contains wallet addresses: no.** The keys returned are NoirWire's own. Nothing is sent to the rollup for this request.",
      "",
      QUOTAS,
    ].join("\n"),
  })
  @ok(
    "The profile program's pins, or that there are no profiles here.",
    {
      type: "object",
      required: ["enabled"],
      properties: {
        enabled: {
          type: "boolean",
          description:
            "Whether this deployment keeps profiles. When false, no other field is sent.",
        },
        programId: address("The profile program."),
        gate: address(
          "The gate key: the fee payer of a creation or a write, whose signature this server adds.",
        ),
        maxDataLen: {
          type: "integer",
          description: "The largest record a creation or a write may carry, in bytes.",
        },
      },
    },
    {
      enabled: {
        summary: "Profiles are kept here",
        value: {
          enabled: true,
          programId: EXAMPLE.mint,
          gate: EXAMPLE.otherAddress,
          maxDataLen: 2048,
        },
      },
      off: { summary: "No profiles", value: { enabled: false } },
    },
  )
  @ApiErrors({ session: true })
  async pins(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    const admitted = await this.admission.forSession(req, { ...RULE, maxBodyBytes: 0 });
    if ("refused" in admitted) return send(res, admitted.refused);
    send(res, this.profiles.config());
  }

  @Post("challenge")
  @ApiOperation({
    summary: "Ask the rollup for a sign-in challenge",
    description: [
      "The first half of signing in to the private rollup as a profile's owner: the rollup hands out a challenge, which the wallet signs with the owner key and exchanges at `POST /v1/profile/session`.",
      "",
      "**Who calls it:** the wallets, when they hold no read token or theirs has expired.",
      "",
      NO_WALLET_ADDRESS,
      "",
      "**Forwarded upstream:** the owner key, to the rollup, from this server's address. **Returned:** the challenge and nothing else.",
      "",
      QUOTAS,
      "",
      LOGGED,
    ].join("\n"),
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["owner"],
      additionalProperties: false,
      properties: { owner },
    },
    examples: { challenge: { summary: "Ask for a challenge", value: { owner: EXAMPLE.address } } },
  })
  @ok(
    "The challenge to sign.",
    {
      type: "object",
      required: ["challenge"],
      properties: {
        challenge: {
          type: "string",
          description:
            "The text to sign, as the rollup wrote it: sign its UTF-8 bytes with the owner key.",
        },
      },
    },
    {
      challenge: { summary: "A challenge (dummy value)", value: { challenge: EXAMPLE_CHALLENGE } },
    },
  )
  @errors("The body is not JSON, or is not exactly `{ owner }` with a Solana address.")
  challenge(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    return this.answer(req, res, (body) => this.profiles.challenge(body));
  }

  @Post("session")
  @ApiOperation({
    summary: "Exchange a signed challenge for the rollup's read token",
    description: [
      "The second half of signing in to the private rollup. The token that comes back lets its holder read the one profile its owner key may read, and is what the other profile routes take as `token`.",
      "",
      "**Who calls it:** the wallets, right after `POST /v1/profile/challenge`.",
      "",
      NO_WALLET_ADDRESS,
      "",
      "**Forwarded upstream:** the owner key, the challenge and the signature, to the rollup. **Returned:** the token and its expiry, only. A signature the rollup does not accept is answered as a `502`, never a `401`.",
      "",
      QUOTAS,
      "",
      LOGGED,
    ].join("\n"),
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["owner", "challenge", "signature"],
      additionalProperties: false,
      properties: {
        owner,
        challenge: {
          type: "string",
          maxLength: 1024,
          description: "The challenge, exactly as `POST /v1/profile/challenge` returned it.",
        },
        signature: {
          type: "string",
          description:
            "The owner key's ed25519 signature over the UTF-8 bytes of `challenge`, base58.",
        },
      },
    },
    examples: {
      session: {
        summary: "Sign in (dummy values)",
        value: {
          owner: EXAMPLE.address,
          challenge: EXAMPLE_CHALLENGE,
          signature: EXAMPLE.signature,
        },
      },
    },
  })
  @ok(
    "The rollup's read token.",
    {
      type: "object",
      required: ["token"],
      properties: {
        token: { ...readToken, description: "The rollup's read token, bound to the owner key." },
        expiresAt: {
          type: "integer",
          description:
            "When the token expires, as the rollup states it: Unix time in MILLISECONDS. Absent when the rollup states none.",
        },
      },
    },
    {
      session: {
        summary: "A read token (dummy values)",
        value: { token: EXAMPLE_READ_TOKEN, expiresAt: 1790000000000 },
      },
    },
  )
  @errors("The body is not JSON, or is not exactly `{ owner, challenge, signature }`.")
  session(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    return this.answer(req, res, (body) => this.profiles.session(body));
  }

  @Post("read")
  @ApiOperation({
    summary: "Read an owner's profile",
    description: [
      "Reads the one profile account `owner` can have. This server derives its address from the owner key; a caller never names an account, so this is not a way to read anything else on the rollup. The rollup itself decides whether the token may read it.",
      "",
      "**Who calls it:** the wallets, after unlocking and before a write.",
      "",
      NO_WALLET_ADDRESS,
      "",
      "**Forwarded upstream:** one `getAccountInfo` for the derived address, with the read token. **Returned:** the account's data and nothing else of the rollup's answer.",
      "",
      "The account's data is laid out as: bytes 0 to 7 a discriminator, 8 the layout (1), 9 a bump, 10 to 41 the owner, 42 to 49 the revision (u64, little endian), 50 to 53 the record's length (u32, little endian), then the record: ciphertext only the wallet can read.",
      "",
      QUOTAS,
      "",
      LOGGED,
    ].join("\n"),
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["owner", "token"],
      additionalProperties: false,
      properties: { owner, token: readToken },
    },
    examples: {
      read: {
        summary: "Read a profile (dummy values)",
        value: { owner: EXAMPLE.address, token: EXAMPLE_READ_TOKEN },
      },
    },
  })
  @ok(
    "The profile account's data, or that there is none.",
    {
      type: "object",
      required: ["data"],
      properties: {
        data: {
          type: "string",
          nullable: true,
          description:
            "The whole account data, base64, or null when the owner has no profile or the token may not read it.",
        },
      },
    },
    {
      profile: { summary: "A profile (dummy bytes)", value: { data: "AQID" } },
      none: { summary: "No profile", value: { data: null } },
    },
  )
  @errors("The body is not JSON, or is not exactly `{ owner, token }`.")
  read(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    return this.answer(req, res, (body) => this.profiles.read(body));
  }

  @Post("blockhash")
  @ApiOperation({
    summary: "The rollup's latest blockhash",
    description: [
      "The blockhash a profile transaction is built with. It is the rollup's, not Solana's: a profile transaction is only ever sent to the rollup.",
      "",
      "**Who calls it:** the wallets, before they build a profile transaction.",
      "",
      "**Contains wallet addresses: no.** **Forwarded upstream:** one `getLatestBlockhash`, with the read token.",
      "",
      QUOTAS,
      "",
      LOGGED,
    ].join("\n"),
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["token"],
      additionalProperties: false,
      properties: { token: readToken },
    },
    examples: {
      blockhash: { summary: "Ask (dummy value)", value: { token: EXAMPLE_READ_TOKEN } },
    },
  })
  @ok(
    "The rollup's latest blockhash.",
    {
      type: "object",
      required: ["blockhash", "lastValidBlockHeight"],
      properties: {
        blockhash: { type: "string", description: "The blockhash, base58." },
        lastValidBlockHeight: {
          type: "integer",
          description: "The last block height at which a transaction built with it is accepted.",
        },
      },
    },
    {
      blockhash: {
        summary: "A blockhash (dummy value)",
        value: { blockhash: EXAMPLE.blockhash, lastValidBlockHeight: 1 },
      },
    },
  )
  @errors("The body is not JSON, or is not exactly `{ token }`.")
  blockhash(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    return this.answer(req, res, (body) => this.profiles.blockhash(body));
  }

  @Post("submit")
  @ApiOperation({
    summary: "Create, write or close a profile",
    description: [
      "Sends one profile transaction to the rollup and waits for it to land. For a creation or a write this server adds the gate key's signature as fee payer; a closing is the owner's alone and is sent as it came. Neither the owner nor the gate needs any SOL.",
      "",
      "**Who calls it:** the wallets, when their labels changed, or when a profile is removed.",
      "",
      "**This is not a signing service, and the session does not make it one.** Every check below is made on the transaction itself before the gate signs or anything is sent:",
      "",
      "- It is a legacy transaction with no address lookup table and exactly one instruction, for the profile program: `create_profile`, `write_profile` or `close_profile`. No priority fee and nothing else rides along.",
      "- Its accounts are exactly that instruction's, in the program's order, each with the signer and writable flags the program expects: the fixed addresses, and the sponsor, the profile and its permission account worked out again here from the owner key in the instruction. The message lists no other account and no other signer.",
      "- A creation or a write names the gate as fee payer and carries the owner's own valid signature; its record is not empty and no longer than `maxDataLen`.",
      "- A closing names the owner as fee payer, carries the owner's valid signature and no argument.",
      "- The bytes sent in are exactly that transaction and nothing after it.",
      "",
      `**Creations are rationed hardest**, because each one spends rent: ${CREATIONS_PER_HOUR_PER_SESSION} an hour per session, ${CREATIONS_PER_HOUR_PER_IP} an hour per address, and a ceiling on how many are signed in 24 hours in total, whoever asks. When the ceiling is reached a creation is answered \`429\` and everything else goes on. Writes are held to ${WRITES_PER_HOUR_PER_SESSION} an hour per session. A transaction that was refused is not counted.`,
      "",
      "**Sending the same transaction twice is safe.** Two byte-identical transactions are one transaction: the rollup runs it once, and the second request is answered with the outcome of the first.",
      "",
      NO_WALLET_ADDRESS,
      "",
      "**Forwarded upstream:** the transaction, with the read token, to the rollup. **Returned:** its id. The rollup's own messages are never passed on.",
      "",
      QUOTAS,
      "",
      LOGGED,
    ].join("\n"),
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["token", "transaction"],
      additionalProperties: false,
      properties: {
        token: readToken,
        transaction: {
          ...transaction("The profile transaction, signed by the owner."),
          maxLength: 8192,
        },
      },
    },
    examples: {
      submit: {
        summary: "Submit (dummy values)",
        value: { token: EXAMPLE_READ_TOKEN, transaction: EXAMPLE.transaction },
      },
    },
  })
  @ok(
    "The transaction landed.",
    {
      type: "object",
      required: ["signature"],
      properties: {
        signature: {
          type: "string",
          description: "The transaction's id on the rollup: its first signature, base58.",
        },
      },
    },
    { landed: { summary: "Landed", value: { signature: EXAMPLE.signature } } },
  )
  @errors("The body is not JSON, or is not exactly `{ token, transaction }`.", {
    409: {
      why: "The profile program refused the transaction. The code is the program's own name for the reason, and the one thing here a wallet acts on: after `StaleRevision` it reads, merges and writes again.",
      codes: {
        StaleRevision: "The profile changed since it was read",
        ProfileExists: "A creation for an owner that already has a profile",
        ProfileMissing: "A write or a closing of a profile that does not exist",
        Paused: "The program is paused",
        RecordTooLarge: "The record is above the program's own limit",
      },
    },
    422: {
      why: "The transaction failed one of the checks above. Nothing was signed and nothing was sent.",
      codes: { refused: "Not one of the three profile transactions" },
    },
    429: {
      why: "A creation or write budget is spent, or the ceiling on creations in 24 hours is reached. Nothing was signed.",
      codes: { rate_limited: "Quota spent" },
    },
    504: {
      why: "The rollup did not answer within 8 seconds, or the transaction was not seen to land within 6. It may still land: send the very same transaction again to learn its outcome.",
      codes: { upstream_timeout: "The rollup timed out, or the transaction was not confirmed" },
    },
  })
  submit(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    return this.answer(req, res, (body) => this.profiles.submit(body, callerOf(req, this.config)));
  }

  /** Admits the request, then answers with what the profile logic makes of its body. */
  private async answer(
    req: SessionRequest,
    res: Response,
    handle: (body: string) => Promise<Answer>,
  ): Promise<void> {
    const admitted = await this.admission.forSession(req, {
      ...RULE,
      maxBodyBytes: PROFILE_MAX_BODY_BYTES,
    });
    if ("refused" in admitted) return send(res, admitted.refused);
    send(res, await handle(admitted.body));
  }
}

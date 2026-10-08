import { Controller, Get, Inject, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { Answer } from "../common/core/answer.js";
import { Admission } from "../common/http/admission.js";
import { address, ApiErrors, EXAMPLE, ok, type RouteErrors } from "../common/http/api-docs.js";
import { callerOf, type SessionRequest } from "../common/http/caller.js";
import { send } from "../common/http/send.js";
import type { Config } from "../config/core/config.js";
import { CONFIG, REWARDS } from "../tokens.js";
import { REWARDS_ROUTE } from "./core/database.js";
import { MAX_CLOCK_DRIFT_SECONDS } from "./core/messages.js";
import { INVITED_BONUS_WEEKS, WEEKLY_POINTS } from "./core/points.js";
import {
  CLAIM_LIMITS,
  CLAIM_ROUTE,
  CODE_LENGTH,
  REWARDS_LIMITS,
  REWARDS_MAX_BODY_BYTES,
  type Rewards,
} from "./core/rewards.js";
import { SEASON_WEEKS } from "./core/weeks.js";

const RULE = { route: REWARDS_ROUTE, limits: REWARDS_LIMITS };
const CLAIM_RULE = { route: CLAIM_ROUTE, limits: CLAIM_LIMITS };

const EXAMPLE_AT = 1_790_000_000;
const EXAMPLE_CODE = "K7M2QX9R";
const EXAMPLE_STATE = {
  code: EXAMPLE_CODE,
  codeActive: true,
  invited: 2,
  wasInvited: false,
  boostWeeksLeft: 0,
  points: "1250",
  week: {
    index: 3,
    endsAt: "2026-11-09T00:00:00.000Z",
    feeMicroUsdc: "61000",
    shareBps: 125,
    traders: 48,
  },
};

const WHAT_REWARDS_ARE = `Rewards are points for trades, for a wallet that asks for them. Each week of a ${SEASON_WEEKS} week season, ${WEEKLY_POINTS.toLocaleString("en-US")} points are split between the members by the trading fees their claimed trades paid NoirWire that week. A wallet that never joins sends nothing here, and works the same.`;

const THE_REWARDS_KEY =
  "A member is a rewards key: an ed25519 key the wallet derives from the recovery phrase for this alone. It is not a Solana account and holds nothing. It is never the profile key, the funding wallet's key or a portfolio's.";

const NO_WALLET_ADDRESS = `**Contains wallet addresses: no.** ${THE_REWARDS_KEY}`;

const KEPT =
  "**Stored:** the rewards key, its referral code, who invited it, the week and the UTC day it joined, its fee total per week and its points. Never a portfolio, a transaction, a session id, an IP address or a time of day.";

const QUOTAS = `**Quotas (per minute):** ${REWARDS_LIMITS.perSession} per session, ${REWARDS_LIMITS.perIp} per address, ${REWARDS_LIMITS.total} in total, shared by the config, join and state routes.`;

const LOGGED =
  "**Logged:** the route pattern, the status and the duration, and for a refusal one fixed word. Never a key, a signature, a code, a portfolio or a transaction.";

const SIGNED_TIME = `\`at\` is the time of signing in Unix seconds, and is refused when it is more than ${MAX_CLOCK_DRIFT_SECONDS} seconds from this server's clock either way.`;

const rewardsKey = address("The member's rewards key.");
const at = {
  type: "integer",
  description:
    "When the request was signed: Unix time in SECONDS, as a JSON number. The message that is signed carries it in decimal.",
};
const signatureOf = (what: string) => ({
  type: "string",
  description: `The rewards key's ed25519 signature over the UTF-8 bytes of ${what}, base58.`,
});

const STATE = {
  type: "object",
  required: ["code", "codeActive", "invited", "wasInvited", "boostWeeksLeft", "points", "week"],
  properties: {
    code: {
      type: "string",
      description: `The member's own referral code: ${CODE_LENGTH} characters, digits 2 to 9 and capital letters without I and O. Assigned at the first join.`,
    },
    codeActive: {
      type: "boolean",
      description:
        "Whether others can join with the code: true once the member has one credited trade.",
    },
    invited: { type: "integer", description: "How many members joined with this member's code." },
    wasInvited: { type: "boolean", description: "Whether the member joined with someone's code." },
    boostWeeksLeft: {
      type: "integer",
      description: `For a member who joined with someone's code, how many weeks their own fees still count 1.1 times, the running week included: ${INVITED_BONUS_WEEKS} in the week they joined in, 1 in the last such week, 0 after. Always 0 for a member who joined without a code. From 0 to ${INVITED_BONUS_WEEKS}. Before the season starts it is counted as of week 0.`,
    },
    points: {
      type: "string",
      description: "The member's points from every settled week: a whole number, as a string.",
    },
    week: {
      type: "object",
      nullable: true,
      description:
        "The running week, or null outside the season: before week 0 begins and once the last week has ended. The points are returned either way.",
      required: ["index", "endsAt", "feeMicroUsdc", "shareBps", "traders"],
      properties: {
        index: {
          type: "integer",
          description: `Which week of the season is running, from 0 to ${SEASON_WEEKS - 1}.`,
        },
        endsAt: {
          type: "string",
          description: "When that week ends: a Monday, 00:00 UTC, as an ISO 8601 date and time.",
        },
        feeMicroUsdc: {
          type: "string",
          description:
            "The fees of the member's claimed trades in that week, in millionths of a USDC, as a string.",
        },
        shareBps: {
          type: "integer",
          description:
            "The member's share of that week's points as it stands, in hundredths of a percent, rounded down. An estimate: it moves with every claim, anyone's, until the week is settled.",
        },
        traders: {
          type: "integer",
          description:
            "How many members have a fee credited in that week, this member included once they have one. A count, read as the request is answered: nothing of who they are or what they paid.",
        },
      },
    },
  },
};

const OFF = {
  why: "This deployment hands out no points (`GET /v1/rewards/config` says `enabled: false`), so this route is not there.",
  codes: { not_found: "Rewards are not configured" },
} as const;

/** What every route that asks the database can answer with, beside its own. */
const STORAGE_ERRORS: NonNullable<RouteErrors["own"]> = {
  502: {
    why: "The database, or for a claim the RPC provider, gave no usable answer (an error, not JSON, too large, or the connection broke), or refused this server's own credentials (never passed on as a `401`). Its body is not passed on.",
    codes: {
      upstream_failed: "Unusable answer from the database or the RPC provider",
      upstream_refused: "This server's own key was refused: an operator's to fix",
    },
  },
  503: {
    why: "The database, or for a claim the RPC provider, could not be connected to at all.",
    codes: { upstream_not_reached: "Not reached: it never saw the request" },
  },
  504: {
    why: "The database, or for a claim the RPC provider, did not answer within 8 seconds.",
    codes: { upstream_timeout: "Timed out" },
  },
};

/** A join or a state request that does not prove it comes from its rewards key, now. */
const UNSIGNED = {
  why: `The signature is not the rewards key's over the message, or \`at\` is more than ${MAX_CLOCK_DRIFT_SECONDS} seconds from this server's clock. Nothing was done. This says nothing about the session, which a \`401\` is for.`,
  codes: {
    signature_invalid: "The signature is not the rewards key's over the message",
    clock_skew: "`at` is too far from this server's clock: sign again",
  },
} as const;

const errors = (malformed: string, own: RouteErrors["own"] = {}) =>
  ApiErrors({
    session: true,
    body: REWARDS_MAX_BODY_BYTES,
    own: {
      400: { why: malformed, codes: { invalid_request: "Malformed request, or a query string" } },
      404: OFF,
      ...STORAGE_ERRORS,
      ...own,
    },
  });

@ApiTags("Rewards")
@Controller("v1/rewards")
export class RewardsController {
  constructor(
    private readonly admission: Admission,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(REWARDS) private readonly rewards: Rewards,
  ) {}

  @Get("config")
  @ApiOperation({
    summary: "Whether points are handed out here, and the season's shape",
    description: [
      WHAT_REWARDS_ARE,
      "",
      "Says whether this deployment hands out points and, when it does, when the season starts, how many weeks it lasts and how many points a week splits. These come from this server's own configuration. When `enabled` is false every other rewards route answers `404`, and a wallet shows nothing of rewards.",
      "",
      "**Who calls it:** the wallets, before they show anything of rewards.",
      "",
      "`tradersThisWeek` is how many members have a fee credited in the running week, so that a wallet can show how early a member would be. It is a count and nothing else: no member, no fee, no total. This server reads it from the database at most once in 60 seconds and answers everyone with that reading in between, so it can be up to a minute old. When the database gives no answer it is null and the rest of the answer is unchanged: whether rewards are on never depends on the database.",
      "",
      "**Contains wallet addresses: no.** Nothing of the caller is sent to the database for this request, and nothing is stored.",
      "",
      QUOTAS,
    ].join("\n"),
  })
  @ok(
    "The season, or that there are no rewards here.",
    {
      type: "object",
      required: ["enabled", "seasonStart", "seasonWeeks", "weeklyPoints", "tradersThisWeek"],
      properties: {
        enabled: {
          type: "boolean",
          description:
            "Whether this deployment hands out points. When false, the other fields are null.",
        },
        seasonStart: {
          type: "string",
          nullable: true,
          description:
            "When week 0 begins: a Monday, 00:00 UTC, as an ISO 8601 date and time. Weeks run Monday to Monday.",
        },
        seasonWeeks: {
          type: "integer",
          nullable: true,
          description: "How many weeks the season lasts. A trade outside them earns nothing.",
        },
        weeklyPoints: {
          type: "integer",
          nullable: true,
          description: "The points one week splits between its members.",
        },
        tradersThisWeek: {
          type: "integer",
          nullable: true,
          description:
            "How many members have a fee credited in the running week. Up to 60 seconds old. Null when rewards are off, outside the season (before week 0 begins and once the last week has ended), and when the database gave no answer.",
        },
      },
    },
    {
      enabled: {
        summary: "Points are handed out here",
        value: {
          enabled: true,
          seasonStart: "2026-10-19T00:00:00.000Z",
          seasonWeeks: SEASON_WEEKS,
          weeklyPoints: WEEKLY_POINTS,
          tradersThisWeek: 48,
        },
      },
      off: {
        summary: "No rewards",
        value: {
          enabled: false,
          seasonStart: null,
          seasonWeeks: null,
          weeklyPoints: null,
          tradersThisWeek: null,
        },
      },
    },
  )
  @ApiErrors({ session: true })
  async season(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    const admitted = await this.admission.forSession(req, { ...RULE, maxBodyBytes: 0 });
    if ("refused" in admitted) return send(res, admitted.refused);
    send(res, await this.rewards.config());
  }

  @Post("join")
  @ApiOperation({
    summary: "Join, and read the member's state",
    description: [
      "Makes a rewards key a member and gives it a referral code, or does nothing for a key that already is one. Either way the answer is the member's state, so joining twice is safe.",
      "",
      "**Who calls it:** the wallets, when the user turns rewards on, and again on a device the recovery phrase is restored to.",
      "",
      "**Signed.** `signature` is the rewards key's over the UTF-8 bytes of these five lines, joined by a line feed (`\\n`): `NoirWire rewards v1`, `join`, the rewards key, `at` in decimal, and the invite code. The invite code is signed as this server takes it: `inviteCode` with the spaces around it removed and in capital letters, or the empty string when none is sent. The fifth line is always there, so with no invite code the message ends with a line feed after `at`. A join whose `inviteCode` is not the one signed for is refused `403 signature_invalid`: nobody on the way can tie a new member to an inviter of their choosing. " +
        SIGNED_TIME,
      "",
      "**An invite code counts once.** `inviteCode` is taken only when the key is new, and only when it is the code of a member with at least one credited trade. For a new key with any other code the answer is `422 invite_code_invalid` and nothing is created; the wallet may join again with another code or with none. For a key that is already a member it is ignored. Letter case does not matter.",
      "",
      "**New members are rationed by the day.** No more than a configured number of keys (2,000 unless configured) become members on one UTC day, whoever asks. Past that a new key is answered `429 rate_limited` and nothing is created; it may join the next day. A key that is already a member is answered `200` as always.",
      "",
      NO_WALLET_ADDRESS,
      "",
      KEPT,
      "",
      QUOTAS,
      "",
      LOGGED,
    ].join("\n"),
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["rewardsKey", "at", "signature"],
      additionalProperties: false,
      properties: {
        rewardsKey,
        at,
        signature: signatureOf("the join message"),
        inviteCode: {
          type: "string",
          maxLength: 32,
          description: "Another member's referral code, when the user was given one.",
        },
      },
    },
    examples: {
      join: {
        summary: "Join (dummy values)",
        value: { rewardsKey: EXAMPLE.address, at: EXAMPLE_AT, signature: EXAMPLE.signature },
      },
      invited: {
        summary: "Join with an invite code (dummy values)",
        value: {
          rewardsKey: EXAMPLE.address,
          at: EXAMPLE_AT,
          signature: EXAMPLE.signature,
          inviteCode: EXAMPLE_CODE,
        },
      },
    },
  })
  @ok("The member's state.", STATE, {
    state: { summary: "A member (dummy values)", value: EXAMPLE_STATE },
  })
  @errors(
    "The body is not JSON, or is not exactly `{ rewardsKey, at, signature }` with an optional `inviteCode`.",
    {
      403: {
        ...UNSIGNED,
        why: `${UNSIGNED.why} A join whose \`inviteCode\` differs from the one in the signed message is refused the same way.`,
      },
      429: {
        why: "The day already has as many new members as it may. Nothing was created; a key that is already a member is not affected.",
        codes: { rate_limited: "Quota spent, or the day's new members are all taken" },
      },
      422: {
        why: "A new key named an invite code that is unknown or not active yet. Nothing was created. This is the only `422` of this route: the invite code is not valid.",
        codes: {
          invite_code_invalid: "The invite code is unknown, or its member has no credited trade",
        },
      },
    },
  )
  join(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    return this.answer(req, res, RULE, (body) => this.rewards.join(body));
  }

  @Post("state")
  @ApiOperation({
    summary: "Read a member's state",
    description: [
      "The member's code, how many joined with it, the points from settled weeks, and the running week as it stands.",
      "",
      "**Who calls it:** the wallets, when the rewards screen opens.",
      "",
      "**Signed.** `signature` is the rewards key's over these four lines, joined by a line feed and with none after the last: `NoirWire rewards v1`, `state`, the rewards key, `at` in decimal. " +
        SIGNED_TIME,
      "",
      `**How points come about.** A member's score for a week is the fees of their own claimed trades, times 1.1 while they are a member who joined with a code and within ${INVITED_BONUS_WEEKS} weeks of the week they joined in, plus 0.2 of the fees of the members who joined with their code. A trade made in a week before its member joined, and claimed after, counts once and earns the inviter nothing. A week is settled once, on the first request that reaches this server more than 24 hours after it ended: its ${WEEKLY_POINTS.toLocaleString("en-US")} points are split by score, each share rounded down. A week with no fees hands out nothing.`,
      "",
      NO_WALLET_ADDRESS,
      "",
      QUOTAS,
      "",
      LOGGED,
    ].join("\n"),
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["rewardsKey", "at", "signature"],
      additionalProperties: false,
      properties: { rewardsKey, at, signature: signatureOf("the state message") },
    },
    examples: {
      state: {
        summary: "Read (dummy values)",
        value: { rewardsKey: EXAMPLE.address, at: EXAMPLE_AT, signature: EXAMPLE.signature },
      },
    },
  })
  @ok("The member's state.", STATE, {
    state: { summary: "A member (dummy values)", value: EXAMPLE_STATE },
  })
  @errors("The body is not JSON, or is not exactly `{ rewardsKey, at, signature }`.", {
    404: {
      why: "The rewards key has not joined. Also answered, as `not_found`, where this deployment hands out no points.",
      codes: { not_a_member: "The key has not joined", ...OFF.codes },
    },
    403: UNSIGNED,
  })
  state(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    return this.answer(req, res, RULE, (body) => this.rewards.state(body));
  }

  @Post("claims")
  @ApiOperation({
    summary: "Claim a trade's fee for a member",
    description: [
      "Credits a member with the fee one of their trades paid NoirWire. The fee is not taken from the request: this server reads the transaction from its own RPC provider, once the chain has finalized it, and credits what NoirWire's referral account received in it.",
      "",
      "**Who calls it:** the wallets, after a trade of a portfolio whose user has joined.",
      "",
      "**Signed twice.** `rewardsSignature` and `portfolioSignature` are the rewards key's and the portfolio's over the same four lines, joined by a line feed and with none after the last: `NoirWire rewards v1`, `claim`, the rewards key, the transaction's id. The portfolio's signature is what stops anyone else claiming the trade; the rewards key's is what stops a portfolio's trades being claimed for a member who did not ask.",
      "",
      "**Every check is made on the transaction itself**, as the chain recorded it:",
      "",
      "- It is finalized, under exactly this id, and it succeeded.",
      "- `portfolio` is one of its signers.",
      "- The USDC token account of NoirWire's referral account holds more after it than before, by the transaction's own token balances. That increase is the fee.",
      "- Its block time is inside the season, and no more than 24 hours have passed since the week it falls in ended.",
      "",
      "**A trade is credited once**, whoever claims it. A second claim of the same transaction is answered `409 already_claimed` and changes nothing.",
      "",
      "**Contains wallet addresses: yes.** The portfolio, next to the rewards key and the transaction. This is the one rewards request that names one. **Forwarded upstream:** the transaction's id alone, to the RPC provider, from this server's address. **Stored:** the fee, added to the member's week, and a keyed fingerprint of the transaction's id (HMAC-SHA256 under a secret only this server holds). The portfolio and the id itself are used for the checks and then dropped: neither is stored, logged or put in an error.",
      "",
      `**Quotas (per minute):** ${CLAIM_LIMITS.perSession} per session, ${CLAIM_LIMITS.perIp} per address, ${CLAIM_LIMITS.total} in total. The read of the chain also waits its turn at the RPC provider's allowance, like \`POST /v1/rpc\`.`,
      "",
      LOGGED,
    ].join("\n"),
  })
  @ApiBody({
    schema: {
      type: "object",
      required: [
        "rewardsKey",
        "transaction",
        "portfolio",
        "portfolioSignature",
        "rewardsSignature",
      ],
      additionalProperties: false,
      properties: {
        rewardsKey,
        transaction: {
          type: "string",
          description: "The trade's id: the transaction's first signature, base58.",
        },
        portfolio: address("The portfolio that signed the trade. Never the rewards key."),
        portfolioSignature: {
          type: "string",
          description:
            "The portfolio's ed25519 signature over the UTF-8 bytes of the claim message, base58.",
        },
        rewardsSignature: signatureOf("the claim message"),
      },
    },
    examples: {
      claim: {
        summary: "Claim a trade (dummy values)",
        value: {
          rewardsKey: EXAMPLE.address,
          transaction: EXAMPLE.signature,
          portfolio: EXAMPLE.otherAddress,
          portfolioSignature: EXAMPLE.signature,
          rewardsSignature: EXAMPLE.signature,
        },
      },
    },
  })
  @ok(
    "The trade was credited.",
    {
      type: "object",
      required: ["credited", "feeMicroUsdc", "state"],
      properties: {
        credited: { type: "boolean", enum: [true], description: "Always true." },
        feeMicroUsdc: {
          type: "string",
          description: "The fee credited, in millionths of a USDC, as a string.",
        },
        state: { ...STATE, description: "The member's state after the credit." },
      },
    },
    {
      credited: {
        summary: "Credited (dummy values)",
        value: { credited: true, feeMicroUsdc: "61000", state: EXAMPLE_STATE },
      },
    },
  )
  @errors(
    "The body is not JSON, is not exactly `{ rewardsKey, transaction, portfolio, portfolioSignature, rewardsSignature }`, or names one key as both the rewards key and the portfolio.",
    {
      404: {
        why: "The rewards key has not joined. Also answered, as `not_found`, where this deployment hands out no points.",
        codes: { not_a_member: "The key has not joined", ...OFF.codes },
      },
      409: {
        why: "The transaction was claimed before, by this member or another. Nothing changed.",
        codes: { already_claimed: "Claimed before" },
      },
      403: {
        why: "One of the two signatures is not its key's over the claim message. Nothing was read from the chain and nothing was credited.",
        codes: { signature_invalid: "A signature is not its key's over the claim message" },
      },
      422: {
        why: "The transaction failed one of the checks above. Nothing was credited. Only `transaction_not_finalized` is worth asking again for: the chain finalizes a transaction some seconds after it lands.",
        codes: {
          transaction_not_finalized: "Not finalized yet, or not found: ask again shortly",
          transaction_failed: "The transaction failed on chain",
          not_a_signer: "The portfolio is not a signer of the transaction",
          no_referral_fee: "No USDC reached NoirWire's referral account in it",
          outside_claim_window: "Outside the season, or its week closed more than 24 hours ago",
        },
      },
    },
  )
  claims(@Req() req: SessionRequest, @Res() res: Response): Promise<void> {
    return this.answer(req, res, CLAIM_RULE, (body) =>
      this.rewards.claim(body, callerOf(req, this.config)),
    );
  }

  /** Admits the request, then answers with what the rewards logic makes of its body. */
  private async answer(
    req: SessionRequest,
    res: Response,
    rule: typeof RULE,
    handle: (body: string) => Promise<Answer>,
  ): Promise<void> {
    const admitted = await this.admission.forSession(req, {
      ...rule,
      maxBodyBytes: REWARDS_MAX_BODY_BYTES,
    });
    if ("refused" in admitted) return send(res, admitted.refused);
    send(res, await handle(admitted.body));
  }
}

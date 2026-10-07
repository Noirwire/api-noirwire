import { PublicKey } from "@solana/web3.js";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { isAddress } from "../../chain/core/network.js";
import type { Signer } from "../../chain/core/signatures.js";
import {
  answer,
  rateRefusal,
  refusal,
  type Answer,
  type ErrorCode,
} from "../../common/core/answer.js";
import type { Log } from "../../common/core/log.js";
import {
  HOUR_MS,
  type Budget,
  type Caller,
  type QuotaStore,
  type RouteLimits,
} from "../../common/core/quota.js";
import { profileAddress, programErrorOf } from "./program.js";
import { PROFILE_ROUTE, type Asked, type Rollup, type RpcError } from "./rollup.js";
import { forRollup, readProfileTransaction, type ProfilePins } from "./transaction.js";

/**
 * The wallet's only way to its profile: a small record of its own labels
 * that it encrypts on the device and keeps on a private rollup, so that
 * restoring the recovery phrase elsewhere brings them back. The rollup sees
 * this server's address and never a user's, and this server and the rollup
 * only ever see ciphertext.
 *
 * A profile belongs to a key derived for it alone. It is never the funding
 * wallet's key and never a portfolio's, so nothing here names a wallet.
 *
 * This is not a signing service. The gate key is held here and nowhere
 * else, it is the fee payer of every creation and every write, and a
 * creation spends rent that the program's sponsor puts up. So a transaction
 * is decoded here and held to one of three exact shapes (transaction.ts)
 * before the gate signs, and creations are rationed harder than anything
 * else this API does.
 *
 * It is not a proxy to the rollup either: five calls, each written here
 * from scratch, and the account a read is for is derived here from the
 * owner key, never named by the caller.
 */

/** A transaction with the largest record a deployment may allow is about 4.6 KB, 6.2 KB encoded. */
const MAX_TRANSACTION_CHARS = 8_192;
export const PROFILE_MAX_BODY_BYTES = 16 * 1024;
/** A sync is a sign-in, a read, a blockhash and a write, and a retry of the last three. */
export const PROFILE_LIMITS: RouteLimits = { perSession: 60, perIp: 600, total: 1_200 };

/**
 * Creating a profile is the one call that spends money: the sponsor's rent,
 * which comes back only when that profile is closed. A wallet creates one
 * profile, once. So creations are rationed per session and per address far
 * under anything a person reaches, and in total by `dailyCreateCap`: the
 * most creations the gate signs in one window of 24 hours, whoever asks.
 * When that is spent creation stops and everything else goes on.
 *
 * A write that grows a record spends a little rent too, and a healthy wallet
 * writes a handful of times a day, so writes are rationed per session.
 *
 * None of this is a hard limit. Each counter lives in the memory of one
 * process, a restart forgets it, and a session costs nothing to replace.
 * The hard limit on what can be lost is the SOL the sponsor holds.
 */
export const CREATIONS_PER_HOUR_PER_SESSION = 3;
export const CREATIONS_PER_HOUR_PER_IP = 10;
export const WRITES_PER_HOUR_PER_SESSION = 30;
export const DAY_MS = 24 * HOUR_MS;

const creatorBudgets = (caller: Caller): Budget[] => [
  {
    scope: "session",
    key: `profile-create|${caller.sessionId}`,
    limit: CREATIONS_PER_HOUR_PER_SESSION,
    windowMs: HOUR_MS,
  },
  {
    scope: "ip",
    key: `profile-create|${caller.ip}`,
    limit: CREATIONS_PER_HOUR_PER_IP,
    windowMs: HOUR_MS,
  },
];

const writerBudgets = (caller: Caller): Budget[] => [
  {
    scope: "session",
    key: `profile-write|${caller.sessionId}`,
    limit: WRITES_PER_HOUR_PER_SESSION,
    windowMs: HOUR_MS,
  },
];

/**
 * How long a sent transaction is waited for. The rollup confirms in well
 * under a second, so one that has not landed by now is reported as not
 * known to have: the wallet sends the very same transaction again, and the
 * rollup answers that it already has it.
 */
export const CONFIRM_TIMEOUT_MS = 6_000;
const CONFIRM_POLL_MS = 150;
const CONFIRMED: ReadonlySet<string> = new Set(["confirmed", "finalized"]);

/** The program's refusals a wallet acts on. Each is answered under the program's own name for it. */
export const PROFILE_CONFLICTS = [
  "Paused",
  "RecordTooLarge",
  "ProfileExists",
  "ProfileMissing",
  "StaleRevision",
] as const satisfies readonly ErrorCode[];

const owner = z.string().refine(isAddress);
/** The rollup's read token: opaque here, and bounded so that it can travel in a query string. */
const token = z.string().regex(/^[A-Za-z0-9._~+/=-]{1,2048}$/);
const blockhash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

const challengeRequest = z.strictObject({ owner });
const sessionRequest = z.strictObject({
  owner,
  challenge: z.string().min(1).max(1_024),
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
});
const readRequest = z.strictObject({ owner, token });
const blockhashRequest = z.strictObject({ token });
const submitRequest = z.strictObject({
  token,
  transaction: z
    .string()
    .max(MAX_TRANSACTION_CHARS)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

const challengeReply = z.object({ challenge: z.string().min(1).max(1_024) });
const sessionReply = z.object({ token, expiresAt: z.number().int().positive().optional() });
const accountReply = z.object({
  value: z
    .object({
      data: z.tuple([z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/), z.literal("base64")]),
    })
    .nullable(),
});
const blockhashReply = z.object({
  value: z.object({ blockhash, lastValidBlockHeight: z.number().int().nonnegative() }),
});
const statusesReply = z.object({
  value: z.tuple([
    z.object({ err: z.unknown().optional(), confirmationStatus: z.string().nullish() }).nullable(),
  ]),
});

/** The request in `body` when it is exactly what `schema` describes, or null. */
function requested<T>(schema: z.ZodType<T>, body: string): T | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const request = schema.safeParse(json);
  return request.success ? request.data : null;
}

/** The rollup says this of a transaction it has run before, byte for byte. */
function alreadyProcessed(error: RpcError): boolean {
  return (
    error.data?.err === "AlreadyProcessed" || /already (been )?processed/i.test(error.message ?? "")
  );
}

/** The profile program on its rollup, and the key this server signs as. */
export type ProfileUpstream = {
  rollup: Rollup;
  pins: ProfilePins;
  /** The most creations signed in one window of 24 hours, whoever asks. */
  dailyCreateCap: number;
  signAsGate: Signer;
};

export type ProfileDeps = {
  /** Null when this deployment keeps no profiles. */
  upstream: ProfileUpstream | null;
  quotas: QuotaStore;
  log: Log;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type Profiles = {
  /** Whether profiles are kept here, and what a wallet builds a transaction against. */
  config(): Answer;
  challenge(body: string): Promise<Answer>;
  session(body: string): Promise<Answer>;
  read(body: string): Promise<Answer>;
  blockhash(body: string): Promise<Answer>;
  submit(body: string, caller: Caller): Promise<Answer>;
};

export function createProfiles(deps: ProfileDeps): Profiles {
  const { upstream, quotas, log } = deps;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const invalid = () => refusal("invalid_request");
  /** Every route but `config` when there is nothing configured: as if it were not there. */
  const absent = () => refusal("not_found");

  /** A fixed word for the operator, and one of this API's errors for the caller. */
  function failed(code: ErrorCode, reason: string): Answer {
    const answered = refusal(code);
    log({ event: "refusal", route: PROFILE_ROUTE, status: answered.status, reason });
    return answered;
  }

  /** What the rollup answered, when it is what `schema` describes. */
  function answered<T>(asked: Asked, schema: z.ZodType<T>, reason: string): T | Answer {
    if ("failed" in asked) return asked.failed;
    const reply = schema.safeParse(asked.json);
    return reply.success ? reply.data : failed("upstream_failed", reason);
  }
  const isAnswer = (value: object): value is Answer => "status" in value && "body" in value;

  /** One JSON-RPC call's result, when it is what `schema` describes. */
  async function called<T>(
    rollup: Rollup,
    readToken: string,
    method: string,
    params: unknown[],
    schema: z.ZodType<T>,
  ): Promise<T | Answer> {
    const reply = await rollup.call(readToken, method, params);
    if ("failed" in reply) return reply.failed;
    if ("error" in reply) return failed("upstream_failed", "rollup_refused_the_call");
    return answered({ json: reply.result }, schema, "rollup_answer_unusable");
  }

  /**
   * A transaction the program turned down. The refusals a wallet acts on
   * are answered under the program's name for them; any other failure says
   * nothing a wallet could use, and is an upstream failure like the rest.
   */
  function turnedDown(err: unknown): Answer {
    const name = programErrorOf(err);
    const conflict = PROFILE_CONFLICTS.find((code) => code === name);
    return conflict ? failed(conflict, conflict) : failed("upstream_failed", "transaction_failed");
  }

  /** Waits for `signature` to land. `known` is set when the rollup said it had the transaction already. */
  async function confirmed(
    rollup: Rollup,
    readToken: string,
    signature: string,
    known: boolean,
  ): Promise<Answer> {
    const deadline = now() + CONFIRM_TIMEOUT_MS;
    for (;;) {
      const statuses = await called(
        rollup,
        readToken,
        "getSignatureStatuses",
        [[signature]],
        statusesReply,
      );
      if (isAnswer(statuses)) return statuses;
      const [landed] = statuses.value;
      if (landed?.err != null) return turnedDown(landed.err);
      if (landed && CONFIRMED.has(landed.confirmationStatus ?? "")) {
        return answer(200, { signature });
      }
      if (now() >= deadline) break;
      await sleep(CONFIRM_POLL_MS);
    }
    // A transaction the rollup has already run and no longer reports on did
    // land: it is the one this server sent a moment ago.
    return known
      ? answer(200, { signature })
      : failed("upstream_timeout", "transaction_not_confirmed");
  }

  return {
    config() {
      return answer(
        200,
        upstream
          ? {
              enabled: true,
              programId: upstream.pins.programId.toBase58(),
              gate: upstream.pins.gate.toBase58(),
              maxDataLen: upstream.pins.maxDataLen,
            }
          : { enabled: false },
      );
    },

    async challenge(body) {
      if (!upstream) return absent();
      const request = requested(challengeRequest, body);
      if (!request) return invalid();
      const reply = answered(
        await upstream.rollup.challenge(request.owner),
        challengeReply,
        "rollup_gave_no_challenge",
      );
      return isAnswer(reply) ? reply : answer(200, { challenge: reply.challenge });
    },

    async session(body) {
      if (!upstream) return absent();
      const request = requested(sessionRequest, body);
      if (!request) return invalid();
      const reply = answered(
        await upstream.rollup.login(request.owner, request.challenge, request.signature),
        sessionReply,
        "rollup_gave_no_token",
      );
      if (isAnswer(reply)) return reply;
      return answer(200, { token: reply.token, expiresAt: reply.expiresAt });
    },

    async read(body) {
      if (!upstream) return absent();
      const request = requested(readRequest, body);
      if (!request) return invalid();
      const profile = profileAddress(upstream.pins.programId, new PublicKey(request.owner));
      const account = await called(
        upstream.rollup,
        request.token,
        "getAccountInfo",
        [profile.toBase58(), { encoding: "base64", commitment: "confirmed" }],
        accountReply,
      );
      if (isAnswer(account)) return account;
      return answer(200, { data: account.value?.data[0] || null });
    },

    async blockhash(body) {
      if (!upstream) return absent();
      const request = requested(blockhashRequest, body);
      if (!request) return invalid();
      const latest = await called(
        upstream.rollup,
        request.token,
        "getLatestBlockhash",
        [{ commitment: "confirmed" }],
        blockhashReply,
      );
      if (isAnswer(latest)) return latest;
      const { blockhash, lastValidBlockHeight } = latest.value;
      return answer(200, { blockhash, lastValidBlockHeight });
    },

    async submit(body, caller) {
      if (!upstream) return absent();
      const request = requested(submitRequest, body);
      if (!request) return invalid();

      const read = readProfileTransaction(
        Buffer.from(request.transaction, "base64"),
        upstream.pins,
      );
      if (!read.ok) return failed("refused", read.reason);

      // Counted only for a transaction the gate would really sign, so that
      // posting rubbish cannot spend the creations everyone shares.
      if (read.action === "create") {
        if (!quotas.take(creatorBudgets(caller), now())) return rateRefusal();
        const cap: Budget = {
          scope: "global",
          key: "profile-creations|day",
          limit: upstream.dailyCreateCap,
          windowMs: DAY_MS,
        };
        if (!quotas.take([cap], now())) return failed("rate_limited", "daily_create_cap_reached");
      }
      if (read.action === "write" && !quotas.take(writerBudgets(caller), now())) {
        return rateRefusal();
      }

      const { transaction, signature } = forRollup(read, upstream.signAsGate);
      const sent = await upstream.rollup.call(request.token, "sendTransaction", [
        Buffer.from(transaction).toString("base64"),
        { encoding: "base64", skipPreflight: true },
      ]);
      if ("failed" in sent) return sent.failed;
      const known = "error" in sent && alreadyProcessed(sent.error);
      if ("error" in sent && !known) return turnedDown(sent.error.data?.err);
      return confirmed(upstream.rollup, request.token, signature, known);
    },
  };
}

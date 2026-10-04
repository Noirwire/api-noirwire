import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "node:buffer";
import { createHmac, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import {
  answer,
  codeOf,
  parsed,
  rateRefusal,
  refusal,
  type Answer,
} from "../../common/core/answer.js";
import type { Log } from "../../common/core/log.js";
import {
  HOUR_MS,
  MINUTE_MS,
  type Budget,
  type Caller,
  type QuotaStore,
  type RouteLimits,
} from "../../common/core/quota.js";
import type { Relay } from "../../common/core/relay.js";
import { base58, bytesEqual } from "../../chain/core/bytes.js";
import type { RelayerConfig } from "../../config/core/config.js";
import type { AccountRent } from "./accountRent.js";
import { lamportsInUsdc, readRelayed, relayedCostLamports, relayerFeeCap } from "./relayed.js";
import type { SolPrice } from "./solPrice.js";

/**
 * The wallet's only way to the fee relayer, a Kora server that co-signs a
 * transaction as its fee payer and is paid back in USDC inside that same
 * transaction. The relayer sees this server's address and never a user's.
 * The relayer's URL, API key and HMAC secret stay on this server.
 *
 * This is not a signing service. Anyone can call it without ever running
 * the wallet, and a session token says nothing about who holds it, so
 * nothing the wallet checks before it signs can be assumed. Every
 * transaction, for a price or for a signature, is decoded here and held to
 * the complete template of a relayer-paid action (relayed.ts): a pinned fee
 * payer, one portfolio beside it, one known action, one bounded payment, and
 * nothing else. A request for a signature must already carry the
 * portfolio's own valid signature. What does not fit is refused before the
 * relayer hears of it.
 *
 * The price is this route's too, not the relayer's. The relayer checks that
 * a payment covers what it works out the transaction costs, and one of its
 * releases works that out wrongly: it charges no rent for opening a token
 * account that exists when it looks, and that account can be closed before
 * the transaction lands. So this route asks for the rent of every account
 * the relayer is told to open, existing or not, at a SOL price it reads
 * itself, and signs nothing that pays less. The relayer accepts more than
 * it asks for, and can only be reached with the credentials kept here.
 *
 * It is not a JSON-RPC proxy either. Three methods pass, one call per
 * request, and each upstream request is written here from scratch: only the
 * named parameters travel, `sig_verify` is always false, and the
 * authentication headers are computed here and never taken from the caller.
 * An answer is returned only when every key in it is one this server pins,
 * so a misrouted or compromised relayer cannot hand the wallet a key of its
 * choosing.
 *
 * Nothing is ever broadcast from here. The relayer is asked to sign only,
 * and the signed transaction goes back to the wallet with its id (the fee
 * payer's signature, which exists only once the relayer has signed). The
 * wallet records that id durably and then sends the transaction itself
 * through /v1/rpc. Were it sent from here, a wallet that died right after
 * would have no id to look for, could take the action for one that never
 * went through, and the user would pay twice. A transaction that is signed
 * and never sent costs the relayer nothing; it still counts against the
 * signature budgets, which are taken at signing.
 *
 * A refusal is logged as a route name, a status and a fixed reason, never
 * the relayer's own message, which names addresses.
 */

const ROUTE = "relayer";

/** A transaction is at most 1,232 bytes, about 1.7 KB encoded. */
const MAX_TRANSACTION_CHARS = 2_048;
export const RELAYER_MAX_BODY_BYTES = 8 * 1024;
/** The largest answer is one signed transaction. */
const MAX_RESPONSE_BYTES = 16 * 1024;
/** A review asks twice and a confirmation twice more. */
export const RELAYER_LIMITS: RouteLimits = { perSession: 60, perIp: 600, total: 3_000 };

/**
 * Signing is what costs. A transaction the relayer signed and that then
 * fails on chain (its sender emptied the paying account first, say) still
 * has its network fee taken from the relayer, with nothing paid back. So
 * signatures are rationed twice: per session and per address, far under
 * what a person sending by hand reaches, and in total, per minute and per
 * hour, whoever asks.
 *
 * None of this is a hard limit. Each counter lives in the memory of one
 * process, a session costs nothing to replace, and the per-address count is
 * only as good as the client address the hosting edge supplies. The hard
 * limit on what can be lost is the SOL kept in each fee payer wallet, which
 * the operator keeps small: when it is gone that relayer signs nothing more.
 */
export const SIGNATURES_PER_MINUTE_PER_SESSION = 10;
export const SIGNATURES_PER_MINUTE_PER_IP = 30;
export const SIGNATURES_PER_MINUTE = 60;
export const SIGNATURES_PER_HOUR = 600;

const signerBudgets = (caller: Caller): Budget[] => [
  {
    scope: "session",
    key: `relayer-sign|${caller.sessionId}`,
    limit: SIGNATURES_PER_MINUTE_PER_SESSION,
    windowMs: MINUTE_MS,
  },
  {
    scope: "ip",
    key: `relayer-sign|${caller.ip}`,
    limit: SIGNATURES_PER_MINUTE_PER_IP,
    windowMs: MINUTE_MS,
  },
];

/** One signature from the budget everyone shares, per minute and per hour, or none when either is spent. */
const SIGNATURE_BUDGET: Budget[] = [
  {
    scope: "global",
    key: "relayer-signatures|minute",
    limit: SIGNATURES_PER_MINUTE,
    windowMs: MINUTE_MS,
  },
  {
    scope: "global",
    key: "relayer-signatures|hour",
    limit: SIGNATURES_PER_HOUR,
    windowMs: HOUR_MS,
  },
];

/**
 * How far under the current price a payment may be when it comes to be
 * signed. It was worked out from a price read moments earlier, and without
 * this a rise of a hundredth of a percent in between would refuse it. Two
 * percent is far inside the tenth that is charged on top of rent.
 */
const SIGNING_PRICE_SLACK_BPS = 200n;

type Params = Record<string, unknown>;

const unavailable = () => refusal("relayer_unavailable");
const invalid = () => refusal("invalid_request");

/**
 * The relayer's refusals, by the fixed part of its message. Its messages
 * name programs and accounts, so neither the log nor the wallet is given
 * one: the log gets the reason on the left, and the wallet is told only
 * whether the payment was too small, which is the one refusal it acts on.
 */
const RELAYER_REFUSALS: [reason: string, messagePart: string][] = [
  ["insufficient_payment", "Insufficient token payment"],
  ["simulation_failed", "Transaction simulation failed"],
  ["program_not_allowed", "is not in the allowed list"],
  ["fee_payer_policy", "Fee payer cannot be used"],
  ["transfer_limit", "exceeds maximum allowed"],
  ["too_many_signatures", "Too many signatures"],
  ["token_extension", "found on mint account"],
];

type RelayerAnswer = { result?: unknown; error?: unknown };

/** The fixed reason for one of the relayer's own refusals. */
function reasonOf(error: unknown): string {
  const text = (error as { message?: unknown } | null)?.message;
  const message = typeof text === "string" ? text : "";
  return RELAYER_REFUSALS.find(([, part]) => message.includes(part))?.[0] ?? "relayer_refused";
}

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const encodedTransaction = z
  .string()
  .max(MAX_TRANSACTION_CHARS)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);

function decode(encoded: unknown): VersionedTransaction | null {
  const text = encodedTransaction.safeParse(encoded);
  if (!text.success) return null;
  try {
    return VersionedTransaction.deserialize(Buffer.from(text.data, "base64"));
  } catch {
    return null;
  }
}

/** The fixed header of an ed25519 public key in the encoding Node's verifier reads. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Whether `signature` is `signer`'s over `message`. */
function signedBy(signer: PublicKey, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, signer.toBytes()]),
      format: "der",
      type: "spki",
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

type Forwarded = {
  params: { transaction: string; signer_key: string; sig_verify: false; fee_token?: string };
  /** The transaction as it was sent in, and the pinned key it names as fee payer. */
  decoded: VersionedTransaction;
  feePayer: PublicKey;
  requiredRaw: bigint;
  capRaw: bigint;
  solPrice: number;
};

/**
 * How far the relayer's own SOL price may sit from this server's before
 * nothing is priced or signed. The two come from different sources, Pyth
 * here and the relayer's own there, and agree to within a fraction of a
 * percent when both are right. Past this one of them is wrong, and which
 * one is not for a request to find out.
 */
const PRICE_DISAGREEMENT_BPS = 500;

/**
 * Whether the SOL price behind the relayer's estimate, which states one cost
 * in lamports and in USDC, agrees with `solPrice`.
 */
function pricesAgree(estimate: Params, solPrice: number): boolean {
  const { fee_in_lamports: lamports, fee_in_token: token } = estimate;
  if (typeof lamports !== "number" || typeof token !== "number" || !(lamports > 0)) return false;
  // A lamport is a billionth of a SOL and a raw unit a millionth of a dollar.
  const implied = (token / lamports) * 1_000;
  return Math.abs(implied / solPrice - 1) <= PRICE_DISAGREEMENT_BPS / 10_000;
}

/**
 * How long one replica is waited for. A relayer answers in well under a
 * second; one that has not by now is treated as down, and the next is asked.
 */
const REPLICA_TIMEOUT_MS = 8_000;

const METHODS = new Set(["getPayerSigner", "estimateTransactionFee", "signTransaction"]);

const isObject = (value: unknown): value is Params =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type RelayerDeps = {
  /** The relayer's replicas and pins, or null when there is no relayer. */
  upstream: RelayerConfig | null;
  /** The USDC mint of the configured network. */
  usdcMint: string;
  relay: Relay;
  solPrice: SolPrice;
  accountRent: AccountRent;
  quotas: QuotaStore;
  log: Log;
  random?: () => number;
  now?: () => number;
};

export type Relayer = {
  /** Whether there is a relayer, the keys a relayer-paid transaction is built against, and whether it may open a token account. */
  pins(): Answer;
  call(body: string, caller: Caller): Promise<Answer>;
};

export function createRelayer(deps: RelayerDeps): Relayer {
  const { upstream, usdcMint, relay, quotas, log } = deps;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;

  /**
   * A refusal that came from a check, here or on the relayer. This line is
   * the operator's count of them: the relayer answers its own refusals with
   * a 200, so they show in nobody's status codes. It carries a fixed word
   * and never an address, an amount or the relayer's message.
   */
  function refused(reason: string): Answer {
    log({ event: "refusal", route: ROUTE, status: 422, reason });
    return refusal(reason === "insufficient_payment" ? "insufficient_payment" : "refused");
  }

  /** `items` in a random order, so that no replica is always the first to be asked. */
  function shuffled<T>(items: T[]): T[] {
    const order = [...items];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  /** One authenticated call to one replica. The signature covers the timestamp and the body exactly as sent. */
  function ask(config: RelayerConfig, url: string, method: string, params?: Params) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
    const timestamp = String(Math.floor(now() / 1000));
    return relay(ROUTE, url, {
      method: "POST",
      body,
      headers: {
        "x-api-key": config.apiKey,
        "x-timestamp": timestamp,
        "x-hmac-signature": createHmac("sha256", config.hmacSecret)
          .update(timestamp + body)
          .digest("hex"),
      },
      maxResponseBytes: MAX_RESPONSE_BYTES,
      timeoutMs: REPLICA_TIMEOUT_MS,
    });
  }

  /**
   * Finds a replica to pay for the next transaction: asked in a random
   * order, the first that answers as the fee payer this server pins for it.
   * One that does not answer, or answers with anything else, is passed over.
   * `not` names fee payers the caller has just seen fail, which are not
   * asked again.
   *
   * Nothing has been signed at this point, so moving on to the next replica
   * costs nothing. Once a transaction is built it names its fee payer, and
   * only that replica can sign it: failing over after that is the wallet's
   * to do, by building again against another replica.
   */
  async function payerSigner(config: RelayerConfig, not: unknown): Promise<Answer> {
    const skipped = Array.isArray(not) ? not : [];
    const candidates = shuffled(
      config.replicas.filter((replica) => !skipped.includes(replica.feePayer)),
    );
    for (const replica of candidates) {
      const replied = await ask(config, replica.url, "getPayerSigner");
      const payload = replied.status === 200 ? parsed(replied) : null;
      const result = isObject(payload) && isObject(payload.result) ? payload.result : null;
      if (
        result?.signer_address === replica.feePayer &&
        result.payment_address === config.paymentWallet
      ) {
        return answer(200, {
          result: { signer_address: replica.feePayer, payment_address: config.paymentWallet },
        });
      }
      log({
        event: "refusal",
        route: ROUTE,
        status: replied.status,
        reason: "replica_passed_over",
      });
    }
    return unavailable();
  }

  /**
   * The upstream parameters for `method`, rebuilt from the named fields
   * alone, with what this route charges for the transaction, or the fixed
   * reason the request is not one the relayer is asked.
   */
  async function forwarded(
    method: string,
    params: Params,
    config: RelayerConfig,
  ): Promise<Forwarded | string> {
    const { transaction } = params;
    const decoded = decode(transaction);
    const signer = address.safeParse(params.signer_key);
    if (!decoded || !signer.success || typeof transaction !== "string") return "not_a_transaction";
    const signerKey = signer.data;

    const reading = readRelayed(decoded, {
      feePayers: config.feePayers.map((key) => new PublicKey(key)),
      paymentWallet: new PublicKey(config.paymentWallet),
      usdcMint: new PublicKey(usdcMint),
      accountCreation: config.accountCreation,
    });
    if (!reading.ok) return reading.reason;
    const { relayed } = reading;
    if (relayed.feePayer.toBase58() !== signerKey) return "fee_payer_not_pinned";

    const price = await deps.solPrice(now());
    if (price === null) return "no_price";
    const rent = relayed.opens
      ? await deps.accountRent(relayed.opens.mint, relayed.opens.programId, now())
      : null;
    if (relayed.opens && rent === null) return "no_price";
    const requiredRaw = lamportsInUsdc(relayedCostLamports(rent), price);
    const capRaw = relayerFeeCap(relayed.opens !== null);
    // The price has outrun the cap: nothing is charged above it, so nothing is signed.
    if (requiredRaw > capRaw) return "price_above_cap";

    const common = { transaction, signer_key: signerKey, sig_verify: false as const };
    const facts = { decoded, feePayer: relayed.feePayer, requiredRaw, capRaw, solPrice: price };
    if (method === "estimateTransactionFee") {
      return params.fee_token === usdcMint
        ? { params: { ...common, fee_token: usdcMint }, ...facts }
        : "fee_token";
    }
    if (relayed.feeRaw < (requiredRaw * (10_000n - SIGNING_PRICE_SLACK_BPS)) / 10_000n) {
      return "insufficient_payment";
    }
    // The relayer's signature is only ever added to one the portfolio has
    // committed to: an unsigned transaction is somebody probing, not sending.
    if (!signedBy(relayed.portfolio, decoded.message.serialize(), decoded.signatures[1])) {
      return "portfolio_signature";
    }
    return { params: common, ...facts };
  }

  /**
   * The answer as the wallet may have it: the fields it reads and nothing
   * else, and only when every key in it is one this server pins. The fee is
   * this route's charge, or the relayer's own figure when that is higher (it
   * prices from a source of its own, which can sit a little above ours), and
   * never one above the cap.
   */
  function checked(method: string, result: Params, sent: Forwarded, config: RelayerConfig) {
    const signerKey = sent.params.signer_key;
    if (result.signer_pubkey !== signerKey) return null;
    if (method === "estimateTransactionFee") {
      const { fee_in_token: asked, payment_address: payment } = result;
      if (typeof asked !== "number" || !Number.isSafeInteger(asked) || asked < 0) return null;
      if (payment !== config.paymentWallet) return null;
      if (!pricesAgree(result, sent.solPrice)) return "price_disagreement";
      const fee = BigInt(asked) > sent.requiredRaw ? BigInt(asked) : sent.requiredRaw;
      if (fee > sent.capRaw) return "price_above_cap";
      return { fee_in_token: Number(fee), signer_pubkey: signerKey, payment_address: payment };
    }
    // The relayer only ever adds its signature. What comes back is held to
    // that: the same message byte for byte, the portfolio's signature
    // untouched, and a valid signature of the pinned fee payer, which is
    // also the transaction's id.
    const signed = decode(result.signed_transaction);
    if (!signed || signed.signatures.length !== 2) return null;
    const message = sent.decoded.message.serialize();
    if (!bytesEqual(signed.message.serialize(), message)) return null;
    if (!bytesEqual(signed.signatures[1], sent.decoded.signatures[1])) return null;
    if (!signedBy(sent.feePayer, message, signed.signatures[0])) return null;
    return {
      transaction: Buffer.from(signed.serialize()).toString("base64"),
      signature: base58(signed.signatures[0]),
    };
  }

  return {
    pins() {
      return answer(
        200,
        upstream
          ? {
              available: true,
              feePayers: upstream.feePayers,
              paymentWallet: upstream.paymentWallet,
              accountCreation: upstream.accountCreation,
            }
          : { available: false },
      );
    },

    async call(body, caller) {
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return invalid();
      }
      if (!isObject(json)) return invalid();
      const { method, params = {} } = json;
      if (typeof method !== "string" || !METHODS.has(method)) {
        return refusal("method_not_allowed");
      }
      if (!isObject(params)) return invalid();

      if (!upstream) return unavailable();
      if (method === "getPayerSigner") return payerSigner(upstream, params.not);

      const signing = method === "signTransaction";
      if (signing && !quotas.take(signerBudgets(caller), now())) return rateRefusal();
      const sent = await forwarded(method, params, upstream);
      if (sent === "no_price") {
        log({ event: "refusal", route: ROUTE, status: 503, reason: "no_price_or_rent" });
        return unavailable();
      }
      if (typeof sent === "string") return refused(sent);
      // Counted only for a transaction that would really be signed, so that
      // posting rubbish cannot spend the budget everyone shares.
      if (signing && !quotas.take(SIGNATURE_BUDGET, now())) {
        log({ event: "refusal", route: ROUTE, status: 429, reason: "signature_budget_spent" });
        return rateRefusal();
      }

      // The transaction names its fee payer, so only that key's replica can serve it.
      const replica = upstream.replicas.find((entry) => entry.feePayer === sent.params.signer_key);
      if (!replica) return refused("fee_payer_not_pinned");
      // Nothing is signed while this server's price and the relayer's
      // disagree: the relayer is asked what it would charge first, which also
      // tells whether it is there at all before it is handed anything to sign.
      if (signing) {
        const asked = await ask(upstream, replica.url, "estimateTransactionFee", {
          ...sent.params,
          fee_token: usdcMint,
        });
        const estimate = asked.status === 200 ? (parsed(asked) as RelayerAnswer | null) : null;
        if (estimate?.error) return refused(reasonOf(estimate.error));
        const quoted = estimate?.result;
        if (!isObject(quoted)) return unavailable();
        if (!pricesAgree(quoted, sent.solPrice)) return refused("price_disagreement");
      }
      const replied = await ask(upstream, replica.url, method, sent.params);
      // Never connected: this replica did not receive the request.
      if (replied.status === 503) return unavailable();
      // Turned away for this server's credentials (logged by the relay as
      // an operator error) or for its method: the replica did nothing with
      // the request, so the wallet may build again for another. Never a 401,
      // which would blame the caller's session.
      if (codeOf(replied) === "upstream_refused" || replied.status === 405) {
        log({ event: "refusal", route: ROUTE, status: 503, reason: "replica_refused_the_request" });
        return unavailable();
      }
      if (replied.status !== 200) return refusal("no_answer");

      const payload = parsed(replied) as RelayerAnswer | null;
      if (payload?.error) return refused(reasonOf(payload.error));
      const result = payload?.result;
      const safe = isObject(result) ? checked(method, result, sent, upstream) : null;
      if (typeof safe === "string") return refused(safe);
      if (!safe) {
        log({ event: "refusal", route: ROUTE, status: 502, reason: "answer_not_pinned_keys" });
        return refusal("no_answer");
      }
      // A price is wrapped as the relayer wraps it. A signed transaction is
      // handed back bare, with its id: this route never broadcasts, so the
      // wallet can record the id before anything is sent.
      return answer(200, signing ? safe : { result: safe });
    },
  };
}

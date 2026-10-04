import { createHmac } from "node:crypto";
import {
  ACCOUNT_SIZE,
  ExtensionType,
  getAccountLen,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, VersionedTransaction, type PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it } from "vitest";
import { base58 as bs58 } from "../../src/chain/core/bytes.js";
import type { ChainReader } from "../../src/chain/core/chainReader.js";
import type { LogLine } from "../../src/common/core/log.js";
import { createMemoryQuotaStore, type Caller } from "../../src/common/core/quota.js";
import { createRelay } from "../../src/common/core/relay.js";
import type { RelayerConfig } from "../../src/config/core/config.js";
import { associatedAccountLen, createAccountRent } from "../../src/relayer/core/accountRent.js";
import {
  lamportsInUsdc,
  LEND_RECEIPT_MINT,
  MAX_RELAYER_FEE_RAW,
  relayedCostLamports,
} from "../../src/relayer/core/relayed.js";
import { createRelayer, type Relayer } from "../../src/relayer/core/relayer.js";
import {
  createSolPrice,
  decodePythPrice,
  MIN_SOL_PRICE_USD,
} from "../../src/relayer/core/solPrice.js";
import {
  ataFor,
  coSigned,
  mintAccount,
  OPENING_FEE,
  PLAIN_FEE,
  PYTH_ACCOUNT,
  pythAccount,
  rentOf,
  scenario,
  tracker,
  TRACKER_OPENING_FEE,
  USDC,
} from "../support/transactions.js";

/**
 * The relayer route's logic, held to every hostile variation of a
 * relayer-paid transaction, with a stand-in for the relayer (Kora) and for
 * the chain. No framework is involved.
 */

const KORA = "https://kora.example";
const USDC_MINT = USDC.toBase58();
/** Dollars per SOL as the stubbed feed reports it. At this price one lamport is one raw USDC unit. */
const SOL_PRICE = 1_000;

const {
  relayer,
  paymentWallet,
  portfolio,
  recipient,
  owner,
  payment,
  sendUsdc,
  open,
  compile,
  genuine,
  hostile,
  encode,
  signedByPortfolio,
} = scenario();

type Params = Record<string, unknown>;
type Upstream = { url: string; headers: Record<string, string>; body?: string };

let upstream: Upstream[];
let logged: LogLine[];
let clock: number;
let solPrice: number | null;
/** The SOL price behind the relayer's own estimates. It follows `solPrice` unless a test parts them. */
let koraPrice: number | null;
let priceAge: number;
let trackerExtensions: [type: number, length: number][];
let readableMints: boolean;
let pythReads: number;
let koraAnswer: (method: string, params: Params, url: string) => Response;
let throwOn: ((method: string) => string | null) | null;
let subject: Relayer;
let visitor = 0;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The relayer's estimate of a cost of `lamports`, in both units, at the price it goes by. */
function koraEstimate(lamports: number, signer = relayer.publicKey.toBase58()) {
  const price = koraPrice ?? solPrice ?? SOL_PRICE;
  return {
    fee_in_lamports: lamports,
    fee_in_token: Math.ceil((lamports * price) / 1_000),
    signer_pubkey: signer,
    payment_address: paymentWallet.toBase58(),
  };
}

const chain: ChainReader = {
  async getAccountInfo(address: PublicKey) {
    const key = address.toBase58();
    if (key === PYTH_ACCOUNT) {
      pythReads += 1;
      return solPrice === null ? null : pythAccount(solPrice, priceAge, { now: clock });
    }
    if (!readableMints) return null;
    if (key === tracker.mint.toBase58()) {
      return mintAccount(TOKEN_2022_PROGRAM_ID, tracker.decimals, trackerExtensions);
    }
    if (key === USDC_MINT || key === LEND_RECEIPT_MINT.toBase58()) {
      return mintAccount(TOKEN_PROGRAM_ID, 6);
    }
    return null;
  },
  async getMinimumBalanceForRentExemption(bytes: number) {
    return rentOf(bytes);
  },
};

const fakeFetch = (async (url: string, init: RequestInit = {}) => {
  upstream.push({
    url,
    headers: Object.fromEntries(new Headers(init.headers)),
    body: init.body as string | undefined,
  });
  const sent = JSON.parse(init.body as string) as { method: string; params?: Params };
  const code = throwOn?.(sent.method);
  if (code) throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
  return koraAnswer(sent.method, sent.params ?? {}, url);
}) as unknown as typeof fetch;

function config(over: Partial<RelayerConfig> = {}): RelayerConfig {
  return {
    replicas: [{ url: KORA, feePayer: relayer.publicKey.toBase58() }],
    apiKey: "the-api-key",
    hmacSecret: "the-hmac-secret",
    feePayers: [relayer.publicKey.toBase58()],
    paymentWallet: paymentWallet.toBase58(),
    accountCreation: true,
    ...over,
  };
}

/** A relayer route of its own: fresh budgets, fresh caches. */
function make(upstreamConfig: RelayerConfig | null = config()): Relayer {
  const log = (line: LogLine) => void logged.push(line);
  return createRelayer({
    upstream: upstreamConfig,
    usdcMint: USDC_MINT,
    relay: createRelay({ fetch: fakeFetch, log }),
    solPrice: createSolPrice(chain),
    accountRent: createAccountRent(chain),
    quotas: createMemoryQuotaStore(),
    log,
    now: () => clock,
  });
}

/** Each call is its own caller unless it says otherwise. */
function newCaller(): Caller {
  visitor += 1;
  return {
    sessionId: `session-${visitor}`,
    ip: `10.7.${Math.floor(visitor / 250)}.${visitor % 250}`,
  };
}

/** The status and the body; for an error, only its code. */
async function call(method: string, params?: Params, caller: Caller = newCaller()) {
  const answer = await subject.call(JSON.stringify({ method, params }), caller);
  const json = answer.body === null ? null : JSON.parse(answer.body);
  return { status: answer.status, json: answer.status === 200 ? json : { code: json?.code } };
}

const estimateParams = (transaction: VersionedTransaction) => ({
  transaction: encode(transaction),
  fee_token: USDC_MINT,
  signer_key: relayer.publicKey.toBase58(),
});
const signParams = (transaction: VersionedTransaction) => ({
  transaction: encode(transaction),
  signer_key: relayer.publicKey.toBase58(),
});
const koraCallsOf = (method: string) =>
  upstream.filter((sent) => JSON.parse(sent.body!).method === method);
const reasons = () =>
  logged.flatMap((line) => (line.event === "refusal" ? [`${line.status} ${line.reason}`] : []));

beforeEach(() => {
  upstream = [];
  logged = [];
  clock = Date.parse("2026-10-02T12:00:00Z");
  solPrice = SOL_PRICE;
  koraPrice = null;
  priceAge = 5;
  trackerExtensions = [[ExtensionType.TransferHook, 64]];
  readableMints = true;
  pythReads = 0;
  throwOn = null;
  koraAnswer = (method, params) => {
    const signer = relayer.publicKey.toBase58();
    const result =
      method === "getPayerSigner"
        ? { signer_address: signer, payment_address: paymentWallet.toBase58() }
        : method === "estimateTransactionFee"
          ? koraEstimate(11_000)
          : {
              signed_transaction: coSigned(params.transaction as string, relayer),
              signer_pubkey: signer,
            };
    return json({ jsonrpc: "2.0", result, id: 1 });
  };
  subject = make();
});

describe("the relayer route", () => {
  it("says whether there is a relayer, from the server's own pins", () => {
    expect(JSON.parse(subject.pins().body!)).toEqual({
      available: true,
      feePayers: [relayer.publicKey.toBase58()],
      paymentWallet: paymentWallet.toBase58(),
      accountCreation: true,
    });
    expect(upstream).toHaveLength(0);
    expect(JSON.parse(make(config({ accountCreation: false })).pins().body!)).toMatchObject({
      accountCreation: false,
    });
  });

  it("is off, for the pins and for every call, when no relayer is configured", async () => {
    subject = make(null);
    expect(JSON.parse(subject.pins().body!)).toEqual({ available: false });
    const answer = await call("getPayerSigner");
    expect(answer.status).toBe(503);
    expect(answer.json).toEqual({ code: "relayer_unavailable" });
    expect(upstream).toHaveLength(0);
  });

  it("forwards only the three methods the wallet calls", async () => {
    for (const method of [
      "signAndSendTransaction",
      "transferTransaction",
      "getConfig",
      "getBlockhash",
      "signBundle",
    ]) {
      const answer = await call(method, signParams(signedByPortfolio(genuine.sendUsdc())));
      expect(answer.status).toBe(403);
    }
    expect(upstream).toHaveLength(0);
  });

  it("refuses a batch, a body that is not JSON and params that are not an object", async () => {
    const post = (body: string) => subject.call(body, newCaller());
    expect((await post(JSON.stringify([{ method: "getPayerSigner" }]))).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect((await post(JSON.stringify({ method: "getPayerSigner", params: [] }))).status).toBe(400);
    expect((await post(JSON.stringify({ method: "getPayerSigner", params: "x" }))).status).toBe(
      400,
    );
    expect(upstream).toHaveLength(0);
  });

  it("builds the upstream request and its authentication itself, taking neither from the caller", async () => {
    const transaction = signedByPortfolio(genuine.sendUsdc());
    const answer = await subject.call(
      JSON.stringify({
        method: "signTransaction",
        params: { ...signParams(transaction), sig_verify: true, extra: "smuggled" },
        id: 99,
      }),
      newCaller(),
    );
    expect(answer.status).toBe(200);

    // The relayer is asked what it would charge first, then to sign.
    expect(upstream.map((sent) => JSON.parse(sent.body!).method)).toEqual([
      "estimateTransactionFee",
      "signTransaction",
    ]);
    const [sent] = koraCallsOf("signTransaction");
    const timestamp = String(Math.floor(clock / 1000));
    expect(JSON.parse(sent.body!)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "signTransaction",
      params: {
        transaction: encode(transaction),
        signer_key: relayer.publicKey.toBase58(),
        sig_verify: false,
      },
    });
    expect(sent.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (compatible; NoirWire)",
      "x-api-key": "the-api-key",
      "x-timestamp": timestamp,
      "x-hmac-signature": createHmac("sha256", "the-hmac-secret")
        .update(timestamp + sent.body)
        .digest("hex"),
    });
  });

  it("returns the payer signer only when it is the key pinned for that replica", async () => {
    expect((await call("getPayerSigner")).json).toEqual({
      result: {
        signer_address: relayer.publicKey.toBase58(),
        payment_address: paymentWallet.toBase58(),
      },
    });
    expect(JSON.parse(upstream[0].body!)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "getPayerSigner",
    });

    for (const result of [
      {
        signer_address: Keypair.generate().publicKey.toBase58(),
        payment_address: paymentWallet.toBase58(),
      },
      {
        signer_address: relayer.publicKey.toBase58(),
        payment_address: Keypair.generate().publicKey.toBase58(),
      },
    ]) {
      koraAnswer = () => json({ jsonrpc: "2.0", result, id: 1 });
      expect((await call("getPayerSigner")).status).toBe(503);
    }
  });

  it("refuses a transaction whose fee payer is not pinned, or is not the signer asked for", async () => {
    const foreign = compile([sendUsdc(), payment(PLAIN_FEE)], Keypair.generate().publicKey);
    expect((await call("estimateTransactionFee", estimateParams(foreign))).status).toBe(422);
    const other = {
      ...estimateParams(genuine.sendUsdc()),
      signer_key: Keypair.generate().publicKey.toBase58(),
    };
    expect((await call("estimateTransactionFee", other)).status).toBe(422);
    expect(upstream).toHaveLength(0);
  });

  it("refuses what is not a transaction at all", async () => {
    const good = estimateParams(genuine.sendUsdc());
    for (const transaction of [undefined, 7, "", "not base64!", "AAAA", "A".repeat(2_049)]) {
      const answer = await call("estimateTransactionFee", { ...good, transaction });
      expect(answer.status).toBe(422);
      expect(answer.json).toEqual({ code: "refused" });
    }
    expect((await call("estimateTransactionFee", { ...good, signer_key: "0x00" })).status).toBe(
      422,
    );
    expect(reasons()).toContain("422 not_a_transaction");
    expect(upstream).toHaveLength(0);
  });

  it.each(Object.entries(hostile))(
    "refuses %s before the relayer hears of it, for a price and for a signature",
    async (_name, [build, reason]) => {
      expect((await call("estimateTransactionFee", estimateParams(build()))).status).toBe(422);
      expect(reasons()).toContain(`422 ${reason}`);
      const transaction = build();
      try {
        transaction.sign([portfolio]);
      } catch {
        // Not every hostile transaction has a slot for the portfolio.
      }
      expect((await call("signTransaction", signParams(transaction))).status).toBe(422);
      expect(upstream).toHaveLength(0);
    },
  );

  it("prices by its own rule, not the relayer's, and never below it", async () => {
    // The relayer asks 11,000 for a plain send; this route charges twice the network fee.
    const plain = await call("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    expect(plain.json.result.fee_in_token).toBe(Number(PLAIN_FEE));
    // An account that already exists costs the relayer nothing to "open", so it asks for
    // nothing more. The rent is charged all the same.
    const opening = await call("estimateTransactionFee", estimateParams(genuine.sendToNew()));
    expect(opening.json.result.fee_in_token).toBe(Number(OPENING_FEE));
    const holding = await call("estimateTransactionFee", estimateParams(genuine.openHolding()));
    expect(holding.json.result.fee_in_token).toBe(Number(TRACKER_OPENING_FEE));
  });

  it("passes on the relayer's figure when that is the higher one, up to the cap", async () => {
    const ask = (fee: number) => {
      koraAnswer = () => json({ result: koraEstimate(fee) });
      return call("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    };
    expect((await ask(30_000)).json.result.fee_in_token).toBe(30_000);
    expect((await ask(Number(MAX_RELAYER_FEE_RAW) + 1)).status).toBe(422);
  });

  it("returns only the fields the wallet reads, whatever else the relayer answered with", async () => {
    koraAnswer = () => json({ result: { ...koraEstimate(11_000), internal: "detail" }, extra: 1 });
    const priced = await call("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    expect(priced.json).toEqual({
      result: {
        fee_in_token: Number(PLAIN_FEE),
        signer_pubkey: relayer.publicKey.toBase58(),
        payment_address: paymentWallet.toBase58(),
      },
    });
  });

  it("signs nothing that pays less than its own price, whatever the relayer would accept", async () => {
    // The drain: the account exists when the relayer looks, so the relayer would sign for
    // the network fee alone, and the account is closed before the transaction lands.
    const underpaid = signedByPortfolio(
      compile([open(ataFor(USDC, recipient), recipient, USDC), sendUsdc(), payment(11_000n)]),
    );
    const answer = await call("signTransaction", signParams(underpaid));
    expect(answer.status).toBe(422);
    expect(answer.json).toEqual({ code: "insufficient_payment" });
    const plain = signedByPortfolio(compile([sendUsdc(), payment(11_000n)]));
    expect((await call("signTransaction", signParams(plain))).status).toBe(422);
    expect(upstream).toHaveLength(0);

    expect(
      (await call("signTransaction", signParams(signedByPortfolio(genuine.sendToNew())))).status,
    ).toBe(200);
  });

  it("allows for a price that moved a little since the review, and no more", async () => {
    solPrice = SOL_PRICE * 1.015;
    expect(
      (await call("signTransaction", signParams(signedByPortfolio(genuine.sendUsdc())))).status,
    ).toBe(200);
    subject = make();
    solPrice = SOL_PRICE * 1.05;
    expect(
      (await call("signTransaction", signParams(signedByPortfolio(genuine.sendUsdc())))).status,
    ).toBe(422);
  });

  it("never prices SOL below the floor, and prices nothing without a price", async () => {
    solPrice = 0.5;
    koraPrice = MIN_SOL_PRICE_USD;
    const cheap = await call("estimateTransactionFee", estimateParams(genuine.sendToNew()));
    expect(cheap.json.result.fee_in_token).toBe(
      Number(lamportsInUsdc(relayedCostLamports(BigInt(rentOf(ACCOUNT_SIZE))), MIN_SOL_PRICE_USD)),
    );

    subject = make();
    solPrice = null;
    const none = await call("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    expect(none.status).toBe(503);
    expect(none.json).toEqual({ code: "relayer_unavailable" });
    expect(koraCallsOf("estimateTransactionFee")).toHaveLength(1);
  });

  it("prices nothing by a price that is stale, unverified, uncertain or not Pyth's", async () => {
    const at = { now: clock };
    const usable = (account: ReturnType<typeof pythAccount> | null) =>
      decodePythPrice(account, Math.floor(clock / 1000));
    expect(usable(pythAccount(150, 5, at))).toBeCloseTo(150);
    expect(usable(pythAccount(150, 121, at))).toBeNull();
    expect(usable(pythAccount(150, -121, at))).toBeNull();
    expect(usable(pythAccount(150, 5, { ...at, verified: 0 }))).toBeNull();
    expect(usable(pythAccount(150, 5, { ...at, confidence: 200_000_000n }))).toBeNull();
    expect(usable({ ...pythAccount(150, 5, at), owner: Keypair.generate().publicKey })).toBeNull();
    const otherFeed = pythAccount(150, 5, at);
    otherFeed.data[41] ^= 1;
    expect(usable(otherFeed)).toBeNull();
    const truncated = pythAccount(150, 5, at);
    expect(usable({ ...truncated, data: truncated.data.subarray(0, 100) })).toBeNull();
    expect(usable(null)).toBeNull();

    priceAge = 300;
    const stale = await call("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    expect(stale.status).toBe(503);
    expect(upstream).toHaveLength(0);
  });

  it("uses one read of the price for thirty seconds and no longer", async () => {
    await call("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    clock += 29_000;
    await call("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    expect(pythReads).toBe(1);
    clock += 2_000;
    await call("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    expect(pythReads).toBe(2);
  });

  it("prices and signs nothing while its price and the relayer's disagree", async () => {
    const priced = () => call("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    koraPrice = SOL_PRICE * 1.04;
    expect((await priced()).status).toBe(200);
    for (const off of [SOL_PRICE * 1.06, SOL_PRICE * 0.9, SOL_PRICE / 5]) {
      koraPrice = off;
      expect((await priced()).status).toBe(422);
      const signed = await call(
        "signTransaction",
        signParams(signedByPortfolio(genuine.sendUsdc())),
      );
      expect(signed.status).toBe(422);
    }
    expect(koraCallsOf("signTransaction")).toHaveLength(0);
    expect(reasons()).toContain("422 price_disagreement");
  });

  it("charges the rent of the account the mint really needs, however large", async () => {
    // The tracker's mint gains a transfer fee: every account of it is now
    // larger than the 179 bytes a tracker's account has been so far.
    trackerExtensions = [
      [ExtensionType.TransferFeeConfig, 108],
      [ExtensionType.TransferHook, 64],
      [ExtensionType.PausableConfig, 33],
      [ExtensionType.ConfidentialTransferMint, 65],
    ];
    // Sized as the token program sizes it. The confidential transfer
    // extension on the mint adds nothing to an account until its owner asks.
    const bytes = getAccountLen([
      ExtensionType.ImmutableOwner,
      ExtensionType.TransferFeeAmount,
      ExtensionType.TransferHookAccount,
      ExtensionType.PausableAccount,
    ]);
    expect(
      associatedAccountLen(TOKEN_2022_PROGRAM_ID, [
        ExtensionType.PausableConfig,
        ExtensionType.TransferHook,
      ]),
    ).toBe(179);
    expect(associatedAccountLen(TOKEN_PROGRAM_ID, [ExtensionType.TransferHook])).toBe(ACCOUNT_SIZE);
    expect(bytes).toBeGreaterThan(179);
    solPrice = 100;
    const fee = lamportsInUsdc(relayedCostLamports(BigInt(rentOf(bytes))), 100);
    const priced = await call("estimateTransactionFee", estimateParams(genuine.openHolding()));
    expect(priced.json.result.fee_in_token).toBe(Number(fee));

    // What a 179-byte account would have cost is no longer enough to have it opened.
    const asSmall = lamportsInUsdc(relayedCostLamports(BigInt(rentOf(179))), 100);
    const holding = ataFor(tracker.mint, owner, tracker.programId);
    const underpaid = signedByPortfolio(
      compile([open(holding, owner, tracker.mint, tracker.programId), payment(asSmall)]),
    );
    expect((await call("signTransaction", signParams(underpaid))).status).toBe(422);
    expect(koraCallsOf("signTransaction")).toHaveLength(0);
  });

  it("opens no account whose mint cannot be read", async () => {
    readableMints = false;
    const opening = await call("estimateTransactionFee", estimateParams(genuine.sendToNew()));
    expect(opening.status).toBe(503);
    const plain = await call("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    expect(plain.status).toBe(200);
  });

  it("refuses when the price has outrun the cap", async () => {
    solPrice = 3_000;
    expect((await call("estimateTransactionFee", estimateParams(genuine.sendUsdc()))).status).toBe(
      422,
    );
    expect(upstream).toHaveLength(0);
  });

  it("asks for a signature only on a transaction the portfolio has validly signed", async () => {
    const unsigned = genuine.sendUsdc();
    expect((await call("signTransaction", signParams(unsigned))).status).toBe(422);

    const bySomeoneElse = genuine.sendUsdc();
    const impostor = Keypair.generate();
    const borrowed = compile([sendUsdc(), payment(PLAIN_FEE)]);
    borrowed.message.staticAccountKeys[1] = impostor.publicKey;
    borrowed.sign([impostor]);
    bySomeoneElse.signatures[1] = borrowed.signatures[1];
    expect((await call("signTransaction", signParams(bySomeoneElse))).status).toBe(422);
    expect(reasons()).toContain("422 portfolio_signature");
    expect(upstream).toHaveLength(0);

    // A price needs no signature: nothing is signed for it.
    expect((await call("estimateTransactionFee", estimateParams(unsigned))).status).toBe(200);
  });

  it("only prices in USDC", async () => {
    const params = { ...estimateParams(genuine.sendUsdc()), fee_token: tracker.mint.toBase58() };
    expect((await call("estimateTransactionFee", params)).status).toBe(422);
  });

  it("tells the wallet a payment was too small, and nothing else of what the relayer said", async () => {
    const refuseWith = (message: string) => {
      koraAnswer = () => json({ jsonrpc: "2.0", error: { code: -32000, message }, id: 1 });
      return call("signTransaction", signParams(signedByPortfolio(genuine.sendUsdc())));
    };
    const small = await refuseWith(
      "Invalid transaction: Insufficient token payment. Required 21000 lamports",
    );
    expect(small.status).toBe(422);
    expect(small.json).toEqual({ code: "insufficient_payment" });

    const address = Keypair.generate().publicKey.toBase58();
    const other = await refuseWith(
      `Invalid transaction: Program ${address} is not in the allowed list`,
    );
    expect(other.json).toEqual({ code: "refused" });
    expect(reasons()).toContain("422 program_not_allowed");
    const everything = JSON.stringify(logged);
    expect(everything).not.toContain(address);
    expect(everything).not.toContain(owner.toBase58());
    expect(everything).not.toContain(recipient.toBase58());
  });

  it("tells a relayer that never had the transaction from one that may have it", async () => {
    const sign = () => call("signTransaction", signParams(signedByPortfolio(genuine.sendUsdc())));
    const honest = koraAnswer;
    // Turned away for its credentials, or not there for the question asked
    // before signing: it was never handed the transaction to sign.
    koraAnswer = () => new Response(null, { status: 401 });
    expect((await call("getPayerSigner")).status).toBe(503);
    expect((await sign()).status).toBe(503);
    koraAnswer = () => new Response("oops", { status: 500 });
    expect((await call("getPayerSigner")).status).toBe(503);
    expect((await sign()).status).toBe(503);
    expect(koraCallsOf("signTransaction")).toHaveLength(0);

    // Refused for its method on the transaction itself: it did nothing with it.
    koraAnswer = (method, params, url) =>
      method === "signTransaction"
        ? new Response(null, { status: 405 })
        : honest(method, params, url);
    expect((await sign()).status).toBe(503);

    // It answered the question and then failed on the transaction itself:
    // what it did with it is not known, and the wallet is told exactly that.
    for (const broken of [
      () => new Response("oops", { status: 500 }),
      () => new Response("<html>", { status: 200 }),
    ]) {
      koraAnswer = (method, params, url) =>
        method === "signTransaction" ? broken() : honest(method, params, url);
      const answer = await sign();
      expect(answer.status).toBe(502);
      expect(answer.json).toEqual({ code: "no_answer" });
    }
  });

  it("answers 503, never 401, when the replica refuses this server's own credentials", async () => {
    const honest = koraAnswer;
    for (const status of [401, 403]) {
      for (const method of ["estimateTransactionFee", "signTransaction"]) {
        logged = [];
        subject = make();
        // The question asked before signing still passes; the call itself is turned away.
        koraAnswer = (called, params, url) => {
          const refuse = method === "estimateTransactionFee" ? true : called === "signTransaction";
          return refuse ? new Response(null, { status }) : honest(called, params, url);
        };
        const answer =
          method === "signTransaction"
            ? await call(method, signParams(signedByPortfolio(genuine.sendUsdc())))
            : await call(method, estimateParams(genuine.sendUsdc()));
        // Nothing was signed, so the wallet may build again for another replica.
        expect(answer).toEqual({ status: 503, json: { code: "relayer_unavailable" } });
        expect(logged).toContainEqual({
          event: "operator_error",
          route: "relayer",
          status,
          reason: "upstream_refused_credentials",
        });
      }
    }
  });

  it("hands a signed transaction back with its id, and never broadcasts it", async () => {
    const transaction = signedByPortfolio(genuine.sendUsdc());
    const answer = await call("signTransaction", signParams(transaction));
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.json).sort()).toEqual(["signature", "transaction"]);

    const signed = VersionedTransaction.deserialize(Buffer.from(answer.json.transaction, "base64"));
    expect(Buffer.from(signed.message.serialize())).toEqual(
      Buffer.from(transaction.message.serialize()),
    );
    expect(Buffer.from(signed.signatures[1])).toEqual(Buffer.from(transaction.signatures[1]));
    // The id is the fee payer's signature, in base58, as the chain names the transaction.
    expect(answer.json.signature).toBe(bs58(signed.signatures[0]));
    expect(answer.json.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
    // Sign only: nothing but the question and the signature was asked of the relayer.
    expect(upstream.map((sent) => JSON.parse(sent.body!).method)).toEqual([
      "estimateTransactionFee",
      "signTransaction",
    ]);
  });

  it("returns nothing the relayer changed: another message, a lost signature, or no valid fee payer signature", async () => {
    const honest = koraAnswer;
    const pinned = relayer.publicKey.toBase58();
    const returning = (signedTransaction: (sent: string) => string) => {
      koraAnswer = (method, params, url) =>
        method === "signTransaction"
          ? json({
              result: {
                signed_transaction: signedTransaction(params.transaction as string),
                signer_pubkey: pinned,
              },
            })
          : honest(method, params, url);
      return call("signTransaction", signParams(signedByPortfolio(genuine.sendUsdc())));
    };
    const cases: Record<string, (sent: string) => string> = {
      "not signed by the fee payer at all": (sent) => sent,
      "signed by another key": (sent) => {
        const transaction = VersionedTransaction.deserialize(Buffer.from(sent, "base64"));
        transaction.signatures[0] = Keypair.generate().secretKey.subarray(0, 64);
        return encode(transaction);
      },
      "another transaction, validly signed": () =>
        coSigned(
          encode(signedByPortfolio(compile([sendUsdc(9_000_000n), payment(PLAIN_FEE)]))),
          relayer,
        ),
      "the portfolio's signature replaced": (sent) => {
        const transaction = VersionedTransaction.deserialize(
          Buffer.from(coSigned(sent, relayer), "base64"),
        );
        transaction.signatures[1] = new Uint8Array(64);
        return encode(transaction);
      },
    };
    for (const [name, change] of Object.entries(cases)) {
      const answer = await returning(change);
      expect(answer, name).toEqual({ status: 502, json: { code: "no_answer" } });
    }
  });

  it("says a replica that could not even be connected to never had the transaction", async () => {
    const sign = () => call("signTransaction", signParams(signedByPortfolio(genuine.sendUsdc())));
    throwOn = (method) => (method === "signTransaction" ? "ECONNREFUSED" : null);
    expect((await sign()).status).toBe(503);
    // A connection that broke after it was made says nothing of the kind.
    throwOn = (method) => (method === "signTransaction" ? "ECONNRESET" : null);
    expect((await sign()).status).toBe(502);
  });

  it("refuses a signed transaction that comes back under another key, or is not a transaction", async () => {
    const honest = koraAnswer;
    const signedAs = (result: Params) => {
      koraAnswer = (method, params, url) =>
        method === "signTransaction" ? json({ result }) : honest(method, params, url);
      return call("signTransaction", signParams(signedByPortfolio(genuine.sendUsdc())));
    };
    const transaction = encode(genuine.sendUsdc());
    const other = Keypair.generate().publicKey.toBase58();
    expect((await signedAs({ signed_transaction: transaction, signer_pubkey: other })).status).toBe(
      502,
    );
    const pinned = relayer.publicKey.toBase58();
    expect((await signedAs({ signed_transaction: "rubbish", signer_pubkey: pinned })).status).toBe(
      502,
    );
    expect(reasons()).toContain("502 answer_not_pinned_keys");
  });

  it("rations signatures per session, apart from reads", async () => {
    const from = newCaller();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const transaction = signedByPortfolio(genuine.sendUsdc());
      statuses.push((await call("signTransaction", signParams(transaction), from)).status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // Reads by the same caller still pass.
    expect((await call("getPayerSigner", undefined, from)).status).toBe(200);
  });

  it("rations signatures per address, however many sessions it holds", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 32; i += 1) {
      const transaction = signedByPortfolio(genuine.sendUsdc());
      const caller = { sessionId: `fresh-session-${i}`, ip: "203.0.113.50" };
      statuses.push((await call("signTransaction", signParams(transaction), caller)).status);
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
  });

  it("rations signatures in total, whoever asks, and does not count what it refused", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await call("signTransaction", signParams(genuine.sendUsdc()))).status).toBe(422);
    }
    let signed = 0;
    let refusedAt = -1;
    for (let i = 0; i < 70 && refusedAt < 0; i += 1) {
      const answer = await call(
        "signTransaction",
        signParams(signedByPortfolio(genuine.sendUsdc())),
      );
      if (answer.status === 200) signed += 1;
      else refusedAt = answer.status;
    }
    expect(signed).toBe(60);
    expect(refusedAt).toBe(429);
    expect(reasons()).toContain("429 signature_budget_spent");
    // The next minute has a budget of its own.
    clock += 61_000;
    expect(
      (await call("signTransaction", signParams(signedByPortfolio(genuine.sendUsdc())))).status,
    ).toBe(200);
  });

  it("rations signatures by the hour as well as by the minute", async () => {
    let signed = 0;
    for (let minute = 0; minute < 11; minute += 1) {
      for (let i = 0; i < 60; i += 1) {
        const answer = await call(
          "signTransaction",
          signParams(signedByPortfolio(genuine.sendUsdc())),
        );
        if (answer.status === 200) signed += 1;
      }
      clock += 61_000;
    }
    expect(signed).toBe(600);
  });

  describe("with several replicas", () => {
    const second = Keypair.generate();
    const KORA_2 = "https://kora-2.example";
    const keyOf: Record<string, Keypair> = { [KORA]: relayer, [KORA_2]: second };
    let down: string[];

    beforeEach(() => {
      down = [];
      subject = make(
        config({
          replicas: [
            { url: KORA, feePayer: relayer.publicKey.toBase58() },
            { url: KORA_2, feePayer: second.publicKey.toBase58() },
          ],
          feePayers: [relayer.publicKey.toBase58(), second.publicKey.toBase58()],
        }),
      );
      koraAnswer = (method, params, url) => {
        if (down.includes(url)) return new Response("down", { status: 503 });
        const signer = keyOf[url].publicKey.toBase58();
        const result =
          method === "getPayerSigner"
            ? { signer_address: signer, payment_address: paymentWallet.toBase58() }
            : method === "estimateTransactionFee"
              ? koraEstimate(11_000, signer)
              : {
                  signed_transaction: coSigned(params.transaction as string, keyOf[url]),
                  signer_pubkey: signer,
                };
        return json({ result });
      };
    });

    const payer = async (params?: Params) => {
      const answer = await call("getPayerSigner", params);
      return answer.status === 200 ? answer.json.result.signer_address : answer.status;
    };

    it("pins one fee payer to each, and says so to the wallet", () => {
      expect(JSON.parse(subject.pins().body!)).toMatchObject({
        feePayers: [relayer.publicKey.toBase58(), second.publicKey.toBase58()],
      });
    });

    it("starts with either replica, not always the same one", async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 40; i += 1) seen.add(await payer());
      expect(seen).toEqual(new Set([relayer.publicKey.toBase58(), second.publicKey.toBase58()]));
    });

    it("moves on to the next replica when one is down, before anything is signed", async () => {
      down = [KORA];
      for (let i = 0; i < 10; i += 1) expect(await payer()).toBe(second.publicKey.toBase58());
      down = [KORA, KORA_2];
      expect(await payer()).toBe(503);
    });

    it("passes over a replica that answers as another replica's key", async () => {
      const honest = koraAnswer;
      koraAnswer = (method, params, url) =>
        url === KORA && method === "getPayerSigner"
          ? json({
              result: {
                signer_address: second.publicKey.toBase58(),
                payment_address: paymentWallet.toBase58(),
              },
            })
          : honest(method, params, url);
      for (let i = 0; i < 10; i += 1) expect(await payer()).toBe(second.publicKey.toBase58());
    });

    it("does not ask a replica the wallet has just seen fail", async () => {
      const not = [relayer.publicKey.toBase58()];
      for (let i = 0; i < 10; i += 1)
        expect(await payer({ not })).toBe(second.publicKey.toBase58());
      expect(upstream.every((sent) => sent.url === KORA_2)).toBe(true);
      expect(await payer({ not: [...not, second.publicKey.toBase58()] })).toBe(503);
    });

    it("sends a transaction only to the replica whose key it names", async () => {
      const forSecond = compile([sendUsdc(), payment(PLAIN_FEE)], second.publicKey);
      const params = { ...estimateParams(forSecond), signer_key: second.publicKey.toBase58() };
      expect((await call("estimateTransactionFee", params)).status).toBe(200);
      expect(upstream.map((sent) => sent.url)).toEqual([KORA_2]);

      // Its replica down: no answer, and no other replica is handed a transaction it cannot sign.
      down = [KORA_2];
      upstream = [];
      forSecond.sign([portfolio]);
      const sign = { transaction: encode(forSecond), signer_key: second.publicKey.toBase58() };
      expect((await call("signTransaction", sign)).status).toBe(503);
      expect(upstream.map((sent) => sent.url)).toEqual([KORA_2]);
    });
  });
});

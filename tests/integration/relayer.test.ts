import { createHmac } from "node:crypto";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { base58 } from "../../src/chain/core/bytes.js";
import {
  ataFor,
  coSigned,
  OPENING_FEE,
  PLAIN_FEE,
  scenario,
  USDC,
} from "../support/transactions.js";
import { startApi, type Api } from "./support/harness.js";
import type { Received, Reply } from "./support/providers.js";

/**
 * The relayer route over real HTTP, with two stand-in Kora replicas and a
 * stand-in RPC that serves Pyth's price account, the mints and the rent.
 */

const first = scenario();
const second = Keypair.generate();
const { paymentWallet, portfolio, recipient, genuine, hostile, encode, signedByPortfolio } = first;
const { compile, sendUsdc, payment, open } = first;
const FEE_PAYER_1 = first.relayer.publicKey.toBase58();
const FEE_PAYER_2 = second.publicKey.toBase58();
const PAYMENT_WALLET = paymentWallet.toBase58();
const USDC_MINT = USDC.toBase58();
/** The stand-in feed says 1,000 dollars a SOL: one lamport is one raw USDC unit. */
const SOL_PRICE = 1_000;

let api: Api;

/** A Kora replica that signs as `feePayer` and prices at `price` dollars a SOL. */
const kora =
  (key: Keypair, price = SOL_PRICE, as = key.publicKey.toBase58()) =>
  (request: Received): Reply => {
    const feePayer = as;
    const { method, params } = JSON.parse(request.body) as {
      method: string;
      params?: { transaction: string };
    };
    const result =
      method === "getPayerSigner"
        ? { signer_address: feePayer, payment_address: PAYMENT_WALLET }
        : method === "estimateTransactionFee"
          ? {
              fee_in_lamports: 11_000,
              fee_in_token: Math.ceil((11_000 * price) / 1_000),
              signer_pubkey: feePayer,
              payment_address: PAYMENT_WALLET,
            }
          : { signed_transaction: coSigned(params!.transaction, key), signer_pubkey: feePayer };
    return { body: { jsonrpc: "2.0", id: 1, result } };
  };

const methodOf = (request: Received) => (JSON.parse(request.body) as { method: string }).method;
const koraCalls = () => [...api.providers.sentTo("kora-1"), ...api.providers.sentTo("kora-2")];

const estimateParams = (transaction: VersionedTransaction, signer = FEE_PAYER_1) => ({
  transaction: encode(transaction),
  fee_token: USDC_MINT,
  signer_key: signer,
});
const signParams = (transaction: VersionedTransaction, signer = FEE_PAYER_1) => ({
  transaction: encode(transaction),
  signer_key: signer,
});
const relayer = (method: string, params?: object, options: { token?: string; ip?: string } = {}) =>
  api.call("/v1/relayer", { body: { method, params }, ...options });
const refusals = () =>
  api.logged.flatMap((line) => (line.event === "refusal" ? [`${line.status} ${line.reason}`] : []));

beforeAll(async () => {
  api = await startApiWithRelayer();
});
afterAll(() => api.close());

async function startApiWithRelayer(): Promise<Api> {
  return startApi({
    KORA_URLS: "{kora-1},{kora-2}",
    KORA_API_KEY: "the-api-key",
    KORA_HMAC_SECRET: "the-hmac-secret",
    KORA_FEE_PAYERS: `${FEE_PAYER_1},${FEE_PAYER_2}`,
    KORA_PAYMENT_WALLET: PAYMENT_WALLET,
  });
}

beforeEach(() => {
  api.providers.reset();
  api.providers.answer("kora-1", kora(first.relayer));
  api.providers.answer("kora-2", kora(second));
  api.logged.length = 0;
});

describe("GET /v1/relayer", () => {
  it("returns the server's own pins, and asks the relayer nothing", async () => {
    const response = await api.call("/v1/relayer");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      available: true,
      feePayers: [FEE_PAYER_1, FEE_PAYER_2],
      paymentWallet: PAYMENT_WALLET,
      accountCreation: true,
    });
    expect(koraCalls()).toHaveLength(0);
  });
});

describe("POST /v1/relayer", () => {
  // The happy path for `getPayerSigner` (which replica, which pinned key) is
  // proved once, fast, in tests/unit/relayer.test.ts against the relayer
  // core directly. What is HTTP-specific about it, replica failover and the
  // pin mismatch that must never be trusted, is covered below.

  it("prices a genuine transaction by its own rule, at the SOL price it read itself", async () => {
    const plain = await relayer("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    expect(plain.status).toBe(200);
    expect(plain.json).toEqual({
      result: {
        fee_in_token: Number(PLAIN_FEE),
        signer_pubkey: FEE_PAYER_1,
        payment_address: PAYMENT_WALLET,
      },
    });
    // The rent of the account the mint really needs, read from the chain, is charged on top.
    const opening = await relayer("estimateTransactionFee", estimateParams(genuine.sendToNew()));
    expect(opening.json.result.fee_in_token).toBe(Number(OPENING_FEE));
    const asked = api.providers.sentTo("rpc").map((sent) => JSON.parse(sent.body).method);
    expect(asked).toContain("getAccountInfo");
    expect(asked).toContain("getMinimumBalanceForRentExemption");
  });

  it("has a transaction the portfolio signed co-signed, building the upstream request itself", async () => {
    const transaction = signedByPortfolio(genuine.sendUsdc());
    const token = await api.token();
    const response = await api.call("/v1/relayer", {
      token,
      body: {
        method: "signTransaction",
        params: { ...signParams(transaction), sig_verify: true, extra: "smuggled" },
        id: 99,
      },
      headers: { "x-api-key": "the-callers", "x-hmac-signature": "forged", "x-timestamp": "1" },
    });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      transaction: coSigned(encode(transaction), first.relayer),
      signature: base58(
        VersionedTransaction.deserialize(
          Buffer.from(coSigned(encode(transaction), first.relayer), "base64"),
        ).signatures[0],
      ),
    });

    const calls = api.providers.sentTo("kora-1");
    expect(calls.map(methodOf)).toEqual(["estimateTransactionFee", "signTransaction"]);
    const sent = calls[1];
    expect(JSON.parse(sent.body)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "signTransaction",
      params: { transaction: encode(transaction), signer_key: FEE_PAYER_1, sig_verify: false },
    });
    expect(sent.headers["x-api-key"]).toBe("the-api-key");
    expect(sent.headers["x-hmac-signature"]).toBe(
      createHmac("sha256", "the-hmac-secret")
        .update(sent.headers["x-timestamp"] + sent.body)
        .digest("hex"),
    );
    expect(Math.abs(Number(sent.headers["x-timestamp"]) - Date.now() / 1000)).toBeLessThan(10);
    expect(sent.headers.authorization).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain(token);
    expect(api.providers.sentTo("kora-2")).toHaveLength(0);
  });

  it("only has the transaction signed: the server never broadcasts it", async () => {
    const response = await relayer(
      "signTransaction",
      signParams(signedByPortfolio(genuine.sendUsdc())),
    );
    expect(response.status).toBe(200);
    // The relayer was asked to sign, never to send.
    expect(koraCalls().map(methodOf)).toEqual(["estimateTransactionFee", "signTransaction"]);
    // And this server asked its RPC provider for a price and nothing else.
    const asked = api.providers.sentTo("rpc").map((sent) => JSON.parse(sent.body).method);
    expect(asked).not.toContain("sendTransaction");
    expect(asked.every((method) => method === "getAccountInfo")).toBe(true);

    // The wallet sends it itself, through the RPC route, which takes one this size.
    const sent = await api.call("/v1/rpc", {
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [response.json.transaction, { encoding: "base64" }],
      },
    });
    expect(sent.status).toBe(200);
  });

  it("returns nothing the relayer changed: an answer without a valid fee payer signature is a 502", async () => {
    api.providers.answer("kora-1", (request) => {
      if (methodOf(request) !== "signTransaction") return kora(first.relayer)(request);
      const { params } = JSON.parse(request.body) as { params: { transaction: string } };
      return {
        body: { result: { signed_transaction: params.transaction, signer_pubkey: FEE_PAYER_1 } },
      };
    });
    const response = await relayer(
      "signTransaction",
      signParams(signedByPortfolio(genuine.sendUsdc())),
    );
    expect([response.status, response.json.code]).toEqual([502, "no_answer"]);
    // A replica answered: no other replica is tried.
    expect(api.providers.sentTo("kora-2")).toHaveLength(0);
  });

  it("refuses a method outside the three, a batch, and a body over the cap", async () => {
    for (const method of ["signAndSendTransaction", "transferTransaction", "getConfig"]) {
      const response = await relayer(method, signParams(signedByPortfolio(genuine.sendUsdc())));
      expect(response.status).toBe(403);
      expect(response.json.code).toBe("method_not_allowed");
    }
    const batch = await api.call("/v1/relayer", { body: [{ method: "getPayerSigner" }] });
    expect([batch.status, batch.json.code]).toEqual([400, "invalid_request"]);
    const large = await api.call("/v1/relayer", {
      body: { method: "getPayerSigner", pad: "x".repeat(9_000) },
    });
    expect([large.status, large.json.code]).toEqual([413, "request_too_large"]);
    expect(koraCalls()).toHaveLength(0);
  });

  it.each(Object.entries(hostile))(
    "refuses %s (a transaction off the template) before the relayer hears of it",
    async (_name, [build, reason]) => {
      const priced = await relayer("estimateTransactionFee", estimateParams(build()));
      expect(priced.status).toBe(422);
      expect(priced.json).toEqual({
        code: "refused",
        error: "The transaction was refused. Nothing was signed.",
      });
      expect(refusals()).toContain(`422 ${reason}`);
      const transaction = build();
      try {
        transaction.sign([portfolio]);
      } catch {
        // Not every hostile transaction has a slot for the portfolio.
      }
      expect((await relayer("signTransaction", signParams(transaction))).status).toBe(422);
      expect(koraCalls()).toHaveLength(0);
    },
  );

  it("refuses to sign a transaction the portfolio has not validly signed", async () => {
    const unsigned = await relayer("signTransaction", signParams(genuine.sendUsdc()));
    expect([unsigned.status, unsigned.json.code]).toEqual([422, "refused"]);

    const bySomeoneElse = genuine.sendUsdc();
    const impostor = Keypair.generate();
    const borrowed = compile([sendUsdc(), payment(PLAIN_FEE)]);
    borrowed.message.staticAccountKeys[1] = impostor.publicKey;
    borrowed.sign([impostor]);
    bySomeoneElse.signatures[1] = borrowed.signatures[1];
    expect((await relayer("signTransaction", signParams(bySomeoneElse))).status).toBe(422);
    expect(refusals().filter((line) => line === "422 portfolio_signature")).toHaveLength(2);
    expect(koraCalls()).toHaveLength(0);
  });

  it("refuses to sign a transaction that pays less than its own price", async () => {
    // The account exists when the relayer looks, so the relayer would sign
    // for the network fee alone. This route charges the rent all the same.
    const underpaid = signedByPortfolio(
      compile([open(ataFor(USDC, recipient), recipient, USDC), sendUsdc(), payment(11_000n)]),
    );
    const response = await relayer("signTransaction", signParams(underpaid));
    expect(response.status).toBe(422);
    expect(response.json).toEqual({
      code: "insufficient_payment",
      error: "The payment is below the current price. Nothing was signed.",
    });
    expect(koraCalls()).toHaveLength(0);
  });

  it("prices and signs nothing while its SOL price and the relayer's disagree, or without a price", async () => {
    api.providers.answer("kora-1", kora(first.relayer, SOL_PRICE * 1.2));
    const priced = await relayer("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    expect([priced.status, priced.json.code]).toEqual([422, "refused"]);
    const signed = await relayer(
      "signTransaction",
      signParams(signedByPortfolio(genuine.sendUsdc())),
    );
    expect(signed.status).toBe(422);
    expect(api.providers.sentTo("kora-1").map(methodOf)).not.toContain("signTransaction");
    expect(refusals()).toContain("422 price_disagreement");
  });

  it("passes on nothing of what the relayer said, and logs no address", async () => {
    const stranger = Keypair.generate().publicKey.toBase58();
    api.providers.answer("kora-1", () => ({
      body: {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: `Program ${stranger} is not in the allowed list` },
      },
    }));
    const response = await relayer("estimateTransactionFee", estimateParams(genuine.sendUsdc()));
    expect(response.status).toBe(422);
    expect(response.text).not.toContain(stranger);
    expect(refusals()).toContain("422 program_not_allowed");
    const everything = JSON.stringify(api.logged);
    for (const secret of [
      stranger,
      portfolio.publicKey.toBase58(),
      recipient.toBase58(),
      FEE_PAYER_1,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("answers 503, never 401, when the replica refuses this server's credentials", async () => {
    for (const status of [401, 403]) {
      api.logged.length = 0;
      api.providers.answer("kora-1", (request) =>
        methodOf(request) === "signTransaction"
          ? { status, body: "" }
          : kora(first.relayer)(request),
      );
      const response = await relayer(
        "signTransaction",
        signParams(signedByPortfolio(genuine.sendUsdc())),
      );
      expect(response.status).toBe(503);
      expect(response.json).toEqual({
        code: "relayer_unavailable",
        error: "The relayer could not be used. Nothing was signed.",
      });
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(api.logged).toContainEqual({
        event: "operator_error",
        route: "relayer",
        status,
        reason: "upstream_refused_credentials",
      });
    }
  });

  describe("replica failover", () => {
    const payer = async (params?: object) => {
      const response = await relayer("getPayerSigner", params);
      return response.status === 200 ? response.json.result.signer_address : response.status;
    };
    const down = (): Reply => ({ status: 503, body: "down" });

    it("moves on to the next replica when one is down, before anything is signed", async () => {
      api.providers.answer("kora-1", down);
      for (let i = 0; i < 8; i += 1) expect(await payer()).toBe(FEE_PAYER_2);
      api.providers.answer("kora-2", down);
      expect(await payer()).toBe(503);
    });

    it("moves on from a replica that refuses this server's credentials, and from one that errors", async () => {
      for (const status of [401, 403, 500]) {
        api.providers.answer("kora-1", () => ({ status, body: "" }));
        for (let i = 0; i < 6; i += 1) expect(await payer()).toBe(FEE_PAYER_2);
      }
      // Every replica failed: 503, never 401.
      api.providers.answer("kora-2", () => ({ status: 401, body: "" }));
      const response = await relayer("getPayerSigner");
      expect([response.status, response.json.code]).toEqual([503, "relayer_unavailable"]);
    });

    it("says a replica that could not be connected to never had the transaction", async () => {
      const unreachable = await startApi({
        KORA_URLS: "http://127.0.0.1:9",
        KORA_API_KEY: "the-api-key",
        KORA_HMAC_SECRET: "the-hmac-secret",
        KORA_FEE_PAYERS: FEE_PAYER_1,
        KORA_PAYMENT_WALLET: PAYMENT_WALLET,
      });
      try {
        const response = await unreachable.call("/v1/relayer", {
          body: {
            method: "signTransaction",
            params: signParams(signedByPortfolio(genuine.sendUsdc())),
          },
        });
        expect([response.status, response.json.code]).toEqual([503, "relayer_unavailable"]);
      } finally {
        await unreachable.close();
      }
    });

    it("passes over a replica that answers as a key this server does not pin for it", async () => {
      api.providers.answer("kora-1", kora(first.relayer, SOL_PRICE, FEE_PAYER_2));
      for (let i = 0; i < 8; i += 1) expect(await payer()).toBe(FEE_PAYER_2);
    });

    it("does not ask a replica the wallet has just seen fail", async () => {
      for (let i = 0; i < 8; i += 1) expect(await payer({ not: [FEE_PAYER_1] })).toBe(FEE_PAYER_2);
      expect(api.providers.sentTo("kora-1")).toHaveLength(0);
      expect(await payer({ not: [FEE_PAYER_1, FEE_PAYER_2] })).toBe(503);
    });

    it("sends a transaction only to the replica whose key it names, and never to another", async () => {
      const forSecond = compile([sendUsdc(), payment(PLAIN_FEE)], second.publicKey);
      const priced = await relayer(
        "estimateTransactionFee",
        estimateParams(forSecond, FEE_PAYER_2),
      );
      expect(priced.status).toBe(200);
      expect(api.providers.sentTo("kora-1")).toHaveLength(0);

      // Its replica down: the wallet is told nothing was signed, and no
      // other replica is handed a transaction it cannot sign.
      api.providers.reset();
      api.providers.answer("kora-1", kora(first.relayer));
      api.providers.answer("kora-2", down);
      forSecond.sign([portfolio]);
      const signed = await relayer("signTransaction", signParams(forSecond, FEE_PAYER_2));
      expect([signed.status, signed.json.code]).toEqual([503, "relayer_unavailable"]);
      expect(api.providers.sentTo("kora-1")).toHaveLength(0);
    });

    it("says what the relayer did is not known when it fails on the transaction itself", async () => {
      api.providers.answer("kora-1", (request) =>
        methodOf(request) === "signTransaction"
          ? { status: 500, body: "oops" }
          : kora(first.relayer)(request),
      );
      const response = await relayer(
        "signTransaction",
        signParams(signedByPortfolio(genuine.sendUsdc())),
      );
      expect([response.status, response.json.code]).toEqual([502, "no_answer"]);
    });
  });

  describe("the signature budgets", () => {
    it("rations signatures per session: the eleventh in a minute is refused, reads still pass", async () => {
      const fresh = await startApiWithRelayer();
      try {
        fresh.providers.answer("kora-1", kora(first.relayer));
        const token = await fresh.token();
        const statuses: number[] = [];
        for (let i = 0; i < 12; i += 1) {
          const transaction = signedByPortfolio(genuine.sendUsdc());
          const response = await fresh.call("/v1/relayer", {
            token,
            body: { method: "signTransaction", params: signParams(transaction) },
          });
          statuses.push(response.status);
        }
        expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
        expect(statuses.slice(10)).toEqual([429, 429]);
        const read = await fresh.call("/v1/relayer", { token, body: { method: "getPayerSigner" } });
        expect(read.status).toBe(200);
      } finally {
        await fresh.close();
      }
    });

    it("rations signatures in total: once the minute's budget is spent, nobody gets one", async () => {
      const fresh = await startApiWithRelayer();
      try {
        fresh.providers.answer("kora-1", kora(first.relayer));
        const sign = async () => {
          const transaction = signedByPortfolio(genuine.sendUsdc());
          const response = await fresh.call("/v1/relayer", {
            body: { method: "signTransaction", params: signParams(transaction) },
          });
          return response;
        };
        // Rubbish does not spend the budget everyone shares.
        for (let i = 0; i < 5; i += 1) {
          const refused = await fresh.call("/v1/relayer", {
            body: { method: "signTransaction", params: signParams(genuine.sendUsdc()) },
          });
          expect(refused.status).toBe(422);
        }
        let signed = 0;
        for (let i = 0; i < 60; i += 1) if ((await sign()).status === 200) signed += 1;
        expect(signed).toBe(60);
        const exhausted = await sign();
        expect(exhausted.status).toBe(429);
        expect(exhausted.json).toEqual({
          code: "rate_limited",
          error: "Too many requests. Wait and try again.",
        });
        expect(
          fresh.logged.some(
            (line) => line.event === "refusal" && line.reason === "signature_budget_spent",
          ),
        ).toBe(true);
        // A price is still given: only signing is rationed.
        const priced = await fresh.call("/v1/relayer", {
          body: { method: "estimateTransactionFee", params: estimateParams(genuine.sendUsdc()) },
        });
        expect(priced.status).toBe(200);
      } finally {
        await fresh.close();
      }
    });
  });
});

describe("with no relayer configured", () => {
  it("says so, and answers every call as unavailable", async () => {
    const bare = await startApi();
    try {
      expect((await bare.call("/v1/relayer")).json).toEqual({ available: false });
      const response = await bare.call("/v1/relayer", { body: { method: "getPayerSigner" } });
      expect(response.status).toBe(503);
      expect(response.json).toEqual({
        code: "relayer_unavailable",
        error: "The relayer could not be used. Nothing was signed.",
      });
    } finally {
      await bare.close();
    }
  });
});

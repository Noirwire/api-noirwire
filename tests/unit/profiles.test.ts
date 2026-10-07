import { Keypair, Transaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it } from "vitest";
import { base58 } from "../../src/chain/core/bytes.js";
import { signerOf } from "../../src/chain/core/signatures.js";
import type { LogLine } from "../../src/common/core/log.js";
import { createMemoryQuotaStore, type Caller } from "../../src/common/core/quota.js";
import {
  CONFIRM_TIMEOUT_MS,
  createProfiles,
  CREATIONS_PER_HOUR_PER_IP,
  CREATIONS_PER_HOUR_PER_SESSION,
  DAY_MS,
  WRITES_PER_HOUR_PER_SESSION,
  type Profiles,
} from "../../src/profile/core/profiles.js";
import { FIRST_PROGRAM_ERROR, PROGRAM_ERRORS } from "../../src/profile/core/program.js";
import type { Called, Rollup } from "../../src/profile/core/rollup.js";
import { MAX_DATA_LEN, profileScenario } from "../support/profiles.js";

/**
 * The profile routes' rules, with a stand-in for the rollup and a clock the
 * tests move. No framework is involved.
 */

const { programId, gate, owner, genuine, hostile, encode, record } = profileScenario();
const TOKEN = "read-token";
/** The program's number for one of its errors. The list itself is held to the IDL in profileProgram.test.ts. */
const numberOf = (name: string) => FIRST_PROGRAM_ERROR + PROGRAM_ERRORS.indexOf(name);
const STALE_REVISION = numberOf("StaleRevision");
const PROFILE_EXISTS = numberOf("ProfileExists");
const GATE_MISSING = numberOf("GateMissing");

type RpcCall = { token: string; method: string; params: unknown[] };

let calls: RpcCall[];
let signed: number;
let clock: number;
let slept: number;
let logged: LogLine[];
/** What the stand-in rollup answers each JSON-RPC method with. */
let answers: Record<string, (call: RpcCall) => Called>;
let callers: number;

const landed = (err: unknown = null): Called => ({
  result: { context: { slot: 1 }, value: [{ err, confirmationStatus: "confirmed" }] },
});
const unseen: Called = { result: { context: { slot: 1 }, value: [null] } };
const failure = (code: number) => ({ InstructionError: [0, { Custom: code }] });

const rollup: Rollup = {
  challenge: () => Promise.resolve({ json: { challenge: "sign-this" } }),
  login: () => Promise.resolve({ json: { token: TOKEN, expiresAt: 1_790_000_000_000 } }),
  call: (token, method, params) => {
    const call = { token, method, params };
    calls.push(call);
    return Promise.resolve(answers[method](call));
  },
};

function profiles(options: { off?: boolean; dailyCreateCap?: number } = {}): Profiles {
  const signAsGate = signerOf(gate.secretKey);
  return createProfiles({
    upstream: options.off
      ? null
      : {
          rollup,
          pins: { programId, gate: gate.publicKey, maxDataLen: MAX_DATA_LEN },
          dailyCreateCap: options.dailyCreateCap ?? 500,
          signAsGate: (message) => {
            signed += 1;
            return signAsGate(message);
          },
        },
    quotas: createMemoryQuotaStore(),
    log: (line) => void logged.push(line),
    now: () => clock,
    sleep: (ms) => {
      slept += 1;
      clock += ms;
      return Promise.resolve();
    },
  });
}

/** A caller nobody has seen before: its own session and its own address. */
function stranger(): Caller {
  callers += 1;
  return { sessionId: `session-${callers}`, ip: `10.0.${callers >> 8}.${callers & 255}` };
}

const submit = (api: Profiles, bytes: Uint8Array, caller = stranger()) =>
  api.submit(JSON.stringify({ token: TOKEN, transaction: encode(bytes) }), caller);
const creation = () => genuine.create(undefined, Keypair.generate());
const outcome = async (answer: Promise<{ status: number; body: string | null }>) => {
  const { status, body } = await answer;
  return [status, (JSON.parse(body ?? "null") as { code?: string } | null)?.code];
};
const sends = () => calls.filter((call) => call.method === "sendTransaction");

beforeEach(() => {
  calls = [];
  signed = 0;
  clock = 1_000_000;
  slept = 0;
  logged = [];
  callers = 0;
  answers = {
    sendTransaction: () => ({ result: "ignored" }),
    getSignatureStatuses: () => landed(),
    getAccountInfo: () => ({ result: { context: { slot: 1 }, value: null } }),
    getLatestBlockhash: () => ({
      result: { value: { blockhash: owner.publicKey.toBase58(), lastValidBlockHeight: 9 } },
    }),
  };
});

describe("a deployment with no profiles", () => {
  it("says so, and has no other route", async () => {
    const api = profiles({ off: true });
    expect(JSON.parse(api.config().body as string)).toEqual({ enabled: false });
    const body = JSON.stringify({ token: TOKEN, owner: owner.publicKey.toBase58() });
    for (const answered of [
      api.challenge(body),
      api.session(body),
      api.read(body),
      api.blockhash(body),
      submit(api, genuine.create()),
    ]) {
      expect(await outcome(answered)).toEqual([404, "not_found"]);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("the profile pins", () => {
  it("names the gate by its public key and carries nothing else of it", () => {
    const { status, body } = profiles().config();
    expect(status).toBe(200);
    expect(JSON.parse(body as string)).toEqual({
      enabled: true,
      programId: programId.toBase58(),
      gate: gate.publicKey.toBase58(),
      maxDataLen: MAX_DATA_LEN,
    });
  });
});

describe("submitting a profile transaction", () => {
  it("sends a creation on with the gate's signature added, and answers with its id once it lands", async () => {
    const api = profiles();
    const answered = await submit(api, genuine.create());

    const [sent] = sends();
    const [encoded, options] = sent.params as [string, object];
    const transaction = Transaction.from(Buffer.from(encoded, "base64"));
    expect(transaction.verifySignatures()).toBe(true);
    expect(transaction.feePayer?.equals(gate.publicKey)).toBe(true);
    expect(options).toEqual({ encoding: "base64", skipPreflight: true });
    expect(sent.token).toBe(TOKEN);
    const id = base58(transaction.signatures[0].signature as Uint8Array);
    expect(answered).toEqual({ status: 200, body: JSON.stringify({ signature: id }) });
    expect(calls[1]).toMatchObject({ method: "getSignatureStatuses", params: [[id]] });
  });

  it("sends a closing as the owner signed it, without the gate", async () => {
    const closing = genuine.close();
    const answered = await submit(profiles(), closing);
    expect(answered.status).toBe(200);
    expect(sends()[0].params[0]).toBe(encode(closing));
    expect(signed).toBe(0);
  });

  it.each(Object.entries(hostile))(
    "signs nothing and sends nothing for %s",
    async (_name, [build, reason]) => {
      expect(await outcome(submit(profiles(), build()))).toEqual([422, "refused"]);
      expect(signed).toBe(0);
      expect(calls).toHaveLength(0);
      expect(logged).toEqual([{ event: "refusal", route: "profile", status: 422, reason }]);
    },
  );

  it("refuses a body that is not exactly a token and a transaction", async () => {
    const api = profiles();
    const transaction = encode(genuine.create());
    for (const body of [
      "not json",
      JSON.stringify({ transaction }),
      JSON.stringify({ token: TOKEN, transaction, account: owner.publicKey.toBase58() }),
      JSON.stringify({ token: "a token with spaces", transaction }),
      JSON.stringify({ token: TOKEN, transaction: "not base64!" }),
    ]) {
      expect(await outcome(api.submit(body, stranger()))).toEqual([400, "invalid_request"]);
    }
    expect(signed).toBe(0);
  });

  it("answers a refusal of the program's as a conflict under the program's name, whichever way the rollup reports it", async () => {
    answers.getSignatureStatuses = () => landed(failure(STALE_REVISION));
    expect(await outcome(submit(profiles(), genuine.write()))).toEqual([409, "StaleRevision"]);

    answers.sendTransaction = () => ({
      error: { message: "Transaction simulation failed", data: { err: failure(PROFILE_EXISTS) } },
    });
    expect(await outcome(submit(profiles(), genuine.create()))).toEqual([409, "ProfileExists"]);
  });

  it("answers any other failure as an upstream failure, never as a conflict or a success", async () => {
    answers.getSignatureStatuses = () => landed(failure(GATE_MISSING));
    expect(await outcome(submit(profiles(), genuine.write()))).toEqual([502, "upstream_failed"]);

    answers.sendTransaction = () => ({ error: { message: "Blockhash not found" } });
    expect(await outcome(submit(profiles(), genuine.write()))).toEqual([502, "upstream_failed"]);
  });

  it("waits for a transaction to land, and no longer than the bound", async () => {
    let asked = 0;
    answers.getSignatureStatuses = () => ((asked += 1) < 4 ? unseen : landed());
    expect((await submit(profiles(), genuine.write())).status).toBe(200);
    expect(slept).toBe(3);

    const before = clock;
    answers.getSignatureStatuses = () => unseen;
    expect(await outcome(submit(profiles(), genuine.write()))).toEqual([504, "upstream_timeout"]);
    expect(clock - before).toBeGreaterThanOrEqual(CONFIRM_TIMEOUT_MS);
    expect(clock - before).toBeLessThan(CONFIRM_TIMEOUT_MS + 1_000);
  });

  it("takes 'already processed' for the transaction it is: its outcome, or success when the rollup no longer reports one", async () => {
    answers.sendTransaction = () => ({
      error: { message: "This transaction has already been processed" },
    });
    expect((await submit(profiles(), genuine.write())).status).toBe(200);

    answers.getSignatureStatuses = () => landed(failure(STALE_REVISION));
    expect(await outcome(submit(profiles(), genuine.write()))).toEqual([409, "StaleRevision"]);

    answers.sendTransaction = () => ({ error: { data: { err: "AlreadyProcessed" } } });
    answers.getSignatureStatuses = () => unseen;
    expect((await submit(profiles(), genuine.write())).status).toBe(200);
  });
});

describe("the creation budgets", () => {
  it("lets one session create only so many profiles an hour, and signs nothing past that", async () => {
    const api = profiles();
    const caller = stranger();
    for (let i = 0; i < CREATIONS_PER_HOUR_PER_SESSION; i += 1) {
      expect((await submit(api, creation(), caller)).status).toBe(200);
    }
    expect(await outcome(submit(api, creation(), caller))).toEqual([429, "rate_limited"]);
    expect(signed).toBe(CREATIONS_PER_HOUR_PER_SESSION);
    // Another session at the same address still has its own.
    expect((await submit(api, creation(), { ...caller, sessionId: "another" })).status).toBe(200);
  });

  it("lets one address create only so many an hour, however many sessions it holds", async () => {
    const api = profiles();
    const ip = "203.0.113.5";
    for (let i = 0; i < CREATIONS_PER_HOUR_PER_IP; i += 1) {
      expect((await submit(api, creation(), { sessionId: `s-${i}`, ip })).status).toBe(200);
    }
    expect(await outcome(submit(api, creation(), { sessionId: "one-more", ip }))).toEqual([
      429,
      "rate_limited",
    ]);
    expect(signed).toBe(CREATIONS_PER_HOUR_PER_IP);
  });

  it("stops signing creations at the daily cap, whoever asks, and goes on writing and closing", async () => {
    const api = profiles({ dailyCreateCap: 2 });
    expect((await submit(api, creation())).status).toBe(200);
    expect((await submit(api, creation())).status).toBe(200);

    expect(await outcome(submit(api, creation()))).toEqual([429, "rate_limited"]);
    expect(signed).toBe(2);
    expect(sends()).toHaveLength(2);
    expect(logged).toContainEqual({
      event: "refusal",
      route: "profile",
      status: 429,
      reason: "daily_create_cap_reached",
    });

    expect((await submit(api, genuine.write())).status).toBe(200);
    expect((await submit(api, genuine.close())).status).toBe(200);
  });

  it("signs creations again once the cap's 24 hours are over, and not a moment before", async () => {
    const api = profiles({ dailyCreateCap: 1 });
    expect((await submit(api, creation())).status).toBe(200);
    clock += DAY_MS - 1;
    expect((await submit(api, creation())).status).toBe(429);
    clock += 1;
    expect((await submit(api, creation())).status).toBe(200);
  });

  it("turns a transaction one byte over the largest away unread: nothing signed, sent or counted", async () => {
    const api = profiles({ dailyCreateCap: 1 });
    const over = genuine.create(record(MAX_DATA_LEN + 1));
    expect(await outcome(submit(api, over))).toEqual([422, "refused"]);
    expect(logged).toEqual([
      { event: "refusal", route: "profile", status: 422, reason: "too_large" },
    ]);
    expect(signed).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await submit(api, creation())).status).toBe(200);
  });

  it("does not count a refused transaction against the cap", async () => {
    const api = profiles({ dailyCreateCap: 1 });
    for (const [build] of Object.values(hostile)) await submit(api, build());
    expect((await submit(api, creation())).status).toBe(200);
  });

  it("lets one session write only so often", async () => {
    const api = profiles();
    const caller = stranger();
    for (let i = 0; i < WRITES_PER_HOUR_PER_SESSION; i += 1) {
      expect((await submit(api, genuine.write(record(1 + (i % 8))), caller)).status).toBe(200);
    }
    expect(await outcome(submit(api, genuine.write(), caller))).toEqual([429, "rate_limited"]);
    expect(signed).toBe(WRITES_PER_HOUR_PER_SESSION);
    // A closing is never held back: the owner needs nobody's leave to delete their record.
    expect((await submit(api, genuine.close(), caller)).status).toBe(200);
  });
});

describe("reading", () => {
  it("asks for the account derived from the owner, and hands back its data or null", async () => {
    const api = profiles();
    const body = JSON.stringify({ owner: owner.publicKey.toBase58(), token: TOKEN });
    expect(JSON.parse((await api.read(body)).body as string)).toEqual({ data: null });

    answers.getAccountInfo = () => ({
      result: { context: { slot: 1 }, value: { data: ["AQIDBA==", "base64"], owner: "x" } },
    });
    expect(JSON.parse((await api.read(body)).body as string)).toEqual({ data: "AQIDBA==" });
  });

  it("refuses a request that names an account, or an owner that is not a key", async () => {
    const api = profiles();
    const named = { owner: owner.publicKey.toBase58(), token: TOKEN, account: "anything" };
    expect(await outcome(api.read(JSON.stringify(named)))).toEqual([400, "invalid_request"]);
    const notAKey = { owner: "not-a-key", token: TOKEN };
    expect(await outcome(api.read(JSON.stringify(notAKey)))).toEqual([400, "invalid_request"]);
    expect(calls).toHaveLength(0);
  });

  it("answers an upstream failure when the rollup's answer is not an account", async () => {
    answers.getAccountInfo = () => ({ result: { value: { data: "<html>" } } });
    const body = JSON.stringify({ owner: owner.publicKey.toBase58(), token: TOKEN });
    expect(await outcome(profiles().read(body))).toEqual([502, "upstream_failed"]);
  });
});

import { Keypair, Transaction } from "@solana/web3.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { base58 } from "../../src/chain/core/bytes.js";
import { CREATIONS_PER_HOUR_PER_SESSION } from "../../src/profile/core/profiles.js";
import { FIRST_PROGRAM_ERROR, PROGRAM_ERRORS } from "../../src/profile/core/program.js";
import { MAX_DATA_LEN, profileOf, profileScenario } from "../support/profiles.js";
import { startApi, type Api } from "./support/harness.js";
import type { Received, Reply } from "./support/providers.js";

/**
 * The profile routes over real HTTP, with a stand-in for the private rollup:
 * its two sign-in calls, and its JSON-RPC behind a read token.
 */

const { programId, gate, owner, genuine, hostile, encode } = profileScenario();
const OWNER = owner.publicKey.toBase58();
const GATE_SECRET = JSON.stringify([...gate.secretKey]);
const READ_TOKEN = "rollup-read-token";
const CHALLENGE = "sign in to the rollup at 1790000000";
const SIGNATURE = base58(new Uint8Array(64).fill(9));
const STALE_REVISION = FIRST_PROGRAM_ERROR + PROGRAM_ERRORS.indexOf("StaleRevision");

type RpcCall = { method: string; params: unknown[] };
const rpcOf = (request: Received) => JSON.parse(request.body) as RpcCall;
const rpcCalls = (api: Api) =>
  api.providers
    .sentTo("rollup")
    .filter((request) => request.path.startsWith("/?"))
    .map((request) => ({ path: request.path, ...rpcOf(request) }));

/** A rollup that signs anyone in, holds `account` for every profile, and lands every transaction with `err`. */
const rollup =
  (state: { account?: string | null; err?: unknown } = {}) =>
  (request: Received): Reply => {
    if (request.path.startsWith("/auth/challenge")) return { body: { challenge: CHALLENGE } };
    if (request.path === "/auth/login") {
      return { body: { token: READ_TOKEN, expiresAt: 1_790_000_000_000 } };
    }
    const { method } = rpcOf(request);
    const result = (value: unknown) => ({ body: { jsonrpc: "2.0", id: 1, result: value } });
    if (method === "getAccountInfo") {
      return result({
        context: { slot: 1 },
        value: state.account
          ? { data: [state.account, "base64"], owner: programId.toBase58(), lamports: 1 }
          : null,
      });
    }
    if (method === "getLatestBlockhash") {
      return result({
        context: { slot: 1 },
        value: { blockhash: OWNER, lastValidBlockHeight: 42 },
      });
    }
    if (method === "getSignatureStatuses") {
      return result({
        context: { slot: 1 },
        value: [{ slot: 1, err: state.err ?? null, confirmationStatus: "confirmed" }],
      });
    }
    return result("the-rollup's-own-word-for-the-id");
  };

const submit = (api: Api, bytes: Uint8Array, token?: string) =>
  api.call("/v1/profile/submit", {
    body: { token: READ_TOKEN, transaction: encode(bytes) },
    ...(token ? { token } : {}),
  });

describe("the profile routes", () => {
  let api: Api;

  beforeAll(async () => {
    api = await startApi({
      PROFILE_ROLLUP_URL: "{rollup}",
      PROFILE_PROGRAM_ID: programId.toBase58(),
      PROFILE_GATE_SECRET_KEY: GATE_SECRET,
      PROFILE_MAX_DATA_LEN: String(MAX_DATA_LEN),
    });
  });
  afterAll(() => api.close());
  beforeEach(() => {
    api.providers.reset();
    api.providers.answer("rollup", rollup());
    api.logged.length = 0;
  });

  it("GET /v1/profile/config names the program, the gate's public key and the limit, and asks nobody", async () => {
    const response = await api.call("/v1/profile/config");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      enabled: true,
      programId: programId.toBase58(),
      gate: gate.publicKey.toBase58(),
      maxDataLen: MAX_DATA_LEN,
    });
    expect(api.providers.received).toHaveLength(0);
  });

  it("POST /v1/profile/challenge asks the rollup for the owner's challenge, and sends nothing else of the caller", async () => {
    const token = await api.token();
    const response = await api.call("/v1/profile/challenge", {
      body: { owner: OWNER },
      token,
      ip: "203.0.113.9",
    });
    expect([response.status, response.json]).toEqual([200, { challenge: CHALLENGE }]);

    const [sent] = api.providers.sentTo("rollup");
    expect([sent.method, sent.path, sent.body]).toEqual([
      "GET",
      `/auth/challenge?pubkey=${OWNER}`,
      "",
    ]);
    expect(sent.headers.authorization).toBeUndefined();
    const everything = JSON.stringify(sent);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("203.0.113.9");
  });

  it("POST /v1/profile/session exchanges the signed challenge for the rollup's read token", async () => {
    const response = await api.call("/v1/profile/session", {
      body: { owner: OWNER, challenge: CHALLENGE, signature: SIGNATURE },
    });
    expect([response.status, response.json]).toEqual([
      200,
      { token: READ_TOKEN, expiresAt: 1_790_000_000_000 },
    ]);
    const [sent] = api.providers.sentTo("rollup");
    expect([sent.method, sent.path]).toEqual(["POST", "/auth/login"]);
    expect(JSON.parse(sent.body)).toEqual({
      pubkey: OWNER,
      challenge: CHALLENGE,
      signature: SIGNATURE,
    });
  });

  it("never answers a sign-in the rollup turns down as a 401, which would blame the caller's session", async () => {
    api.providers.answer("rollup", () => ({ status: 401, body: { error: "Invalid signature" } }));
    const response = await api.call("/v1/profile/session", {
      body: { owner: OWNER, challenge: CHALLENGE, signature: SIGNATURE },
    });
    expect([response.status, response.json.code]).toEqual([502, "upstream_refused"]);
    expect(response.text).not.toContain("Invalid signature");
  });

  it("POST /v1/profile/read reads the account derived from the owner, with the read token, and answers its data or null", async () => {
    const none = await api.call("/v1/profile/read", { body: { owner: OWNER, token: READ_TOKEN } });
    expect([none.status, none.json]).toEqual([200, { data: null }]);

    api.providers.answer("rollup", rollup({ account: "AQIDBAU=" }));
    const found = await api.call("/v1/profile/read", { body: { owner: OWNER, token: READ_TOKEN } });
    expect([found.status, found.json]).toEqual([200, { data: "AQIDBAU=" }]);

    for (const call of rpcCalls(api)) {
      expect(call.path).toBe(`/?token=${READ_TOKEN}`);
      expect(call.method).toBe("getAccountInfo");
      expect(call.params[0]).toBe(profileOf(programId, owner.publicKey).toBase58());
    }
    expect(rpcCalls(api)).toHaveLength(2);
  });

  it("does not let a caller name the account to read", async () => {
    const other = profileOf(programId, Keypair.generate().publicKey).toBase58();
    for (const body of [
      { owner: OWNER, token: READ_TOKEN, account: other },
      { token: READ_TOKEN, account: other },
      { owner: "not-a-key", token: READ_TOKEN },
    ]) {
      const response = await api.call("/v1/profile/read", { body });
      expect([response.status, response.json.code]).toEqual([400, "invalid_request"]);
    }
    expect(api.providers.sentTo("rollup")).toHaveLength(0);
  });

  it("POST /v1/profile/blockhash answers the rollup's blockhash", async () => {
    const response = await api.call("/v1/profile/blockhash", { body: { token: READ_TOKEN } });
    expect([response.status, response.json]).toEqual([
      200,
      { blockhash: OWNER, lastValidBlockHeight: 42 },
    ]);
    expect(rpcCalls(api).map((call) => call.method)).toEqual(["getLatestBlockhash"]);
  });

  it("POST /v1/profile/submit sends a creation on with the gate's signature beside the owner's, and answers its id", async () => {
    const response = await submit(api, genuine.create());

    const [sent, asked] = rpcCalls(api);
    expect(sent.path).toBe(`/?token=${READ_TOKEN}`);
    expect(sent.method).toBe("sendTransaction");
    const transaction = Transaction.from(Buffer.from(sent.params[0] as string, "base64"));
    expect(transaction.verifySignatures()).toBe(true);
    expect(transaction.signatures.map(({ publicKey }) => publicKey.toBase58())).toEqual([
      gate.publicKey.toBase58(),
      OWNER,
    ]);
    const id = base58(transaction.signatures[0].signature as Uint8Array);
    expect([response.status, response.json]).toEqual([200, { signature: id }]);
    expect([asked.method, asked.params]).toEqual(["getSignatureStatuses", [[id]]]);
  });

  it("answers a write on a stale revision as a 409 under the program's name", async () => {
    api.providers.answer(
      "rollup",
      rollup({ err: { InstructionError: [0, { Custom: STALE_REVISION }] } }),
    );
    const response = await submit(api, genuine.write());
    expect(response.status).toBe(409);
    expect(response.json).toEqual({
      code: "StaleRevision",
      error: "The profile changed since it was read. Read it again.",
    });
  });

  it("refuses what is not a profile transaction before the rollup hears of it", async () => {
    for (const name of ["a compute-budget instruction in front", "another owner's profile"]) {
      const response = await submit(api, hostile[name][0]());
      expect([response.status, response.json.code], name).toEqual([422, "refused"]);
    }
    expect(api.providers.sentTo("rollup")).toHaveLength(0);
  });

  it("rations creations per session, and sends nothing for one past the limit", async () => {
    const token = await api.token();
    const creation = () => genuine.create(undefined, Keypair.generate());
    for (let i = 0; i < CREATIONS_PER_HOUR_PER_SESSION; i += 1) {
      expect((await submit(api, creation(), token)).status).toBe(200);
    }
    const sentBefore = api.providers.sentTo("rollup").length;
    const refused = await submit(api, creation(), token);
    expect([refused.status, refused.json.code]).toEqual([429, "rate_limited"]);
    expect(api.providers.sentTo("rollup")).toHaveLength(sentBefore);
  });

  it("passes on none of the rollup's own words, and answers a page it serves as a 502", async () => {
    api.providers.answer("rollup", () => ({
      headers: { "content-type": "text/html" },
      body: "<!doctype html><p>maintenance</p>",
    }));
    const response = await api.call("/v1/profile/blockhash", { body: { token: READ_TOKEN } });
    expect([response.status, response.json.code]).toEqual([502, "upstream_failed"]);
    expect(response.text).not.toContain("<");
  });

  it("logs nothing of the owner, the read token, the challenge, the transaction or the gate", async () => {
    const transaction = genuine.write();
    await api.call("/v1/profile/challenge", { body: { owner: OWNER } });
    await api.call("/v1/profile/read", { body: { owner: OWNER, token: READ_TOKEN } });
    await submit(api, transaction);
    await submit(api, hostile["another sponsor"][0]());

    expect(api.logged.filter((line) => line.event === "request")).toHaveLength(4);
    const everything = JSON.stringify(api.logged);
    for (const secret of [
      OWNER,
      READ_TOKEN,
      CHALLENGE,
      encode(transaction),
      gate.publicKey.toBase58(),
      GATE_SECRET,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe("a deployment with no profile configuration", () => {
  let api: Api;

  beforeAll(async () => {
    api = await startApi({
      PROFILE_ROLLUP_URL: "{rollup}",
      PROFILE_PROGRAM_ID: programId.toBase58(),
    });
    api.providers.answer("rollup", rollup());
  });
  afterAll(() => api.close());

  it("says profiles are off, and answers 404 on every other profile route", async () => {
    const config = await api.call("/v1/profile/config");
    expect([config.status, config.json]).toEqual([200, { enabled: false }]);

    const routes: [path: string, body: unknown][] = [
      ["/v1/profile/challenge", { owner: OWNER }],
      ["/v1/profile/session", { owner: OWNER, challenge: CHALLENGE, signature: SIGNATURE }],
      ["/v1/profile/read", { owner: OWNER, token: READ_TOKEN }],
      ["/v1/profile/blockhash", { token: READ_TOKEN }],
      ["/v1/profile/submit", { token: READ_TOKEN, transaction: encode(genuine.create()) }],
    ];
    for (const [path, body] of routes) {
      const response = await api.call(path, { body });
      expect([response.status, response.json.code], path).toEqual([404, "not_found"]);
    }
    expect(api.providers.sentTo("rollup")).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { ALLOWED_METHODS, HEAVY_METHODS, readRpcCall } from "../../src/rpc/core/rpc.js";

const ADDRESS = "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ";
const call = (method: string, params: unknown[] = []) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});
const read = (body: unknown) => readRpcCall(JSON.stringify(body));
const refusal = (body: unknown, raw?: string) => {
  const reading = raw === undefined ? read(body) : readRpcCall(raw);
  if (!("refused" in reading)) throw new Error("not refused");
  return { status: reading.refused.status, ...JSON.parse(reading.refused.body!) };
};

describe("reading a JSON-RPC call", () => {
  it("passes every method the wallet calls", () => {
    for (const method of [...ALLOWED_METHODS].filter(
      (name) => name !== "getSignaturesForAddress",
    )) {
      expect(read(call(method, [ADDRESS]))).toEqual({ method, heavy: HEAVY_METHODS.has(method) });
    }
  });

  it("passes a call as the wallet's client writes it, with a text id and no params", () => {
    expect(
      read({
        jsonrpc: "2.0",
        id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
        method: "getGenesisHash",
      }),
    ).toEqual({ method: "getGenesisHash", heavy: false });
  });

  it("marks the calls that cost the provider real work", () => {
    expect([...HEAVY_METHODS].sort()).toEqual([
      "getSignaturesForAddress",
      "getTokenAccountsByOwner",
      "getTransaction",
      "sendTransaction",
      "simulateTransaction",
    ]);
  });

  it("lets the wallet look for a landed transaction: one address, a stated and small limit", () => {
    const search = (params: unknown) =>
      read({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params });
    expect(search([ADDRESS, { limit: 50, commitment: "confirmed" }])).toEqual({
      method: "getSignaturesForAddress",
      heavy: true,
    });
    expect(search([ADDRESS, { limit: 1 }])).toMatchObject({ heavy: true });
    expect(
      search([ADDRESS, { limit: 10, before: "5".repeat(88), until: "5".repeat(88) }]),
    ).toMatchObject({
      heavy: true,
    });
    for (const params of [
      undefined,
      [],
      [ADDRESS],
      [ADDRESS, {}],
      [ADDRESS, { limit: 51 }],
      [ADDRESS, { limit: 1000 }],
      [ADDRESS, { limit: 0 }],
      [ADDRESS, { limit: 2.5 }],
      [ADDRESS, { limit: "50" }],
      [ADDRESS, { limit: 10, commitment: "processed" }],
      [ADDRESS, { limit: 10, extra: true }],
      [ADDRESS, { limit: 10 }, "confirmed"],
      [[ADDRESS, ADDRESS], { limit: 10 }],
      ["not an address", { limit: 10 }],
      [`${ADDRESS},${ADDRESS}`, { limit: 10 }],
    ]) {
      const reading = search(params);
      expect("refused" in reading && reading.refused.status, JSON.stringify(params)).toBe(400);
    }
  });

  it("refuses a method the wallet does not use", () => {
    for (const method of ["getProgramAccounts", "requestAirdrop", "getBlock", "", "constructor"]) {
      expect(refusal(call(method, [ADDRESS]))).toMatchObject({
        status: 403,
        code: "method_not_allowed",
      });
    }
    expect(refusal({ jsonrpc: "2.0", id: 1, method: 7 })).toMatchObject({ status: 403 });
  });

  it("refuses every batch: the wallet sends none, and an array would multiply a rate limit", () => {
    const allowed = [call("getBalance", [ADDRESS]), call("getLatestBlockhash")];
    const mixed = [call("getBalance", [ADDRESS]), call("requestAirdrop")];
    for (const batch of [allowed, mixed, [call("getBalance", [ADDRESS])], []]) {
      expect(refusal(batch)).toMatchObject({ status: 400, code: "invalid_request" });
    }
  });

  it("refuses what is not JSON, and what is not one well-formed call", () => {
    expect(refusal(null, "not json")).toMatchObject({ status: 400, code: "invalid_request" });
    for (const body of [
      null,
      "text",
      7,
      { jsonrpc: "1.0", id: 1, method: "getBalance" },
      { id: 1, method: "getBalance" },
      { jsonrpc: "2.0", method: "getBalance" },
      { jsonrpc: "2.0", id: {}, method: "getBalance" },
      { jsonrpc: "2.0", id: 1, method: "getBalance", params: { address: ADDRESS } },
      { jsonrpc: "2.0", id: 1, method: "getBalance", params: [], extra: true },
    ]) {
      expect(refusal(body)).toMatchObject({ status: 400, code: "invalid_request" });
    }
  });
});

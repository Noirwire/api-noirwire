import { describe, expect, it } from "vitest";
import {
  JUPITER_ROUTES,
  jupiterRoute,
  planJupiter,
  queryFrom,
} from "../../src/jupiter/core/jupiter.js";
import { PRIVATE_PAYMENT_PATHS } from "../../src/private-payments/core/privatePayments.js";

const ADDRESS = "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ";
const order = {
  inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  outputMint: "So11111111111111111111111111111111111111112",
  amount: "10000000",
  taker: ADDRESS,
  slippageBps: "50",
};

function plan(method: "GET" | "POST", path: string, body: unknown, hasQuery = false) {
  const route = jupiterRoute(method, path);
  if (!route) return "not found";
  const planned = planJupiter(route, method, path, JSON.stringify(body), hasQuery);
  return "refused" in planned ? planned.refused.status : planned.upstream;
}

describe("the Jupiter allow-list", () => {
  it("is exactly the paths the wallets use", () => {
    expect(Object.keys(JUPITER_ROUTES).sort()).toEqual([
      "GET lend/v1/earn/tokens",
      "POST lend/v1/earn/deposit",
      "POST lend/v1/earn/deposit-instructions",
      "POST lend/v1/earn/earnings",
      "POST lend/v1/earn/withdraw",
      "POST lend/v1/earn/withdraw-instructions",
      "POST swap/v2/execute",
      "POST swap/v2/order",
    ]);
  });

  it("is not an open proxy: an unlisted path or method goes nowhere", () => {
    const unlisted = [
      "tokens/v2/search",
      "swap/v2/order/../../price/v3",
      "ultra/v1/balances",
      "price/v3",
      "",
      "swap/v2/order/",
      "SWAP/V2/ORDER",
    ];
    for (const path of unlisted) expect(plan("POST", path, {})).toBe("not found");
    expect(plan("GET", "swap/v2/execute", {})).toBe("not found");
    expect(plan("POST", "lend/v1/earn/tokens", {})).toBe("not found");
    expect(jupiterRoute("POST", "constructor")).toBeUndefined();
    expect(jupiterRoute("DELETE", "swap/v2/order")).toBeUndefined();
  });

  it("turns an order posted as a body into Jupiter's GET", () => {
    expect(plan("POST", "swap/v2/order", order)).toEqual({
      method: "GET",
      pathAndQuery: `swap/v2/order?${new URLSearchParams(order).toString()}`,
    });
  });

  it("refuses an order carrying a field it does not know, so nobody can name a payer or a receiver", () => {
    for (const field of ["payer", "receiver", "excludeRouters"]) {
      expect(plan("POST", "swap/v2/order", { ...order, [field]: ADDRESS })).toBe(400);
    }
  });

  it("refuses a body that is not a flat object of strings", () => {
    expect(queryFrom("not json", ["a"])).toBeNull();
    expect(queryFrom("[]", ["a"])).toBeNull();
    expect(queryFrom("null", ["a"])).toBeNull();
    expect(queryFrom('{"a":1}', ["a"])).toBeNull();
    expect(queryFrom('{"a":{"b":"c"}}', ["a"])).toBeNull();
    expect(queryFrom('{"a":["x","y"]}', ["a"])).toBeNull();
    expect(queryFrom('{"a":"x&b=y"}', ["a"])).toBe("a=x%26b%3Dy");
    expect(queryFrom("{}", ["a"])).toBe("");
  });

  it("turns an earnings read into a GET with only its two fields", () => {
    expect(plan("POST", "lend/v1/earn/earnings", { user: ADDRESS, positions: "a,b" })).toEqual({
      method: "GET",
      pathAndQuery: `lend/v1/earn/earnings?user=${ADDRESS}&positions=a%2Cb`,
    });
    expect(plan("POST", "lend/v1/earn/earnings", { user: ADDRESS, other: "x" })).toBe(400);
  });

  it("posts a signed swap and the lending requests on with their body unchanged", () => {
    const body = { signedTransaction: "AQID", requestId: "request" };
    for (const path of [
      "swap/v2/execute",
      "lend/v1/earn/deposit",
      "lend/v1/earn/withdraw",
      "lend/v1/earn/deposit-instructions",
      "lend/v1/earn/withdraw-instructions",
    ]) {
      expect(plan("POST", path, body)).toEqual({
        method: "POST",
        pathAndQuery: path,
        body: JSON.stringify(body),
      });
    }
  });

  it("reads the vault list with a plain GET and no body", () => {
    expect(plan("GET", "lend/v1/earn/tokens", undefined)).toEqual({
      method: "GET",
      pathAndQuery: "lend/v1/earn/tokens",
    });
  });

  it("never passes a caller's query string on", () => {
    expect(plan("GET", "lend/v1/earn/tokens", undefined, true)).toBe(400);
    expect(plan("POST", "swap/v2/execute", {}, true)).toBe(400);
    expect(plan("POST", "swap/v2/order", order, true)).toBe(400);
  });
});

describe("the private-payment allow-list", () => {
  it("is exactly the three paths the wallets use", () => {
    expect([...PRIVATE_PAYMENT_PATHS].sort()).toEqual([
      "v1/spl/transfer",
      "v1/spl/transfer-queue/ensure-crank",
      "v1/transaction/send",
    ]);
    expect(PRIVATE_PAYMENT_PATHS.has("v1/spl/balance")).toBe(false);
  });
});

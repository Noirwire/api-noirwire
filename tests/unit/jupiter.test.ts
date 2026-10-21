import { describe, expect, it } from "vitest";
import {
  JUPITER_ROUTES,
  jupiterRoute,
  NOIRWIRE_FEE_BPS,
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

const REFERRAL = "BPFLoaderUpgradeab1e11111111111111111111111";
const STRANGER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function plan(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  referralAccount: string | null = null,
) {
  const route = jupiterRoute(method, path);
  if (!route) return "not found";
  const planned = planJupiter(route, method, path, JSON.stringify(body), referralAccount);
  return "refused" in planned ? planned.refused.status : planned.upstream;
}

/** The query Jupiter is sent for an order, as fields. */
function orderSent(body: unknown, referralAccount: string | null) {
  const planned = plan("POST", "swap/v2/order", body, referralAccount);
  if (typeof planned !== "object") throw new Error(`order refused: ${planned}`);
  const [path, query] = planned.pathAndQuery.split("?");
  expect(path).toBe("swap/v2/order");
  return Object.fromEntries(new URLSearchParams(query));
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

  it("lets an order leave out the routers the wallet cannot check, and no other router choice", () => {
    const leftOut = { ...order, excludeRouters: "dflow,okx" };
    expect(plan("POST", "swap/v2/order", leftOut)).toEqual({
      method: "GET",
      pathAndQuery: `swap/v2/order?${new URLSearchParams(leftOut).toString()}`,
    });
    for (const routers of ["jupiterz", "dflow", "okx,dflow", "metis,jupiterz,dflow,okx", ""]) {
      expect(plan("POST", "swap/v2/order", { ...order, excludeRouters: routers })).toBe(400);
    }
  });

  it("sends every order with NoirWire's referral account and a fee of 50 bps, set by the server", () => {
    expect(NOIRWIRE_FEE_BPS).toBe(50);
    expect(orderSent(order, REFERRAL)).toEqual({
      ...order,
      referralAccount: REFERRAL,
      referralFee: "50",
    });
  });

  it("charges the fee on a price-only order too, one that names no taker", () => {
    const { taker: _taker, ...priceOnly } = order;
    expect(orderSent({ ...priceOnly, excludeRouters: "dflow,okx" }, REFERRAL)).toEqual({
      ...priceOnly,
      excludeRouters: "dflow,okx",
      referralAccount: REFERRAL,
      referralFee: "50",
    });
  });

  it("drops a caller's referral account and fee, whatever they say, and writes the server's", () => {
    for (const asked of [
      { referralAccount: STRANGER, referralFee: "255" },
      { referralAccount: STRANGER },
      { referralFee: "0" },
      { referralFee: "1" },
      { referralAccount: REFERRAL, referralFee: "50" },
      { referralAccount: "", referralFee: "" },
    ]) {
      expect(orderSent({ ...order, ...asked }, REFERRAL), JSON.stringify(asked)).toEqual({
        ...order,
        referralAccount: REFERRAL,
        referralFee: "50",
      });
    }
  });

  it("sends no fee at all when no referral account is configured, whatever the caller asked", () => {
    for (const asked of [{}, { referralAccount: STRANGER, referralFee: "255" }]) {
      expect(orderSent({ ...order, ...asked }, null)).toEqual(order);
    }
  });

  it("still refuses a dropped fee field that is not a string", () => {
    expect(plan("POST", "swap/v2/order", { ...order, referralFee: 255 }, REFERRAL)).toBe(400);
  });

  it("adds no fee to the routes that are not orders", () => {
    expect(
      plan("POST", "lend/v1/earn/earnings", { user: ADDRESS, positions: "a" }, REFERRAL),
    ).toEqual({ method: "GET", pathAndQuery: `lend/v1/earn/earnings?user=${ADDRESS}&positions=a` });
    expect(
      plan("POST", "lend/v1/earn/earnings", { user: ADDRESS, referralFee: "50" }, REFERRAL),
    ).toBe(400);
    const body = { signedTransaction: "AQID", requestId: "request" };
    expect(plan("POST", "swap/v2/execute", body, REFERRAL)).toEqual({
      method: "POST",
      pathAndQuery: "swap/v2/execute",
      body: JSON.stringify(body),
    });
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

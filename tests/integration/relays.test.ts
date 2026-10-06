import { request as rawRequest } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ANSWER_HEADERS, answerHeaders, startApi, type Api } from "./support/harness.js";

const ADDRESS = "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ";
const rpcCall = (method: string, params: unknown[] = []) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  params,
});
const order = {
  inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  outputMint: "So11111111111111111111111111111111111111112",
  amount: "10000000",
  taker: ADDRESS,
  slippageBps: "50",
};

let api: Api;

beforeAll(async () => {
  api = await startApi();
});
afterAll(() => api.close());
beforeEach(() => {
  api.providers.reset();
  api.logged.length = 0;
});

describe("POST /v1/rpc", () => {
  it("passes an allowed call on exactly as it came, and the answer back", async () => {
    const body = JSON.stringify(rpcCall("getBalance", [ADDRESS]));
    const response = await api.call("/v1/rpc", { body });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ jsonrpc: "2.0", id: 1, result: 1 });
    expect(answerHeaders(response.headers)).toEqual(ANSWER_HEADERS);
    const [sent] = api.providers.sentTo("rpc");
    expect(sent.method).toBe("POST");
    expect(sent.body).toBe(body);
  });

  it("sends nothing of the caller upstream: no IP, token, cookie, referer, origin or browser", async () => {
    const token = await api.token();
    await api.call("/v1/rpc", {
      body: rpcCall("getBalance", [ADDRESS]),
      token,
      ip: "203.0.113.9",
      headers: {
        cookie: "session=secret",
        "user-agent": "Mozilla/5.0 (Macintosh) Chrome/140",
        referer: "https://app.noirwire.example/portfolios/acc_1",
        "x-forwarded-for": "203.0.113.9",
        "accept-language": "sk-SK",
        "x-noirwire-client": "mobile/1.0.0",
      },
    });

    const [sent] = api.providers.sentTo("rpc");
    const { host, connection, "content-length": _length, ...headers } = sent.headers;
    expect(host).toContain("127.0.0.1");
    expect(connection).toBeDefined();
    // Besides the three this server writes, only what Node's own client
    // adds to every request, none of which says anything of the caller.
    expect(Object.keys(headers).sort()).toEqual([
      "accept",
      "accept-encoding",
      "accept-language",
      "cache-control",
      "content-type",
      "pragma",
      "sec-fetch-mode",
      "user-agent",
    ]);
    expect(headers).toMatchObject({
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (compatible; NoirWire)",
    });
    expect(headers["accept-language"]).toBe("*");
    expect(headers["cache-control"]).toBe("no-cache");
    const everything = JSON.stringify(sent);
    for (const secret of [
      token,
      "203.0.113.9",
      "session=secret",
      "Chrome/140",
      "portfolios/acc_1",
      "sk-SK",
      "mobile/1.0.0",
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("refuses a method the wallet does not use", async () => {
    const response = await api.call("/v1/rpc", { body: rpcCall("getProgramAccounts", [ADDRESS]) });
    expect(response.status).toBe(403);
    expect(response.json).toEqual({
      code: "method_not_allowed",
      error: "This method is not one the wallets use.",
    });
    expect(api.providers.sentTo("rpc")).toHaveLength(0);
  });

  it("lets the wallet look for a signer's recent transactions: one address, a stated small limit", async () => {
    const search = (params: unknown) =>
      api.call("/v1/rpc", {
        body: { jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params },
      });
    api.providers.answer("rpc", () => ({ body: { jsonrpc: "2.0", id: 1, result: [] } }));
    const found = await search([ADDRESS, { limit: 50, commitment: "confirmed" }]);
    expect(found.status).toBe(200);
    expect(found.json.result).toEqual([]);
    expect(JSON.parse(api.providers.sentTo("rpc")[0].body).params).toEqual([
      ADDRESS,
      { limit: 50, commitment: "confirmed" },
    ]);

    for (const params of [
      [ADDRESS],
      [ADDRESS, {}],
      [ADDRESS, { limit: 1000 }],
      [ADDRESS, { limit: 0 }],
    ]) {
      const refused = await search(params);
      expect([refused.status, refused.json.code]).toEqual([400, "invalid_request"]);
    }
    expect(api.providers.sentTo("rpc")).toHaveLength(1);
  });

  it("refuses every batch", async () => {
    const batches = [
      [rpcCall("getBalance", [ADDRESS]), rpcCall("getLatestBlockhash")],
      [rpcCall("getBalance", [ADDRESS])],
      [],
    ];
    for (const batch of batches) {
      const response = await api.call("/v1/rpc", { body: batch });
      expect(response.status).toBe(400);
      expect(response.json.code).toBe("invalid_request");
    }
    expect((await api.call("/v1/rpc", { body: "not json" })).status).toBe(400);
    expect(api.providers.sentTo("rpc")).toHaveLength(0);
  });

  it("passes back the status and the JSON body, and no upstream header at all", async () => {
    api.providers.answer("rpc", () => ({
      status: 503,
      headers: {
        "content-type": "text/plain",
        "set-cookie": "provider=1",
        "x-ratelimit-remaining": "3",
        "cache-control": "public, max-age=60",
      },
      body: '{"error":"busy"}',
    }));
    const response = await api.call("/v1/rpc", { body: rpcCall("getBalance", [ADDRESS]) });

    expect(response.status).toBe(503);
    expect(response.text).toBe('{"error":"busy"}');
    expect(answerHeaders(response.headers)).toEqual(ANSWER_HEADERS);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-ratelimit-remaining")).toBeNull();
  });

  it("never serves a provider's HTML: it becomes a JSON 502", async () => {
    api.providers.answer("rpc", () => ({
      headers: { "content-type": "text/html" },
      body: "<!doctype html><script>fetch('https://evil.example')</script>",
    }));
    const response = await api.call("/v1/rpc", { body: rpcCall("getBalance", [ADDRESS]) });

    expect(response.status).toBe(502);
    expect(answerHeaders(response.headers)).toEqual(ANSWER_HEADERS);
    expect(response.text).not.toContain("<");
    expect(response.json).toEqual({
      code: "upstream_failed",
      error: "The provider did not give a usable answer.",
    });
  });

  it("passes a provider's rate limit on as 429", async () => {
    api.providers.answer("rpc", () => ({ status: 429, body: "Too Many Requests" }));
    const response = await api.call("/v1/rpc", { body: rpcCall("getBalance", [ADDRESS]) });

    expect(response.status).toBe(429);
    expect(response.json).toEqual({
      code: "rate_limited",
      error: "Too many requests. Wait and try again.",
    });
    expect(answerHeaders(response.headers)).toEqual(ANSWER_HEADERS);
  });

  it("never passes a provider's 401 or 403 on: the caller's session is not what was refused", async () => {
    for (const status of [401, 403]) {
      api.logged.length = 0;
      api.providers.answer("rpc", () => ({ status, body: { error: "invalid api key" } }));
      const response = await api.call("/v1/rpc", {
        body: rpcCall("sendTransaction", ["AQID"]),
      });
      expect(response.status).toBe(502);
      expect(response.json).toEqual({
        code: "upstream_refused",
        error: "The provider refused this server's own credentials.",
      });
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(api.logged).toContainEqual({
        event: "operator_error",
        route: "rpc",
        status,
        reason: "upstream_refused_credentials",
      });
    }
  });

  it("passes a provider's own error body back as the provider wrote it", async () => {
    const providerError = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32002, message: "Blockhash not found" },
    };
    api.providers.answer("rpc", () => ({ status: 400, body: providerError }));
    const response = await api.call("/v1/rpc", { body: rpcCall("sendTransaction", ["AQID"]) });
    expect(response.status).toBe(400);
    expect(response.json).toEqual(providerError);
  });

  it("answers 502 to an upstream answer past the size cap", async () => {
    api.providers.answer("rpc", () => ({
      body: JSON.stringify({ pad: "x".repeat(5 * 1024 * 1024) }),
    }));
    const response = await api.call("/v1/rpc", { body: rpcCall("getBalance", [ADDRESS]) });
    expect(response.status).toBe(502);
    expect(response.text.length).toBeLessThan(200);
  });

  it("refuses a body over the size limit", async () => {
    const response = await api.call("/v1/rpc", {
      body: rpcCall("sendTransaction", ["A".repeat(70_000)]),
    });
    expect(response.status).toBe(413);
    expect(response.json).toEqual({
      code: "request_too_large",
      error: "The request body is too large.",
    });
    expect(response.headers.get("connection")).toBe("close");
    expect(api.providers.sentTo("rpc")).toHaveLength(0);
  });

  it("stops reading a streamed body at the limit, whatever its length claimed", async () => {
    const token = await api.token();
    const status = await new Promise<number>((resolve, reject) => {
      const request = rawRequest(
        `${api.url}/v1/rpc`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "transfer-encoding": "chunked",
            "x-real-ip": "10.250.0.1",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      const kilobyte = "A".repeat(1024);
      for (let i = 0; i < 80; i += 1) request.write(kilobyte);
      request.end();
    });
    expect(status).toBe(413);
    expect(api.providers.sentTo("rpc")).toHaveLength(0);
  });

  it("gives up on a body that does not arrive", async () => {
    const token = await api.token();
    const answered = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = rawRequest(
        `${api.url}/v1/rpc`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "transfer-encoding": "chunked",
            "x-real-ip": "10.250.0.2",
          },
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
        },
      );
      request.on("error", reject);
      request.write("{");
    });
    expect(answered.status).toBe(408);
    expect(JSON.parse(answered.body)).toEqual({
      code: "request_timeout",
      error: "The request body took too long to arrive.",
    });
    expect(api.providers.sentTo("rpc")).toHaveLength(0);
  });
});

describe("GET|POST /v1/jupiter/*", () => {
  it("turns an order posted as a body into Jupiter's GET, with the server's key", async () => {
    const response = await api.call("/v1/jupiter/swap/v2/order", { body: order });

    expect(response.status).toBe(200);
    const [sent] = api.providers.sentTo("jupiter");
    expect(sent.method).toBe("GET");
    expect(sent.body).toBe("");
    expect(sent.path).toBe(`/swap/v2/order?${new URLSearchParams(order).toString()}`);
    expect(sent.headers["x-api-key"]).toBe("server-jupiter-key");
    expect(sent.headers.authorization).toBeUndefined();
  });

  it("refuses an order carrying a field it does not know", async () => {
    for (const field of ["payer", "receiver", "excludeRouters"]) {
      const response = await api.call("/v1/jupiter/swap/v2/order", {
        body: { ...order, [field]: ADDRESS },
      });
      expect(response.status, field).toBe(400);
    }
    expect(api.providers.sentTo("jupiter")).toHaveLength(0);
  });

  it("posts a signed swap on as a POST with its body unchanged", async () => {
    const body = JSON.stringify({ signedTransaction: "AQID", requestId: "request" });
    await api.call("/v1/jupiter/swap/v2/execute", { body });
    expect(api.providers.sentTo("jupiter")[0]).toMatchObject({
      method: "POST",
      path: "/swap/v2/execute",
      body,
    });
  });

  it("reads the lending vaults once for everyone, and never keeps a failed read", async () => {
    api.providers.answer("jupiter", () => ({ status: 500, body: { message: "down" } }));
    expect((await api.call("/v1/jupiter/lend/v1/earn/tokens")).status).toBe(500);

    api.providers.answer("jupiter", () => ({ body: [{ symbol: "USDC" }] }));
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => api.call("/v1/jupiter/lend/v1/earn/tokens")),
    );
    for (const response of answers) {
      expect(response.status).toBe(200);
      expect(response.json).toEqual([{ symbol: "USDC" }]);
      expect(response.headers.get("age")).toBe("0");
    }
    const sent = api.providers.sentTo("jupiter");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ method: "GET", path: "/lend/v1/earn/tokens" });

    api.providers.answer("jupiter", () => ({ status: 500, body: { message: "down" } }));
    const later = await api.call("/v1/jupiter/lend/v1/earn/tokens");
    expect([later.status, later.json]).toEqual([200, [{ symbol: "USDC" }]]);
    expect(api.providers.sentTo("jupiter")).toHaveLength(2);
  });

  it("turns an earnings read into a GET with only its two fields", async () => {
    await api.call("/v1/jupiter/lend/v1/earn/earnings", {
      body: { user: ADDRESS, positions: "a,b" },
    });
    expect(api.providers.sentTo("jupiter")[0].path).toBe(
      `/lend/v1/earn/earnings?user=${ADDRESS}&positions=a%2Cb`,
    );
  });

  it("is not an open proxy: an unlisted path or method goes nowhere", async () => {
    for (const path of [
      "tokens/v2/search",
      "ultra/v1/balances",
      "price/v3",
      "swap/v2/order/extra",
    ]) {
      const response = await api.call(`/v1/jupiter/${path}`, { body: {} });
      expect(response.status, path).toBe(404);
      expect(response.json).toEqual({ code: "not_found", error: "There is nothing at this path." });
    }
    expect((await api.call("/v1/jupiter/swap/v2/execute")).status).toBe(404);
    expect((await api.call("/v1/jupiter/lend/v1/earn/tokens", { body: {} })).status).toBe(404);
    expect(
      (await api.call("/v1/jupiter/swap/v2/order", { method: "PUT", body: order })).status,
    ).toBe(404);
    expect(api.providers.sentTo("jupiter")).toHaveLength(0);
  });

  it("does not let a path climb out of the list", async () => {
    const token = await api.token();
    const status = await new Promise<number>((resolve, reject) => {
      const request = rawRequest(
        `${api.url}/v1/jupiter/swap/v2/order/../../price/v3`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "x-real-ip": "10.250.0.3" },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end("{}");
    });
    expect(status).toBe(404);
    expect(api.providers.sentTo("jupiter")).toHaveLength(0);
  });

  it("never passes a caller's query string on", async () => {
    expect((await api.call("/v1/jupiter/lend/v1/earn/tokens?user=" + ADDRESS)).status).toBe(400);
    expect(
      (await api.call("/v1/jupiter/swap/v2/execute?payer=" + ADDRESS, { body: {} })).status,
    ).toBe(400);
    expect(api.providers.sentTo("jupiter")).toHaveLength(0);
  });

  it("passes Jupiter's rate limit on as 429, its 401 as a 502, and refuses a body over the cap", async () => {
    api.providers.answer("jupiter", () => ({ status: 429, body: "slow down" }));
    expect((await api.call("/v1/jupiter/swap/v2/order", { body: order })).status).toBe(429);
    api.providers.answer("jupiter", () => ({ status: 401, body: { message: "Unauthorized" } }));
    const refused = await api.call("/v1/jupiter/swap/v2/execute", { body: {} });
    expect([refused.status, refused.json.code]).toEqual([502, "upstream_refused"]);
    const large = await api.call("/v1/jupiter/swap/v2/execute", {
      body: { signedTransaction: "A".repeat(17_000) },
    });
    expect(large.status).toBe(413);
  });
});

describe("POST /v1/private-payments/*", () => {
  it("forwards the transfer paths the wallet uses, body unchanged", async () => {
    const body = JSON.stringify({ from: ADDRESS, to: ADDRESS, amount: 500000, gasless: true });
    for (const path of [
      "v1/spl/transfer",
      "v1/transaction/send",
      "v1/spl/transfer-queue/ensure-crank",
    ]) {
      api.providers.reset();
      const response = await api.call(`/v1/private-payments/${path}`, { body });
      expect(response.status).toBe(200);
      expect(response.json).toEqual({ transaction: "AQID" });
      expect(api.providers.sentTo("magicblock")[0]).toMatchObject({
        method: "POST",
        path: `/${path}`,
        body,
      });
    }
  });

  it("refuses any other path, and any other method", async () => {
    const other = await api.call("/v1/private-payments/v1/spl/balance", { body: {} });
    expect(other.status).toBe(404);
    expect((await api.call("/v1/private-payments/v1/spl/transfer")).status).toBe(404);
    expect(api.providers.sentTo("magicblock")).toHaveLength(0);
  });

  it("passes MagicBlock's rate limit on as 429, its 403 as a 502, and refuses a body over the cap", async () => {
    api.providers.answer("magicblock", () => ({ status: 429, body: "slow down" }));
    expect((await api.call("/v1/private-payments/v1/spl/transfer", { body: {} })).status).toBe(429);
    api.providers.answer("magicblock", () => ({ status: 403, body: { message: "Forbidden" } }));
    const refused = await api.call("/v1/private-payments/v1/transaction/send", { body: {} });
    expect([refused.status, refused.json.code]).toEqual([502, "upstream_refused"]);
    const large = await api.call("/v1/private-payments/v1/spl/transfer", {
      body: { pad: "A".repeat(17_000) },
    });
    expect(large.status).toBe(413);
  });
});

describe("the log", () => {
  it("writes one line per request with the route's pattern, the status and the duration, and nothing of the caller", async () => {
    const token = await api.token({ sessionId: "session-that-must-not-be-logged" });
    await api.call("/v1/rpc", {
      body: rpcCall("getBalance", [ADDRESS]),
      token,
      ip: "203.0.113.77",
    });
    await api.call("/v1/jupiter/swap/v2/order", { body: order, token, ip: "203.0.113.77" });
    await api.call("/v1/history/NVDAx/1Y", { token, ip: "203.0.113.77" });
    await api.call(`/v1/history/NVDAx/1D?probe=${ADDRESS}`, { token, ip: "203.0.113.77" });
    await api.call(`/nowhere/${ADDRESS}?q=${ADDRESS}`, { token, ip: "203.0.113.77" });

    const requests = api.logged.filter((line) => line.event === "request");
    expect(requests.map((line) => [line.route, line.status])).toEqual([
      ["POST /v1/rpc", 200],
      ["POST /v1/jupiter/*path", 200],
      ["GET /v1/history/:symbol/:range", 404],
      ["unmatched", 400],
      ["unmatched", 400],
    ]);
    for (const line of requests) {
      expect(Object.keys(line).sort()).toEqual(["event", "ms", "route", "status"]);
    }
    const everything = JSON.stringify(api.logged);
    for (const secret of [
      token,
      "session-that-must-not-be-logged",
      ADDRESS,
      "203.0.113.77",
      "NVDAx",
      "probe",
      order.inputMint,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});

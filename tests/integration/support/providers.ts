import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { JWK } from "jose";
import { ALL_STOCKS } from "../../../src/chain/core/tokenRegistry.js";
import { LEND_RECEIPT_MINT } from "../../../src/relayer/core/relayed.js";
import {
  mintAccount,
  PYTH_ACCOUNT,
  pythAccount,
  rentOf,
  USDC,
} from "../../support/transactions.js";

/**
 * One local HTTP server standing in for every provider the API talks to:
 * the RPC provider, Jupiter (trading and prices), Jupiter's chart data,
 * MagicBlock, two Kora replicas, Umami and Supabase Auth. Each lives under
 * its own path prefix, records what it was sent and answers as a test says.
 */

export type ProviderName =
  "rpc" | "jupiter" | "datapi" | "magicblock" | "kora-1" | "kora-2" | "umami" | "supabase";

export type Received = {
  provider: ProviderName;
  method: string;
  /** The path after the provider's prefix, with its query string. */
  path: string;
  headers: Record<string, string>;
  body: string;
};

export type Reply = { status?: number; headers?: Record<string, string>; body?: string | object };
type Handler = (received: Received) => Reply | "hang" | Promise<Reply | "hang">;

const SOL_PRICE = 1_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

type RpcCall = { id: unknown; method: string; params?: unknown[] };

/** The chain as the API reads it for itself: Pyth's price account, the mints it sizes accounts for, and rent. */
function chainAnswer(call: RpcCall, state: { solPrice: number | null }): Reply {
  const result = (value: unknown) => ({ body: { jsonrpc: "2.0", id: call.id, result: value } });
  if (call.method === "getMinimumBalanceForRentExemption") {
    return result(rentOf(call.params?.[0] as number));
  }
  if (call.method === "getAccountInfo") {
    const address = call.params?.[0] as string;
    const account =
      address === PYTH_ACCOUNT
        ? state.solPrice === null
          ? null
          : pythAccount(state.solPrice, 5)
        : address === USDC.toBase58() || address === LEND_RECEIPT_MINT.toBase58()
          ? mintAccount(TOKEN_PROGRAM_ID, 6)
          : ALL_STOCKS.some((stock) => stock.mint.toBase58() === address)
            ? mintAccount(TOKEN_2022_PROGRAM_ID, 8, [[14, 64]])
            : null;
    return result({
      context: { slot: 1 },
      value: account && {
        data: [account.data.toString("base64"), "base64"],
        owner: account.owner.toBase58(),
        lamports: 1,
        executable: false,
        rentEpoch: 0,
        space: account.data.length,
      },
    });
  }
  return result(1);
}

export async function startProviders() {
  const received: Received[] = [];
  const state = { solPrice: SOL_PRICE as number | null, jwks: [] as JWK[] };
  const handlers: Partial<Record<ProviderName, Handler>> = {};

  const defaults: Record<ProviderName, Handler> = {
    rpc: (request) => chainAnswer(JSON.parse(request.body) as RpcCall, state),
    jupiter: (request) =>
      request.path.startsWith("/price/v3")
        ? {
            body: {
              So11111111111111111111111111111111111111112: { usdPrice: 150, priceChange24h: 1.5 },
              [ALL_STOCKS[0].mint.toBase58()]: { usdPrice: 764.15, priceChange24h: -0.33 },
            },
          }
        : { body: { ok: true } },
    datapi: () => {
      const now = Math.floor(Date.now() / 1000);
      return {
        body: {
          candles: [
            { time: now - 7_200, close: 10 },
            { time: now - 3_600, close: 11 },
            { time: now - 60, close: 12 },
          ],
        },
      };
    },
    magicblock: () => ({ body: { transaction: "AQID" } }),
    "kora-1": () => ({ status: 500, body: "no kora configured for this test" }),
    "kora-2": () => ({ status: 500, body: "no kora configured for this test" }),
    umami: () => ({ body: { ok: true } }),
    supabase: (request) =>
      request.path === "/auth/v1/.well-known/jwks.json"
        ? { body: { keys: state.jwks } }
        : { status: 404, body: { msg: "not found" } },
  };

  const server: Server = createServer(async (req, res) => {
    const [, prefix, ...rest] = (req.url ?? "/").split("/");
    const provider = prefix as ProviderName;
    const request: Received = {
      provider,
      method: req.method ?? "GET",
      path: `/${rest.join("/")}`,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([name, value]) => [name, String(value)]),
      ),
      body: await readBody(req),
    };
    if (!(provider in defaults)) {
      res.writeHead(404).end();
      return;
    }
    // The key endpoint is read by the token check on every start; it is not what the tests count.
    if (!(provider === "supabase" && request.path.endsWith("jwks.json"))) received.push(request);
    const reply = await (handlers[provider] ?? defaults[provider])(request);
    if (reply === "hang") return;
    const body =
      reply.body === undefined
        ? ""
        : typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body);
    res.writeHead(reply.status ?? 200, {
      "content-type": typeof reply.body === "string" ? "text/plain" : "application/json",
      ...reply.headers,
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  return {
    urlOf: (provider: ProviderName) => `${base}/${provider}`,
    received,
    state,
    defaults,
    /** What `provider` was sent since the last reset. */
    sentTo: (provider: ProviderName) => received.filter((entry) => entry.provider === provider),
    /** Makes `provider` answer as `handler` says until the next reset. */
    answer(provider: ProviderName, handler: Handler) {
      handlers[provider] = handler;
    },
    reset() {
      received.length = 0;
      state.solPrice = SOL_PRICE;
      for (const name of Object.keys(handlers) as ProviderName[]) delete handlers[name];
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type Providers = Awaited<ReturnType<typeof startProviders>>;

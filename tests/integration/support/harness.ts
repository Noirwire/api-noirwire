import type { AddressInfo } from "node:net";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createApp } from "../../../src/app.js";
import type { LogLine } from "../../../src/common/core/log.js";
import { loadConfig } from "../../../src/config/core/config.js";
import { sessionToken, signingKey, type Claims, type SigningKey } from "../../support/tokens.js";
import { startProviders, type Providers } from "./providers.js";

export const ALLOWED_ORIGIN = "https://app.noirwire.example";
export const FOREIGN_ORIGIN = "https://evil.example";

export type Api = {
  app: NestExpressApplication;
  url: string;
  providers: Providers;
  logged: LogLine[];
  key: SigningKey;
  issuer: string;
  /** A session token this API accepts. Each call is a new session unless `sessionId` is given. */
  token(claims?: Partial<Claims>): Promise<string>;
  /** One request to the API. Each call comes from a new address unless `ip` is given. */
  call(path: string, options?: CallOptions): Promise<Called>;
  close(): Promise<void>;
};

export type CallOptions = {
  method?: string;
  body?: unknown;
  /** A token, or null to send none. Omitted, a fresh session's token is sent. */
  token?: string | null;
  ip?: string | null;
  headers?: Record<string, string>;
};

export type Called = {
  status: number;
  headers: Headers;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
};

let sessions = 0;
let addresses = 0;

/**
 * The real application over real HTTP, with every provider pointed at the
 * local stand-in. It trusts one proxy hop, as on the hosting platform, so a
 * test names the client address with `x-real-ip` (pass `ip: null` to send
 * none).
 */
export async function startApi(env: Record<string, string> = {}): Promise<Api> {
  const providers = await startProviders();
  const key = await signingKey("integration-key");
  providers.state.jwks = [key.jwk];
  const supabaseUrl = providers.urlOf("supabase");
  const issuer = `${supabaseUrl}/auth/v1`;
  const logged: LogLine[] = [];

  const config = loadConfig({
    SOLANA_NETWORK: "devnet",
    SOLANA_RPC_URL: providers.urlOf("rpc"),
    JUPITER_API_URL: providers.urlOf("jupiter"),
    JUPITER_API_KEY: "server-jupiter-key",
    MAGICBLOCK_API_URL: providers.urlOf("magicblock"),
    PRICE_HISTORY_API_URL: providers.urlOf("datapi"),
    SUPABASE_URL: supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_integration",
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    TRUSTED_PROXY_HOPS: "1",
    // Far above what any test sends, so only the tests that set a provider
    // rate of their own ever wait at the provider gate.
    RPC_PROVIDER_RPS: "1000",
    JUPITER_PROVIDER_RPS: "1000",
    UMAMI_URL: providers.urlOf("umami"),
    UMAMI_WEBSITE_ID: "site-id",
    UMAMI_HOSTNAME: "app.noirwire.example",
    ANALYTICS_SALT: "server-only-salt",
    ...Object.fromEntries(
      // A test names a provider it wants in a value as `{kora-1}`: its
      // address is only known once the stand-in server is up.
      Object.entries(env).map(([name, value]) => [
        name,
        value.replace(/\{([a-z0-9-]+)\}/g, (_match, provider) => providers.urlOf(provider)),
      ]),
    ),
  });
  const app = await createApp(config, (line) => void logged.push(line));
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  const token: Api["token"] = (claims = {}) => {
    sessions += 1;
    return sessionToken(key, { issuer, sessionId: `integration-session-${sessions}`, ...claims });
  };

  const call: Api["call"] = async (path, options = {}) => {
    addresses += 1;
    const bearer = options.token === undefined ? await token() : options.token;
    const body =
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);
    const response = await fetch(`${url}${path}`, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...(options.ip === null
          ? {}
          : {
              "x-real-ip":
                options.ip ??
                `10.${(addresses >> 16) & 255}.${(addresses >> 8) & 255}.${addresses & 255}`,
            }),
        ...options.headers,
      },
      body,
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
  };

  return {
    app,
    url,
    providers,
    logged,
    key,
    issuer,
    token,
    call,
    async close() {
      await app.close();
      await providers.close();
    },
  };
}

/** What every answer of the API carries, whatever a provider sent. */
export const ANSWER_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-disposition": "attachment",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};

export function answerHeaders(headers: Headers) {
  return Object.fromEntries(Object.keys(ANSWER_HEADERS).map((name) => [name, headers.get(name)]));
}

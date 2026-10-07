import { Keypair } from "@solana/web3.js";
import { z } from "zod";
import { DEVNET_RPC_URL, isAddress, type Network } from "../../chain/core/network.js";

/**
 * Everything this service is configured with, read once when it starts. A
 * value that is missing or malformed stops the start with every problem
 * named, so a bad deploy fails there and not at the first transaction.
 *
 * On Railway, which names its environment in `RAILWAY_ENVIRONMENT_NAME`, the
 * network defaults to mainnet and the one proxy in front is trusted. Anywhere
 * else the network has no default, so a laptop never lands on mainnet by
 * leaving a variable out.
 */

export type RelayerConfig = {
  /** Every replica of the relayer, each with the one key it signs as fee payer with. */
  replicas: { url: string; feePayer: string }[];
  apiKey: string;
  hmacSecret: string;
  /** The only keys a relayer-paid transaction may name as fee payer: the replicas' own. */
  feePayers: string[];
  /** The wallet whose USDC account the network cost is paid into. */
  paymentWallet: string;
  /** Whether the relayer may fund a new token account. */
  accountCreation: boolean;
};

export type AnalyticsConfig = {
  url: string;
  website: string;
  /** The site the events are counted under. */
  hostname: string;
  /** Keys the visitor code. Without it no code is sent and only totals are counted. */
  salt: string | null;
};

export type ProfileConfig = {
  /** The private rollup the profiles live on. */
  rollupUrl: string;
  programId: string;
  /** The gate's public key: the fee payer of every profile creation and write. */
  gate: string;
  /** The gate's 64-byte secret key. Read here once; never logged, returned or put in an error. */
  gateSecretKey: Uint8Array;
  /** The largest record a profile may carry, in bytes. */
  maxDataLen: number;
  /** The most profile creations the gate signs in one window of 24 hours. */
  dailyCreateCap: number;
};

export type Config = {
  port: number;
  network: Network;
  /** The RPC provider, key included. */
  rpcUrl: string;
  jupiter: { url: string; apiKey: string | null };
  privatePaymentsUrl: string;
  priceHistoryUrl: string;
  relayer: RelayerConfig | null;
  profile: ProfileConfig | null;
  auth: {
    supabaseUrl: string;
    issuer: string;
    jwksUrl: string;
    publishableKey: string;
    jwtSecret: string | null;
    sessionMaxAgeMs: number;
  };
  allowedOrigins: string[];
  trustedProxyHops: 0 | 1;
  /** Proves a request was forwarded by the web app's own server, which may then report the browser's address. */
  edgeSecret: string | null;
  /** What this server may ask of each provider, a second: below what the provider allows its key. */
  rpcProviderRps: number;
  jupiterProviderRps: number;
  sessionStarts: { perIpPerHour: number; perHour: number };
  analytics: AnalyticsConfig | null;
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuration refused:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const text = z.string().trim().min(1);

const httpUrl = text
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.hash === "";
    } catch {
      return false;
    }
  })
  .transform((value) => value.replace(/\/+$/, ""));

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const isLocal = (url: string) => LOCAL_HOSTS.has(new URL(url).hostname);

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
  const problems: string[] = [];
  const read = (name: string) => env[name]?.trim() ?? "";
  const refuse = <T>(problem: string, fallback: T): T => {
    problems.push(problem);
    return fallback;
  };
  const url = (name: string, fallback?: string): string => {
    const value = read(name) || fallback || "";
    if (!value) return refuse(`${name} is required.`, "");
    const result = httpUrl.safeParse(value);
    return result.success ? result.data : refuse(`${name} must be an http(s) URL.`, "");
  };

  const onRailway = read("RAILWAY_ENVIRONMENT_NAME") !== "";

  const network = z
    .enum(["mainnet", "devnet"])
    .safeParse(read("SOLANA_NETWORK") || (onRailway ? "mainnet" : ""));
  if (!network.success) problems.push('SOLANA_NETWORK must be "mainnet" or "devnet".');
  const networkName: Network = network.success ? network.data : "devnet";

  let rpcUrl = "";
  if (!read("SOLANA_RPC_URL") && networkName === "mainnet") {
    problems.push("SOLANA_RPC_URL is required on mainnet (a dedicated provider).");
  } else {
    rpcUrl = url("SOLANA_RPC_URL", DEVNET_RPC_URL);
    const otherNetworkNamed = networkName === "mainnet" ? /devnet|testnet/i : /mainnet/i;
    if (otherNetworkNamed.test(rpcUrl)) {
      problems.push(`SOLANA_RPC_URL names a different network than "${networkName}".`);
    }
  }

  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .safeParse(read("PORT") || "4000");
  if (!port.success) problems.push("PORT must be a port number.");

  const hops = z.enum(["0", "1"]).safeParse(read("TRUSTED_PROXY_HOPS") || (onRailway ? "1" : "0"));
  if (!hops.success) {
    problems.push("TRUSTED_PROXY_HOPS must be 0 (no proxy) or 1 (the platform's edge).");
  }

  const edgeSecret = read("EDGE_SHARED_SECRET") || null;
  if (edgeSecret !== null && edgeSecret.length < 32) {
    problems.push("EDGE_SHARED_SECRET must be at least 32 characters when set.");
  }

  const count = (name: string, fallback: number, max: number): number => {
    const parsed = z.coerce
      .number()
      .int()
      .min(1)
      .max(max)
      .safeParse(read(name) || String(fallback));
    return parsed.success
      ? parsed.data
      : refuse(`${name} must be a whole number from 1 to ${max}.`, fallback);
  };
  const rpcProviderRps = count("RPC_PROVIDER_RPS", 8, 10_000);
  const jupiterProviderRps = count("JUPITER_PROVIDER_RPS", 5, 10_000);
  const sessionStarts = {
    perIpPerHour: count("SESSION_STARTS_PER_IP_PER_HOUR", 10, 100_000),
    perHour: count("SESSION_STARTS_PER_HOUR", 600, 1_000_000),
  };

  const allowedOrigins = list(env.ALLOWED_ORIGINS);
  if (allowedOrigins.length === 0) {
    problems.push("ALLOWED_ORIGINS is required: the exact origins that may call from a browser.");
  }
  for (const origin of allowedOrigins) {
    let exact = false;
    try {
      const url = new URL(origin);
      exact =
        url.origin === origin &&
        (url.protocol === "http:" || url.protocol === "https:") &&
        /^[a-z0-9.-]+$/.test(url.hostname);
    } catch {
      exact = false;
    }
    if (!exact) {
      problems.push("ALLOWED_ORIGINS must list exact origins, such as https://app.example.com.");
    }
  }

  const supabaseUrl = url("SUPABASE_URL");
  if (supabaseUrl && !supabaseUrl.startsWith("https://") && !isLocal(supabaseUrl)) {
    problems.push(
      "SUPABASE_URL must use https: the keys that verify every token are read from it.",
    );
  }
  const publishableKey = read("SUPABASE_PUBLISHABLE_KEY");
  if (!publishableKey) problems.push("SUPABASE_PUBLISHABLE_KEY is required.");
  const jwtSecret = read("SUPABASE_JWT_SECRET") || null;
  if (jwtSecret !== null && jwtSecret.length < 32) {
    problems.push("SUPABASE_JWT_SECRET must be at least 32 characters when set.");
  }
  const maxAgeHours = z.coerce
    .number()
    .positive()
    .max(24 * 30)
    .safeParse(read("SESSION_MAX_AGE_HOURS") || "24");
  if (!maxAgeHours.success) {
    problems.push("SESSION_MAX_AGE_HOURS must be a number of hours, above 0 and at most 720.");
  }

  const umamiUrl = read("UMAMI_URL");
  const umamiWebsite = read("UMAMI_WEBSITE_ID");
  const umamiHostname = read("UMAMI_HOSTNAME");
  let analytics: AnalyticsConfig | null = null;
  if (umamiUrl || umamiWebsite || umamiHostname) {
    if (!umamiUrl || !umamiWebsite || !umamiHostname) {
      problems.push(
        "Set UMAMI_URL, UMAMI_WEBSITE_ID and UMAMI_HOSTNAME together, or none of them.",
      );
    } else {
      if (!/^[a-z0-9.-]+$/i.test(umamiHostname)) {
        problems.push("UMAMI_HOSTNAME must be a host name, such as app.example.com.");
      }
      analytics = {
        url: url("UMAMI_URL"),
        website: umamiWebsite,
        hostname: umamiHostname,
        salt: read("ANALYTICS_SALT") || null,
      };
    }
  }

  const config: Config = {
    port: port.success ? port.data : 4000,
    network: networkName,
    rpcUrl,
    jupiter: {
      url: url("JUPITER_API_URL", "https://api.jup.ag"),
      apiKey: read("JUPITER_API_KEY") || null,
    },
    privatePaymentsUrl: url("MAGICBLOCK_API_URL", "https://payments.magicblock.app"),
    priceHistoryUrl: url("PRICE_HISTORY_API_URL", "https://datapi.jup.ag"),
    relayer: relayerConfig(env, problems),
    profile: profileConfig(env, problems, count),
    auth: {
      supabaseUrl,
      issuer: `${supabaseUrl}/auth/v1`,
      jwksUrl: `${supabaseUrl}/auth/v1/.well-known/jwks.json`,
      publishableKey,
      jwtSecret,
      sessionMaxAgeMs: (maxAgeHours.success ? maxAgeHours.data : 24) * 3_600_000,
    },
    allowedOrigins,
    trustedProxyHops: hops.success && hops.data === "1" ? 1 : 0,
    edgeSecret,
    rpcProviderRps,
    jupiterProviderRps,
    sessionStarts,
    analytics,
  };
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** The hard maximum the profile program allows any deployment. */
const PROFILE_HARD_MAX_DATA_LEN = 4_096;

/** The gate's keypair from the 64 bytes of its secret key written as a JSON array, or null. */
function gateKeypair(value: string): Keypair | null {
  try {
    const bytes = z.array(z.number().int().min(0).max(255)).length(64).parse(JSON.parse(value));
    // Refuses a secret whose two halves are not one key's.
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

/**
 * The profile program on its private rollup, or null when this deployment
 * keeps no profiles: with any of `PROFILE_ROLLUP_URL`, `PROFILE_PROGRAM_ID`
 * and `PROFILE_GATE_SECRET_KEY` unset the feature is off, the wallets are
 * told so, and they work exactly as they do without it.
 *
 * With all three set, each must be right or the start is refused: the gate
 * key signs as fee payer, so a deploy must not come up holding half of one.
 * A problem names the variable and never its value.
 */
function profileConfig(
  env: Env,
  problems: string[],
  count: (name: string, fallback: number, max: number) => number,
): ProfileConfig | null {
  const read = (name: string) => env[name]?.trim() ?? "";
  const rollup = read("PROFILE_ROLLUP_URL");
  const programId = read("PROFILE_PROGRAM_ID");
  const secret = read("PROFILE_GATE_SECRET_KEY");
  if (!rollup || !programId || !secret) return null;

  const before = problems.length;
  const rollupUrl = httpUrl.safeParse(rollup);
  // A read token is appended as the query, and travels with every call.
  if (!rollupUrl.success || new URL(rollupUrl.data).search !== "") {
    problems.push("PROFILE_ROLLUP_URL must be an http(s) URL with no query string.");
  } else if (!rollupUrl.data.startsWith("https://") && !isLocal(rollupUrl.data)) {
    problems.push("PROFILE_ROLLUP_URL must use https: read tokens and transactions travel to it.");
  }
  if (!isAddress(programId)) problems.push("PROFILE_PROGRAM_ID must be a Solana address.");
  const gate = gateKeypair(secret);
  if (!gate) {
    problems.push(
      "PROFILE_GATE_SECRET_KEY must be the gate's 64-byte secret key, as a JSON array of bytes.",
    );
  }
  const maxDataLen = count("PROFILE_MAX_DATA_LEN", 2_048, PROFILE_HARD_MAX_DATA_LEN);
  const dailyCreateCap = count("PROFILE_DAILY_CREATE_CAP", 500, 1_000_000);
  if (problems.length > before || !rollupUrl.success || !gate) return null;
  return {
    rollupUrl: rollupUrl.data,
    programId,
    gate: gate.publicKey.toBase58(),
    gateSecretKey: gate.secretKey,
    maxDataLen,
    dailyCreateCap,
  };
}

/**
 * The fee relayer (Kora servers), or null when it is switched off. With
 * `KORA_URLS` unset there is no relayer: a portfolio then pays the network
 * only when it holds SOL of its own.
 *
 * `KORA_URLS` lists one or more replicas, and `KORA_FEE_PAYERS` the fee
 * payer key of each, in the same order: a replica is only ever asked to sign
 * as its own key, and when one does not answer the next is tried. They share
 * one API key, one HMAC secret and one payment wallet.
 *
 * The fee payer keys and the payment wallet are pinned here on purpose, and
 * not learned from the relayer: whatever key a compromised or misrouted
 * relayer answers with, the wallets only ever build against these and an
 * answer that names another is refused. Half a configuration is refused
 * outright, so a deploy cannot run a relayer it has no pins for.
 */
function relayerConfig(env: Env, problems: string[]): RelayerConfig | null {
  const read = (name: string) => env[name]?.trim() ?? "";
  const names = [
    "KORA_API_KEY",
    "KORA_HMAC_SECRET",
    "KORA_FEE_PAYERS",
    "KORA_PAYMENT_WALLET",
    "KORA_ACCOUNT_CREATION",
  ];
  const urls = list(read("KORA_URLS"));
  if (urls.length === 0) {
    if (names.some((name) => read(name))) {
      problems.push("KORA_URLS is unset, so no other KORA_ variable may be set either.");
    }
    return null;
  }
  const before = problems.length;
  const replicaUrls = urls.map((value) => {
    const result = httpUrl.safeParse(value);
    if (!result.success) problems.push("KORA_URLS must list http(s) URLs.");
    return result.success ? result.data : "";
  });
  const apiKey = read("KORA_API_KEY");
  const hmacSecret = read("KORA_HMAC_SECRET");
  const feePayers = list(read("KORA_FEE_PAYERS"));
  const paymentWallet = read("KORA_PAYMENT_WALLET");
  if (!apiKey || !hmacSecret || feePayers.length === 0 || !paymentWallet) {
    problems.push(
      "KORA_URLS is set, so KORA_API_KEY, KORA_HMAC_SECRET, KORA_FEE_PAYERS and KORA_PAYMENT_WALLET must all be set too.",
    );
  } else {
    if (feePayers.length !== urls.length || new Set(feePayers).size !== feePayers.length) {
      problems.push(
        "KORA_FEE_PAYERS must name one fee payer for each of KORA_URLS, each different.",
      );
    }
    if (![...feePayers, paymentWallet].every(isAddress)) {
      problems.push("KORA_FEE_PAYERS and KORA_PAYMENT_WALLET must be Solana addresses.");
    }
  }
  const creation = read("KORA_ACCOUNT_CREATION") || "on";
  if (creation !== "on" && creation !== "off") {
    problems.push('KORA_ACCOUNT_CREATION must be "on" or "off".');
  }
  if (problems.length > before) return null;
  return {
    replicas: replicaUrls.map((url, index) => ({ url, feePayer: feePayers[index] })),
    apiKey,
    hmacSecret,
    feePayers,
    paymentWallet,
    accountCreation: creation === "on",
  };
}

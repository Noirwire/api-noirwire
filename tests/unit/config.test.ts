import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/core/config.js";

const address = () => Keypair.generate().publicKey.toBase58();
const feePayer = address();
const paymentWallet = address();

const base = {
  SOLANA_NETWORK: "devnet",
  ALLOWED_ORIGINS: "https://app.example.com",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
};
const kora = {
  KORA_URLS: "http://kora.railway.internal:8080",
  KORA_API_KEY: "the-api-key",
  KORA_HMAC_SECRET: "the-hmac-secret",
  KORA_FEE_PAYERS: feePayer,
  KORA_PAYMENT_WALLET: paymentWallet,
};

function problems(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  return "";
}

describe("the configuration", () => {
  it("starts on devnet with the four required values, and defaults for the rest", () => {
    expect(loadConfig(base)).toEqual({
      port: 4000,
      network: "devnet",
      rpcUrl: "https://api.devnet.solana.com",
      jupiter: { url: "https://api.jup.ag", apiKey: null },
      privatePaymentsUrl: "https://payments.magicblock.app",
      priceHistoryUrl: "https://datapi.jup.ag",
      relayer: null,
      profile: null,
      rewards: null,
      auth: {
        supabaseUrl: "https://project.supabase.co",
        issuer: "https://project.supabase.co/auth/v1",
        jwksUrl: "https://project.supabase.co/auth/v1/.well-known/jwks.json",
        publishableKey: "sb_publishable_example",
        jwtSecret: null,
        sessionMaxAgeMs: 24 * 3_600_000,
      },
      allowedOrigins: ["https://app.example.com"],
      trustedProxyHops: 0,
      edgeSecret: null,
      rpcProviderRps: 8,
      jupiterProviderRps: 5,
      sessionStarts: { perIpPerHour: 10, perHour: 600 },
      analytics: null,
    });
  });

  describe("on Railway", () => {
    const { SOLANA_NETWORK: _unset, ...withoutNetwork } = base;
    const railway = {
      ...withoutNetwork,
      RAILWAY_ENVIRONMENT_NAME: "production",
      PORT: "8080",
      SOLANA_RPC_URL: "https://rpc.example.com/?api-key=k",
    };

    it("needs only the secrets and addresses: every tuning value has a default", () => {
      expect(loadConfig(railway)).toEqual({
        ...loadConfig(base),
        port: 8080,
        network: "mainnet",
        rpcUrl: "https://rpc.example.com/?api-key=k",
        trustedProxyHops: 1,
      });
    });

    it("still refuses mainnet without a dedicated RPC provider", () => {
      expect(problems({ ...railway, SOLANA_RPC_URL: undefined })).toMatch(
        /SOLANA_RPC_URL is required on mainnet/,
      );
    });

    it("lets a set value win over its default", () => {
      const config = loadConfig({
        ...railway,
        SOLANA_NETWORK: "devnet",
        SOLANA_RPC_URL: undefined,
        TRUSTED_PROXY_HOPS: "0",
      });
      expect(config.network).toBe("devnet");
      expect(config.trustedProxyHops).toBe(0);
      expect(problems({ ...railway, SOLANA_NETWORK: "testnet" })).toMatch(/SOLANA_NETWORK/);
    });

    it("is not assumed from a blank environment name", () => {
      expect(problems({ ...railway, RAILWAY_ENVIRONMENT_NAME: " " })).toMatch(
        /SOLANA_NETWORK must be/,
      );
    });
  });

  it("names every problem at once, and never a value", () => {
    const message = problems({ SUPABASE_JWT_SECRET: "short-secret" });
    expect(message).toMatch(/SOLANA_NETWORK must be/);
    expect(message).toMatch(/ALLOWED_ORIGINS is required/);
    expect(message).toMatch(/SUPABASE_URL is required/);
    expect(message).toMatch(/SUPABASE_PUBLISHABLE_KEY is required/);
    expect(message).toMatch(/SUPABASE_JWT_SECRET must be at least 32/);
    expect(message).not.toContain("short-secret");
  });

  it("does not guess the network off Railway", () => {
    expect(problems({ ...base, SOLANA_NETWORK: undefined })).toMatch(/SOLANA_NETWORK/);
    expect(problems({ ...base, SOLANA_NETWORK: "mainnet-beta" })).toMatch(/SOLANA_NETWORK/);
    expect(problems({ ...base, SOLANA_NETWORK: "testnet" })).toMatch(/SOLANA_NETWORK/);
  });

  it("refuses mainnet without a dedicated RPC provider", () => {
    expect(problems({ ...base, SOLANA_NETWORK: "mainnet" })).toMatch(
      /SOLANA_RPC_URL is required on mainnet/,
    );
    const config = loadConfig({
      ...base,
      SOLANA_NETWORK: "mainnet",
      SOLANA_RPC_URL: "https://rpc.example.com/?api-key=k",
    });
    expect(config.rpcUrl).toBe("https://rpc.example.com/?api-key=k");
  });

  it("refuses an RPC URL that names the other network", () => {
    expect(
      problems({
        ...base,
        SOLANA_NETWORK: "mainnet",
        SOLANA_RPC_URL: "https://api.devnet.solana.com",
      }),
    ).toMatch(/names a different network than "mainnet"/);
    expect(
      problems({ ...base, SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=k" }),
    ).toMatch(/names a different network than "devnet"/);
  });

  it("refuses a URL that is not one", () => {
    for (const name of [
      "SOLANA_RPC_URL",
      "JUPITER_API_URL",
      "MAGICBLOCK_API_URL",
      "SUPABASE_URL",
    ]) {
      expect(problems({ ...base, [name]: "ftp://example.com" })).toMatch(
        new RegExp(`${name} must be an http\\(s\\) URL`),
      );
      expect(problems({ ...base, [name]: "not a url" })).toMatch(new RegExp(name));
    }
  });

  it("reads the token keys over https only, except from this machine", () => {
    expect(problems({ ...base, SUPABASE_URL: "http://project.supabase.co" })).toMatch(
      /SUPABASE_URL must use https/,
    );
    expect(loadConfig({ ...base, SUPABASE_URL: "http://127.0.0.1:54421/" }).auth.issuer).toBe(
      "http://127.0.0.1:54421/auth/v1",
    );
    expect(loadConfig({ ...base, SUPABASE_URL: "http://localhost:54421" }).auth.jwksUrl).toBe(
      "http://localhost:54421/auth/v1/.well-known/jwks.json",
    );
  });

  it("takes exact origins only", () => {
    expect(
      loadConfig({ ...base, ALLOWED_ORIGINS: "https://app.example.com, http://localhost:3999" })
        .allowedOrigins,
    ).toEqual(["https://app.example.com", "http://localhost:3999"]);
    for (const origin of [
      "*",
      "app.example.com",
      "https://app.example.com/",
      "https://*.example.com",
    ]) {
      expect(problems({ ...base, ALLOWED_ORIGINS: origin })).toMatch(/exact origins/);
    }
    expect(problems({ ...base, ALLOWED_ORIGINS: " , " })).toMatch(/ALLOWED_ORIGINS is required/);
  });

  it("trusts no proxy unless told to, and at most the platform's edge", () => {
    expect(loadConfig({ ...base, TRUSTED_PROXY_HOPS: "1" }).trustedProxyHops).toBe(1);
    expect(problems({ ...base, TRUSTED_PROXY_HOPS: "2" })).toMatch(/TRUSTED_PROXY_HOPS/);
    expect(problems({ ...base, TRUSTED_PROXY_HOPS: "true" })).toMatch(/TRUSTED_PROXY_HOPS/);
  });

  it("takes the provider rates and the session budgets as whole numbers in range", () => {
    const config = loadConfig({
      ...base,
      RPC_PROVIDER_RPS: "40",
      JUPITER_PROVIDER_RPS: "9",
      SESSION_STARTS_PER_IP_PER_HOUR: "3",
      SESSION_STARTS_PER_HOUR: "100",
    });
    expect(config.rpcProviderRps).toBe(40);
    expect(config.jupiterProviderRps).toBe(9);
    expect(config.sessionStarts).toEqual({ perIpPerHour: 3, perHour: 100 });
    for (const name of [
      "RPC_PROVIDER_RPS",
      "JUPITER_PROVIDER_RPS",
      "SESSION_STARTS_PER_IP_PER_HOUR",
      "SESSION_STARTS_PER_HOUR",
    ]) {
      for (const value of ["0", "-1", "1.5", "many", "99999999999"]) {
        expect(problems({ ...base, [name]: value }), `${name}=${value}`).toMatch(
          new RegExp(`${name} must be a whole number`),
        );
      }
    }
  });

  it("takes an edge secret only when it is long enough to be one", () => {
    const secret = "an-edge-secret-of-at-least-32-characters";
    expect(loadConfig({ ...base, EDGE_SHARED_SECRET: secret }).edgeSecret).toBe(secret);
    const message = problems({ ...base, EDGE_SHARED_SECRET: "short" });
    expect(message).toMatch(/EDGE_SHARED_SECRET must be at least 32/);
    expect(message).not.toContain("short\n");
  });

  it("bounds how long a session may live", () => {
    expect(loadConfig({ ...base, SESSION_MAX_AGE_HOURS: "6" }).auth.sessionMaxAgeMs).toBe(
      6 * 3_600_000,
    );
    for (const hours of ["0", "-1", "abc", "9999"]) {
      expect(problems({ ...base, SESSION_MAX_AGE_HOURS: hours })).toMatch(/SESSION_MAX_AGE_HOURS/);
    }
  });

  it("refuses a port that is not one", () => {
    expect(loadConfig({ ...base, PORT: "8080" }).port).toBe(8080);
    expect(problems({ ...base, PORT: "0" })).toMatch(/PORT/);
    expect(problems({ ...base, PORT: "http" })).toMatch(/PORT/);
  });

  describe("the relayer", () => {
    it("is pinned from the configuration, one fee payer per replica", () => {
      const second = address();
      const config = loadConfig({
        ...base,
        ...kora,
        KORA_URLS: "http://kora.railway.internal:8080/, http://kora-2.railway.internal:8080",
        KORA_FEE_PAYERS: `${feePayer}, ${second}`,
      });
      expect(config.relayer).toEqual({
        replicas: [
          { url: "http://kora.railway.internal:8080", feePayer },
          { url: "http://kora-2.railway.internal:8080", feePayer: second },
        ],
        apiKey: "the-api-key",
        hmacSecret: "the-hmac-secret",
        feePayers: [feePayer, second],
        paymentWallet,
        accountCreation: true,
      });
    });

    it("refuses half a configuration outright, whichever half is missing", () => {
      for (const name of [
        "KORA_API_KEY",
        "KORA_HMAC_SECRET",
        "KORA_FEE_PAYERS",
        "KORA_PAYMENT_WALLET",
      ]) {
        expect(problems({ ...base, ...kora, [name]: "" })).toMatch(/must all be set/);
      }
      const { KORA_URLS: _unset, ...withoutUrls } = kora;
      expect(problems({ ...base, ...withoutUrls })).toMatch(/no other KORA_ variable may be set/);
    });

    it("refuses fee payers that do not match the replicas one to one", () => {
      expect(problems({ ...base, ...kora, KORA_FEE_PAYERS: `${feePayer},${address()}` })).toMatch(
        /one fee payer for each/,
      );
      expect(
        problems({
          ...base,
          ...kora,
          KORA_URLS: "http://a.internal:8080,http://b.internal:8080",
          KORA_FEE_PAYERS: `${feePayer},${feePayer}`,
        }),
      ).toMatch(/one fee payer for each/);
    });

    it("refuses pins that are not Solana addresses", () => {
      expect(problems({ ...base, ...kora, KORA_PAYMENT_WALLET: "0xabc" })).toMatch(
        /must be Solana addresses/,
      );
      expect(problems({ ...base, ...kora, KORA_FEE_PAYERS: "not-a-key" })).toMatch(
        /must be Solana addresses/,
      );
    });

    it("opens token accounts unless switched off, and takes no third answer", () => {
      expect(loadConfig({ ...base, ...kora, KORA_ACCOUNT_CREATION: "off" }).relayer).toMatchObject({
        accountCreation: false,
      });
      expect(problems({ ...base, ...kora, KORA_ACCOUNT_CREATION: "no" })).toMatch(
        /KORA_ACCOUNT_CREATION must be "on" or "off"/,
      );
    });

    it("refuses a replica URL that is not one", () => {
      expect(problems({ ...base, ...kora, KORA_URLS: "kora.internal" })).toMatch(/KORA_URLS/);
    });
  });

  describe("analytics", () => {
    const umami = {
      UMAMI_URL: "https://stats.example.com/",
      UMAMI_WEBSITE_ID: "site-id",
      UMAMI_HOSTNAME: "app.example.com",
    };

    it("is off unless its three values are set, and all three or none", () => {
      expect(loadConfig({ ...base, ...umami, ANALYTICS_SALT: "salt" }).analytics).toEqual({
        url: "https://stats.example.com",
        website: "site-id",
        hostname: "app.example.com",
        salt: "salt",
      });
      expect(loadConfig({ ...base, ...umami }).analytics?.salt).toBeNull();
      for (const name of Object.keys(umami)) {
        expect(problems({ ...base, ...umami, [name]: "" })).toMatch(/together, or none/);
      }
    });

    it("refuses a host name that is not one", () => {
      expect(problems({ ...base, ...umami, UMAMI_HOSTNAME: "https://app.example.com" })).toMatch(
        /UMAMI_HOSTNAME/,
      );
    });
  });

  describe("profiles", () => {
    const gate = Keypair.generate();
    const secret = JSON.stringify([...gate.secretKey]);
    const profile = {
      PROFILE_ROLLUP_URL: "https://rollup.example.com/",
      PROFILE_PROGRAM_ID: address(),
      PROFILE_GATE_SECRET_KEY: secret,
    };

    it("are kept with the rollup, the program and the gate key set, at the default limits", () => {
      expect(loadConfig({ ...base, ...profile }).profile).toEqual({
        rollupUrl: "https://rollup.example.com",
        programId: profile.PROFILE_PROGRAM_ID,
        gate: gate.publicKey.toBase58(),
        gateSecretKey: gate.secretKey,
        maxDataLen: 2048,
        dailyCreateCap: 500,
      });
    });

    it("are off, and the start is not refused, with any one of the three unset", () => {
      for (const name of Object.keys(profile)) {
        expect(loadConfig({ ...base, ...profile, [name]: " " }).profile, name).toBeNull();
      }
      // The two limits alone switch nothing on.
      const limits = { PROFILE_MAX_DATA_LEN: "1024", PROFILE_DAILY_CREATE_CAP: "10" };
      expect(loadConfig({ ...base, ...limits }).profile).toBeNull();
    });

    it("refuse a gate key that is not one key's 64 bytes, without repeating it", () => {
      const other = Keypair.generate();
      const mismatched = [...gate.secretKey.subarray(0, 32), ...other.secretKey.subarray(32)];
      for (const value of [
        "not json",
        JSON.stringify([...gate.secretKey.subarray(0, 32)]),
        JSON.stringify(mismatched),
        JSON.stringify([...gate.secretKey].map(String)),
        `"${gate.publicKey.toBase58()}"`,
      ]) {
        const refused = problems({ ...base, ...profile, PROFILE_GATE_SECRET_KEY: value });
        expect(refused, value).toMatch(/PROFILE_GATE_SECRET_KEY/);
        expect(refused).not.toContain(value);
      }
    });

    it("refuse a rollup that is not an https URL free of a query, and a program that is not an address", () => {
      for (const value of [
        "rollup.example.com",
        "http://rollup.example.com",
        "https://rollup.example.com/?token=abc",
      ]) {
        expect(problems({ ...base, ...profile, PROFILE_ROLLUP_URL: value }), value).toMatch(
          /PROFILE_ROLLUP_URL/,
        );
      }
      const local = { ...base, ...profile, PROFILE_ROLLUP_URL: "http://127.0.0.1:6699" };
      expect(loadConfig(local).profile?.rollupUrl).toBe("http://127.0.0.1:6699");
      expect(problems({ ...base, ...profile, PROFILE_PROGRAM_ID: "not-an-address" })).toMatch(
        /PROFILE_PROGRAM_ID/,
      );
    });

    it("take a record limit no higher than the program's own maximum, and a daily cap of at least one", () => {
      const limited = { PROFILE_MAX_DATA_LEN: "4096", PROFILE_DAILY_CREATE_CAP: "25" };
      expect(loadConfig({ ...base, ...profile, ...limited }).profile).toMatchObject({
        maxDataLen: 4096,
        dailyCreateCap: 25,
      });
      expect(problems({ ...base, ...profile, PROFILE_MAX_DATA_LEN: "4097" })).toMatch(
        /PROFILE_MAX_DATA_LEN/,
      );
      expect(problems({ ...base, ...profile, PROFILE_DAILY_CREATE_CAP: "0" })).toMatch(
        /PROFILE_DAILY_CREATE_CAP/,
      );
    });
  });

  describe("rewards", () => {
    const rewards = {
      REWARDS_DATABASE_SECRET_KEY: "the-database-secret-key",
      REWARDS_FINGERPRINT_SECRET: "a-fingerprint-secret-of-32-chars!",
      REWARDS_SEASON_START: "2026-10-19T00:00:00Z",
      REWARDS_REFERRAL_ACCOUNT: address(),
    };

    it("are on with the database key, the fingerprint secret, the season start and the referral account set", () => {
      expect(loadConfig({ ...base, ...rewards }).rewards).toEqual({
        databaseSecretKey: rewards.REWARDS_DATABASE_SECRET_KEY,
        fingerprintSecret: rewards.REWARDS_FINGERPRINT_SECRET,
        seasonStartMs: Date.UTC(2026, 9, 19),
        referralAccount: rewards.REWARDS_REFERRAL_ACCOUNT,
        dailyJoinCap: 2_000,
      });
    });

    it("take a cap on new members a day of at least one, which alone switches nothing on", () => {
      const capped = { ...base, ...rewards, REWARDS_DAILY_JOIN_CAP: "50" };
      expect(loadConfig(capped).rewards?.dailyJoinCap).toBe(50);
      for (const value of ["0", "-1", "many", "1.5"]) {
        expect(problems({ ...capped, REWARDS_DAILY_JOIN_CAP: value }), value).toMatch(
          /REWARDS_DAILY_JOIN_CAP/,
        );
      }
      expect(loadConfig({ ...base, REWARDS_DAILY_JOIN_CAP: "50" }).rewards).toBeNull();
    });

    it("are off, and the start is not refused, with any one of the four unset", () => {
      for (const name of Object.keys(rewards)) {
        expect(loadConfig({ ...base, ...rewards, [name]: " " }).rewards, name).toBeNull();
      }
    });

    it("refuse a fingerprint secret under 32 characters, without repeating it", () => {
      const short = "only-thirty-one-characters-long";
      const refused = problems({ ...base, ...rewards, REWARDS_FINGERPRINT_SECRET: short });
      expect(refused).toMatch(/REWARDS_FINGERPRINT_SECRET/);
      expect(refused).not.toContain(short);
    });

    it("take a season start written as a date alone, and refuse one that is not a Monday at 00:00 UTC", () => {
      const start = (value: string) => ({ ...base, ...rewards, REWARDS_SEASON_START: value });
      expect(loadConfig(start("2026-10-19")).rewards?.seasonStartMs).toBe(Date.UTC(2026, 9, 19));
      for (const value of [
        "2026-10-20",
        "2026-10-19T00:00:01Z",
        "2026-10-19T02:00:00+02:00",
        "2026-10-19 00:00",
        "1792368000",
        "next monday",
      ]) {
        expect(problems(start(value)), value).toMatch(/REWARDS_SEASON_START/);
      }
    });

    it("refuse a referral account that is not an address", () => {
      expect(problems({ ...base, ...rewards, REWARDS_REFERRAL_ACCOUNT: "not-an-address" })).toMatch(
        /REWARDS_REFERRAL_ACCOUNT/,
      );
    });
  });
});

import { defineRailway, github, preserve, project, service } from "railway/iac";

// The API as a Railway service, as code. Apply with `railway config apply` from the
// repository root (see ../docs/deploy.md). Secrets and addresses are never written here:
// they are set once with `railway variable set`, and `preserve()` tells Railway to keep them.

// This repository manages one slice of the Railway project it shares with the relayer.
// Every file that targets the same environment must export a partial name of its own.
export const partial = "api";

// The Railway project the relayer's services already live in.
const PROJECT = "noirwire-relayer";

// Set API_GITHUB_REPO=owner/repo to have Railway build from GitHub on every push.
// Leave it unset to deploy from this machine with `railway up`.
const repo = process.env.API_GITHUB_REPO;
const source = repo ? github(repo, { branch: process.env.API_GITHUB_BRANCH ?? "main" }) : undefined;

export default defineRailway(() => {
  const api = service("api", {
    source,
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      healthcheckPath: "/health",
      healthcheckTimeout: 60,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    // ONE replica, on purpose. Every rate limit and the relayer's signature budgets are
    // counted in the memory of one process: a second replica would count separately and
    // double every limit. Raise this only once the counters live in a shared store.
    replicas: 1,
    env: {
      PORT: "4000",
      NODE_ENV: "production",
      SOLANA_NETWORK: "mainnet",
      // Railway's edge is the one proxy in front of this service. With this set, the
      // client address is read from the X-Real-IP header the edge adds.
      TRUSTED_PROXY_HOPS: "1",
      SESSION_MAX_AGE_HOURS: "24",
      // The relayer is reached over Railway's private network, by its service name. It
      // has no public domain: this service is the only thing that can call it.
      // One URL per relayer replica, in the order of KORA_FEE_PAYERS.
      KORA_URLS: "http://kora.railway.internal:8080",
      KORA_ACCOUNT_CREATION: "on",
      SOLANA_RPC_URL: preserve(),
      JUPITER_API_KEY: preserve(),
      KORA_API_KEY: preserve(),
      KORA_HMAC_SECRET: preserve(),
      KORA_FEE_PAYERS: preserve(),
      KORA_PAYMENT_WALLET: preserve(),
      SUPABASE_URL: preserve(),
      SUPABASE_PUBLISHABLE_KEY: preserve(),
      ALLOWED_ORIGINS: preserve(),
      UMAMI_URL: preserve(),
      UMAMI_WEBSITE_ID: preserve(),
      UMAMI_HOSTNAME: preserve(),
      ANALYTICS_SALT: preserve(),
    },
  });
  return project(PROJECT, { resources: [api] });
});

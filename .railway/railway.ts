import { execSync } from "node:child_process";
import { defineRailway, github, preserve, project, service } from "railway/iac";

// The API as a Railway service. Apply with `railway config apply` (see ../docs/deploy.md).

// This repository manages one slice of the Railway project it shares with the relayer.
export const partial = "api";

// Railway builds from this checkout's GitHub repository on every push to main.
const origin = execSync("git remote get-url origin", { encoding: "utf8" });
const repo = /github\.com[:/](.+?)(?:\.git)?\s*$/.exec(origin)?.[1];
if (!repo) throw new Error("The origin remote is not a GitHub repository.");

// Set by hand once, in the service's raw variable editor. Railway keeps them.
const SET_BY_HAND = [
  "SOLANA_RPC_URL",
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "ALLOWED_ORIGINS",
  "EDGE_SHARED_SECRET",
  "KORA_PAYMENT_WALLET",
];

export default defineRailway(() => {
  const api = service("api", {
    source: github(repo),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    deploy: {
      healthcheckPath: "/health",
      healthcheckTimeout: 60,
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
    },
    // ONE replica, on purpose: every rate limit is counted in the memory of one process,
    // so a second replica would double them all.
    replicas: 1,
    // Every variable the service has is named here. Anything else has a default in
    // src/config/core/config.ts; to set an optional one, add it as preserve().
    env: {
      // The relayer's own values, read from its services in this project. It has no
      // public domain: this service reaches it over the private network.
      KORA_URLS: "http://${{kora.RAILWAY_PRIVATE_DOMAIN}}:${{kora.PORT}}",
      KORA_API_KEY: "${{kora.KORA_API_KEY}}",
      KORA_HMAC_SECRET: "${{kora.KORA_HMAC_SECRET}}",
      KORA_FEE_PAYERS: "${{refill.FEE_PAYER}}",
      JUPITER_API_KEY: "${{kora.JUPITER_API_KEY}}",
      ...Object.fromEntries(SET_BY_HAND.map((name) => [name, preserve()])),
    },
  });
  return project("noirwire-relayer", { resources: [api] });
});

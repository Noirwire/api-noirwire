# Deploying on Railway

One Railway service, `api`, in the relayer's Railway project. Everything except six values is code: `.railway/railway.ts` (builder, health check, restart policy, one replica, the relayer's values by reference) and the defaults in `src/config/core/config.ts`.

## Before you start

1. Railway CLI 5.42.1 or newer, logged in, with Railway's GitHub app allowed to read this repository.
2. The relayer deployed in the same project as the services `kora` and `refill`, from a `.railway/railway.ts` that exports a `partial` name.
3. A Supabase project with anonymous sign-ins turned on, and its anonymous sign-in rate limit raised to at least 600 an hour.

## Steps

1. `railway link` (choose the relayer's project), then `railway add --service api`.
2. In the dashboard, open `api`, Variables, Raw Editor, and paste the block below with your values.
3. `(cd .railway && npm ci) && railway config apply`. Railway builds from GitHub now and on every push to `main`.
4. `railway domain --service api`, then point the web app and the mobile app at that domain.

```
SOLANA_RPC_URL=https://<mainnet RPC provider, key included>
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable key>
ALLOWED_ORIGINS=https://app.noirwire.com
EDGE_SHARED_SECRET=<openssl rand -hex 32, the same value the web app's server holds>
KORA_PAYMENT_WALLET=<the payment wallet's public key, as in the relayer's kora.toml>
```

## Check it

```bash
curl -s https://<domain>/health                                        # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<domain>/v1/session   # 200
```

## Do not change

Keep it at one replica: every rate limit is counted in the memory of one process, so a second replica would double them all.

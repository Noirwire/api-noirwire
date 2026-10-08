# Deploying on Railway

One Railway service, `api`, in the relayer's Railway project. Everything except six values (and the profile and rewards values, when those are on) is code: `.railway/railway.ts` (builder, health check, restart policy, one replica, the relayer's values by reference) and the defaults in `src/config/core/config.ts`.

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

## Profiles (optional)

Profiles are off until the first three of these are set in the same Raw Editor; with any of them missing `GET /v1/profile/config` answers `enabled: false` and the wallets work as they do without profiles. The last two have defaults.

```
PROFILE_ROLLUP_URL=https://<the private rollup the profile program runs on>
PROFILE_PROGRAM_ID=<the profile program's address>
PROFILE_GATE_SECRET_KEY=<the gate's secret key: the JSON array of 64 bytes in its keypair file, on one line>
PROFILE_MAX_DATA_LEN=<the record limit the program's sponsor is set to; 2048 when unset>
PROFILE_DAILY_CREATE_CAP=<the most profile creations signed in 24 hours; 500 when unset>
```

The gate's public key must be the one the program's sponsor names as its gate. Keep the secret in Railway only, and seal the variable. The key holds no SOL and needs none; what it guards is the sponsor's rent, so `PROFILE_DAILY_CREATE_CAP` bounds what a day can cost.

## Rewards (optional)

Rewards are off until the first four of these are set in the same Raw Editor (the fifth has a default and the sixth is optional); with any of them missing `GET /v1/rewards/config` answers `enabled: false` and the wallets show nothing of rewards.

```
REWARDS_DATABASE_SECRET_KEY=<the secret key of the Supabase project at SUPABASE_URL>
REWARDS_FINGERPRINT_SECRET=<openssl rand -hex 32>
REWARDS_SEASON_START=<the season's first day: a Monday, 00:00 UTC, such as 2026-10-19>
REWARDS_REFERRAL_ACCOUNT=<NoirWire's Jupiter referral account>
REWARDS_DAILY_JOIN_CAP=<the most new members on one UTC day; 2000 when unset>
REWARDS_DOUBLE_HOUR_START=<optional: when the double hour begins, with its offset, such as 2026-11-07T18:00:00Z>
```

Before setting them, apply `supabase/migrations` to that project (`npx supabase link`, then `npx supabase db push`): it creates the rewards tables and the SQL functions this server calls. The tables have row level security on and no policy, so only the secret key reaches them. Keep both secrets in Railway only, and seal the variables.

Set `REWARDS_FINGERPRINT_SECRET` and `REWARDS_SEASON_START` once. A new fingerprint secret lets every trade already claimed be claimed again, and a new season start moves the weeks under fees already credited.

**The double hour.** `REWARDS_DOUBLE_HOUR_START` names one hour in which a trade's fee counts twice toward the week's score. Announce it before it happens, and set the variable and let the deploy finish before the hour starts: the multiplier is applied when a trade is claimed, from the trade's own block time and the value set at that moment, so a trade of the hour claimed while the variable is still unset counts once and stays so. Changing or removing the variable later rewrites nothing that was credited. `GET /v1/rewards/config` shows the hour the server has, which is the way to check it before announcing.

## Check it

```bash
curl -s https://<domain>/health                                        # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<domain>/v1/session   # 200
```

## Do not change

Keep it at one replica: every rate limit is counted in the memory of one process, so a second replica would double them all.

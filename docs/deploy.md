# Deploying on Railway

The API is one Railway service, built from the `Dockerfile`, in the same Railway project as the relayer (`relayer-noirwire`). The relayer's Kora service has no public domain: this service reaches it over the project's private network and is the only thing that can.

```
 internet ──> Railway edge ──> api (public domain, port 4000)
                                 │  private network (kora.railway.internal:8080)
                                 └────────> kora   (no public domain)
                                            refill (cron, no domain)
```

**Status of these commands.** The Docker commands and the local run were executed. **Every `railway` command below is NOT VERIFIED**: none was run against Railway. They follow Railway's documentation as read on 2026-10-04 (`infrastructure-as-code`, `infrastructure-as-code/reference`, `networking/private-networking`, `networking/public-networking/specs-and-limits`) and the relayer's own `deploy.md`. `.railway/railway.ts` was type-checked against the `railway` SDK 3.12.0.

**Why there is no `railway.json`.** Railway's per-service config files are deprecated; new services cannot use them. The replacement is `.railway/railway.ts`, applied with `railway config apply`. It holds every setting that is not a secret.

## 0. One replica

The service runs as **one replica**, and `.railway/railway.ts` says so. Every rate limit and the relayer's signature budgets are counted in the memory of one process; a second replica would count separately and double every limit. Do not raise it until the counters live in a shared store behind `QuotaStore` (`src/common/core/quota.ts`).

## 1. The identity provider (Supabase)

A Supabase project that does one thing: issue anonymous sessions. No tables, no storage.

1. Authentication, Sign In / Providers: turn **Allow anonymous sign-ins** on. Turn email and phone sign-ups off.
2. Authentication, Rate Limits: raise **anonymous sign-ins** and **token refreshes**. Supabase counts these per IP address, and the only address it ever sees is this API's, so its defaults (30 anonymous sign-ins an hour) would cap every wallet together. Set them at or above this API's own totals, which are what ration callers: `SESSION_STARTS_PER_HOUR` anonymous sign-ins an hour (600 by default), and 6,000 token refreshes per five minutes.
3. Leave the access token lifetime at one hour. This API refuses a session as a whole once it is older than `SESSION_MAX_AGE_HOURS`.
4. Use the project's asymmetric signing keys (the default on current projects): the API reads the public keys from `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. Only a project that still signs with a shared secret needs `SUPABASE_JWT_SECRET`.
5. Note the project URL and the **publishable** key. The secret key is never needed and must not be set here.

Anonymous users accumulate in `auth.users`. Supabase documents a SQL statement for deleting old ones; run it on a schedule in the Supabase project. This API never reads that table.

## 2. Create the service

From the repository root, linked to the relayer's Railway project and environment:

```bash
railway login
railway link                      # choose the relayer's project and environment
railway add --service api
```

## 3. Set the variables

Secrets are piped in, never typed into a file. `--skip-deploys` holds the deploy until everything is set.

```bash
printf '%s' '<YOUR_MAINNET_RPC>'            | railway variable set SOLANA_RPC_URL           --stdin --service api --skip-deploys
printf '%s' '<your Jupiter API key>'        | railway variable set JUPITER_API_KEY          --stdin --service api --skip-deploys
printf '%s' '<the relayer KORA_API_KEY>'    | railway variable set KORA_API_KEY             --stdin --service api --skip-deploys
printf '%s' '<the relayer KORA_HMAC_SECRET>'| railway variable set KORA_HMAC_SECRET         --stdin --service api --skip-deploys
printf '%s' '<openssl rand -hex 32>'        | railway variable set ANALYTICS_SALT           --stdin --service api --skip-deploys
railway variable set KORA_FEE_PAYERS=<FEE_PAYER>                      --service api --skip-deploys
railway variable set KORA_PAYMENT_WALLET=<PAYMENT_WALLET>             --service api --skip-deploys
railway variable set SUPABASE_URL=https://<project>.supabase.co       --service api --skip-deploys
railway variable set SUPABASE_PUBLISHABLE_KEY=<publishable key>       --service api --skip-deploys
railway variable set ALLOWED_ORIGINS=https://app.noirwire.com         --service api --skip-deploys
railway variable set UMAMI_URL=https://<your umami host>              --service api --skip-deploys
railway variable set UMAMI_WEBSITE_ID=<site id>                       --service api --skip-deploys
railway variable set UMAMI_HOSTNAME=app.noirwire.com                  --service api --skip-deploys
```

| Variable                                          | Value                                                                                   | Set by                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------- |
| `SOLANA_NETWORK`                                  | `mainnet`                                                                               | `.railway/railway.ts` |
| `PORT`                                            | `4000`                                                                                  | `.railway/railway.ts` |
| `TRUSTED_PROXY_HOPS`                              | `1`: Railway's edge is the one proxy in front                                           | `.railway/railway.ts` |
| `SESSION_MAX_AGE_HOURS`                           | `24`                                                                                    | `.railway/railway.ts` |
| `KORA_URLS`                                       | `http://kora.railway.internal:8080`, one per replica, comma separated                   | `.railway/railway.ts` |
| `KORA_ACCOUNT_CREATION`                           | `on`                                                                                    | `.railway/railway.ts` |
| `SOLANA_RPC_URL`                                  | The dedicated mainnet RPC, key included. Secret.                                        | You                   |
| `JUPITER_API_KEY`                                 | Secret.                                                                                 | You                   |
| `KORA_API_KEY`, `KORA_HMAC_SECRET`                | The same values the `kora` service holds. Secret.                                       | You                   |
| `KORA_FEE_PAYERS`                                 | The fee payer public key of each replica, in the order of `KORA_URLS`                   | You                   |
| `KORA_PAYMENT_WALLET`                             | The payment wallet's public key                                                         | You                   |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`        | From step 1                                                                             | You                   |
| `SUPABASE_JWT_SECRET`                             | Optional. Only for a project that signs with a shared secret. Secret.                   | You, if needed        |
| `ALLOWED_ORIGINS`                                 | The web app's origin, exactly. Comma separated for more.                                | You                   |
| `UMAMI_URL`, `UMAMI_WEBSITE_ID`, `UMAMI_HOSTNAME` | The analytics server, the site id, the host name events are counted under. All or none. | You                   |
| `ANALYTICS_SALT`                                  | A random secret that keys the visitor code. Secret.                                     | You                   |

Seal the secrets in the dashboard (variable menu, "Seal") once they are set.

To run without analytics, remove the four analytics lines from `.railway/railway.ts` before applying, and set none of them: the service refuses to start with only some of the three `UMAMI_` values.

## 4. Apply the settings

```bash
(cd .railway && npm install)      # the SDK that railway.ts imports
railway config plan               # shows what would change; changes nothing
railway config apply              # asks for confirmation
```

The plan should show one service, `api`, being updated: Dockerfile builder, health check `/health`, restart on failure, one replica, and the variables above. It must not show any change to `kora` or `refill`.

**Partials.** This repository and the relayer's manage slices of one Railway project from two files, so each file exports a partial name: this one is `api`. Railway requires every file that targets the environment to export one. The relayer's `.railway/railway.ts` has none today; give it `export const partial = "relayer";` and apply it first, or the plan here is refused. If the relayer's project is not named `noirwire-relayer`, change `PROJECT` in `.railway/railway.ts`.

## 5. Deploy

From this machine:

```bash
railway up --service api
```

Or from GitHub on every push: set the repository once and apply again.

```bash
API_GITHUB_REPO=Noirwire/api-noirwire railway config apply
```

Keep `API_GITHUB_REPO` set on every later apply, or the plan will want to remove the source. With deploys wired to GitHub, turn on **Wait for CI** on the service (Settings, Source), so a deploy starts only once `.github/workflows/ci.yml` has passed on that commit.

## 6. Give the API a public domain

```bash
railway domain --service api --port 4000
```

Then point the web app's rewrite and the mobile app at it.

## 7. Take the relayer off the internet

Kora was public while the web app's server called it from outside Railway. Now only this service calls it:

1. Check that `KORA_URLS` reaches it: `railway logs --service api` shows no `replica_passed_over` lines, and `GET /v1/relayer` then `POST /v1/relayer` `getPayerSigner` answer `200` (see step 8).
2. Remove Kora's public domain (dashboard: `kora`, Settings, Networking, delete the domain).

Two things to know about the private network. Its names resolve only inside the same project **and environment**. And in a Railway environment created before 2025-10-16 they resolve to IPv6 only, so Kora has to listen on `::` there; in newer environments IPv4 works too.

The API key and the HMAC secret still gate Kora. Removing the domain means they are no longer the only gate.

## 8. Check it

```bash
API=https://<your-domain>

curl -s $API/health                                         # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/prices     # 401

TOKEN=$(curl -s -X POST $API/v1/session | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
curl -s -H "authorization: Bearer $TOKEN" $API/v1/relayer   # {"available":true,"feePayers":[...],...}
curl -s -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"method":"getPayerSigner"}' $API/v1/relayer          # {"result":{"signer_address":...}}
curl -s -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' $API/v1/rpc
# mainnet: 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
```

Or the whole chain at once, from a checkout: `API_URL=$API node scripts/e2e-local.mjs`.

Then read the log: `railway logs --service api`. Each request is one JSON line with a route pattern, a status and a duration. A line with `"event":"operator_error"` means a provider refused this server's own credentials (a wrong `KORA_API_KEY`, `JUPITER_API_KEY`, RPC key or `SUPABASE_PUBLISHABLE_KEY`): fix the variable.

## The client address

Per-address limits are only as good as the address. The API never takes it from anything a caller can write.

- **Railway's edge.** `TRUSTED_PROXY_HOPS=1` tells the API that one proxy is in front and to read the `X-Real-IP` header it sets. Railway's reference (`networking/public-networking/specs-and-limits`, read 2026-10-04) lists `X-Real-IP` as the request header "for identifying client's remote IP" and says nothing more. That the edge replaces a value a client sends is stated in Railway's help forum, not in that reference, and was **not verified** here. When the header is missing or is not an address, the API falls back to the socket's address, never to another header. `X-Forwarded-For` is not read at all.
- **Check it once after the first deploy.** From one machine, send `POST /v1/session` 11 times within a minute, each with a different made-up `X-Real-IP` header. If the 11th is refused with `429`, the edge overwrote the header and the limit held. If all 11 succeed, the header can be forged: set `TRUSTED_PROXY_HOPS=0`, which counts every request under the edge's own address, until the API sits behind something that sets it.
- **The web app's server.** The web app's pages call their own origin and its server forwards to this API, so those requests arrive from that server's addresses. Without more, every web user would share its allowance: ten session starts an hour between them. So the web app's edge code sends two headers, and this is an operator mechanism, not for third parties: `X-NoirWire-Edge: <EDGE_SHARED_SECRET>` and `X-NoirWire-Client-IP: <the browser's address as the web host reports it>`. When the secret matches (compared in constant time), the API counts the request under the reported address. Without the matching secret both headers are ignored. Generate the secret with `openssl rand -hex 32`, set it on both sides, and never send it to a browser: it must be added by server code, and a client-supplied `X-NoirWire-Client-IP` must be overwritten there. Whoever holds the secret can choose the address they are counted under, so rotate it if it leaks.
- The mobile app calls the API directly and is counted by its own address.

## Sessions are rationed, and what is not built

Starting a session is limited to `SESSION_STARTS_PER_IP_PER_HOUR` (10) per client address and `SESSION_STARTS_PER_HOUR` (600) in total. A wallet starts one only when it has none or its last was retired, and refreshes otherwise, so these are sized for new wallets per hour, not for traffic. Raise the total with real usage, and the identity provider's own anonymous sign-in limit with it.

Recorded as follow-up, not built: a **durable budget** (the counters are in memory, so a restart resets them and a second replica would double them) and an **abuse challenge** before a session is issued. Until then, keep the defaults low and watch the count of `POST /v1/session` in the log.

## Changing things later

- A setting in `.railway/railway.ts`: edit, `railway config plan`, `railway config apply`.
- A secret: `railway variable set NAME --stdin --service api`.
- A second relayer replica: add its private URL to `KORA_URLS` in `.railway/railway.ts` and its fee payer to `KORA_FEE_PAYERS`, in the same position. The service refuses to start if the two lists do not match one to one.
- The trackers the wallets list: `src/chain/core/stocks.generated.json` is a copy of the catalog in `@noirwire/shared`. When that catalog changes, raise the `@noirwire/shared` version in `package.json`: the unit suite then fails until the new file is copied over. Until it is deployed, a newly listed tracker has no price, no chart and cannot be sent through the relayer.

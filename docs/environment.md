# Environment

Read once at start-up by `src/config/core/config.ts`. Anything missing or malformed stops the start with every problem named (never a value). `.env.example` carries working defaults for local development.

## Required

| Variable                   | Purpose                                                                                                                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOLANA_NETWORK`           | `mainnet` or `devnet`. There is no default: the network decides the USDC mint the relayer is paid in, and is not guessed.                                                                                                          |
| `SOLANA_RPC_URL`           | The RPC provider, key included. Required on mainnet; on devnet it defaults to the public endpoint. Refused if the URL names the other network.                                                                                     |
| `SUPABASE_URL`             | The Supabase project that issues the sessions. Tokens must be issued by `${SUPABASE_URL}/auth/v1` and are verified with the keys at `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. Must be https, except on this machine.        |
| `SUPABASE_PUBLISHABLE_KEY` | The project's publishable (anon) key. Sent by this server when it starts or renews a session. It is not a secret, but only this server ever uses it.                                                                               |
| `ALLOWED_ORIGINS`          | The exact origins that may call from a browser, comma separated, such as `https://app.noirwire.com`. No wildcards. Include the web app's origin: its pages name it even when their requests are forwarded by the web app's server. |

## Optional

| Variable                         | Default                           | Purpose                                                                                                                                                                                                                                                             |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                           | `4000`                            | The port to listen on.                                                                                                                                                                                                                                              |
| `TRUSTED_PROXY_HOPS`             | `0`                               | `0`: the client address is the socket's. `1`: one proxy is in front (Railway's edge) and the address is read from the `X-Real-IP` header it sets, falling back to the socket's when that is missing. Nothing else is accepted, and `X-Forwarded-For` is never read. |
| `EDGE_SHARED_SECRET`             | unset                             | At least 32 characters. Shared with the web app's own server only. A request that carries it in `X-NoirWire-Edge` is counted under the address in `X-NoirWire-Client-IP`. Unset, both headers are ignored.                                                          |
| `RPC_PROVIDER_RPS`               | `8`                               | The most requests a second this server sends the RPC provider. Set it BELOW what the provider allows the key. The costly calls get half. The per-minute limits follow from it.                                                                                      |
| `JUPITER_PROVIDER_RPS`           | `5`                               | The same for Jupiter, across every Jupiter path and the price index. Set it below your plan's allowance.                                                                                                                                                            |
| `SESSION_STARTS_PER_IP_PER_HOUR` | `10`                              | Sessions one client address may start in an hour.                                                                                                                                                                                                                   |
| `SESSION_STARTS_PER_HOUR`        | `600`                             | Sessions started in an hour in total.                                                                                                                                                                                                                               |
| `SESSION_MAX_AGE_HOURS`          | `24`                              | A session older than this is refused on every route and is not renewed.                                                                                                                                                                                             |
| `SUPABASE_JWT_SECRET`            | unset                             | Only for a project that still signs sessions with one shared secret (HS256). Unset, every HS256 token is refused. At least 32 characters.                                                                                                                           |
| `JUPITER_API_KEY`                | unset                             | Raises Jupiter's keyless rate limit. Sent on every request to Jupiter.                                                                                                                                                                                              |
| `JUPITER_API_URL`                | `https://api.jup.ag`              | Override for the swap, lending and price venue.                                                                                                                                                                                                                     |
| `MAGICBLOCK_API_URL`             | `https://payments.magicblock.app` | Override for the private-payment host. One host serves both networks.                                                                                                                                                                                               |
| `PRICE_HISTORY_API_URL`          | `https://datapi.jup.ag`           | Override for the chart source.                                                                                                                                                                                                                                      |

## The fee relayer

Unset, there is no relayer: `GET /v1/relayer` says so, and a portfolio pays the network only when it holds SOL. Set, all of the first five are required. Half a configuration is refused.

| Variable                           | Purpose                                                                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KORA_URLS`                        | The relayer's replicas, comma separated (`KORA_URL` for one). On Railway these are private addresses, such as `http://kora.railway.internal:8080`. |
| `KORA_API_KEY`, `KORA_HMAC_SECRET` | The relayer's credentials. Every request to it carries the key and a signature made with the secret.                                               |
| `KORA_FEE_PAYERS`                  | The fee payer public key of each replica, comma separated, in the order of `KORA_URLS`, each different. Pinned: any other key is refused.          |
| `KORA_PAYMENT_WALLET`              | The public key of the wallet whose USDC account the network cost is paid into. Pinned in the same way.                                             |
| `KORA_ACCOUNT_CREATION`            | `on` (default) or `off`. Off, the relayer opens no token accounts, and an action that needs one opened is refused.                                 |

## Usage analytics

Off unless the first three are set, and all three or none.

| Variable           | Purpose                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `UMAMI_URL`        | NoirWire's own Umami server.                                                                             |
| `UMAMI_WEBSITE_ID` | The site id on it.                                                                                       |
| `UMAMI_HOSTNAME`   | The host name events are counted under, such as `app.noirwire.com`.                                      |
| `ANALYTICS_SALT`   | A server-only secret that keys the visitor code. Without it no code is sent and only totals are counted. |

## Not variables

The per-route limits that do not follow from a provider rate, the body and answer caps, the timeouts, the relayer's price rule, its caps and its signature budgets are constants in the code, next to the reason for each. Changing one is a code change with a test.

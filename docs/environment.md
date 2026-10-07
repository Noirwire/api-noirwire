# Environment

Read once at start-up by `src/config/core/config.ts`; anything missing or malformed stops the start and names the variable. "On Railway" means `RAILWAY_ENVIRONMENT_NAME` is set, which Railway does itself.

| Variable                                          | Required or default                            | Meaning                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `SOLANA_NETWORK`                                  | Required; `mainnet` on Railway                 | `mainnet` or `devnet`.                                                                                        |
| `SOLANA_RPC_URL`                                  | Required on mainnet; public endpoint on devnet | The RPC provider, key included.                                                                               |
| `SUPABASE_URL`                                    | Required                                       | The Supabase project that issues the sessions.                                                                |
| `SUPABASE_PUBLISHABLE_KEY`                        | Required                                       | That project's publishable key.                                                                               |
| `ALLOWED_ORIGINS`                                 | Required                                       | The exact origins that may call from a browser, comma separated.                                              |
| `EDGE_SHARED_SECRET`                              | Unset                                          | At least 32 characters, shared with the web app's server, which may then report the browser's address.        |
| `KORA_URLS`                                       | Unset: no relayer                              | The relayer's replicas, comma separated. Set, the next four are required.                                     |
| `KORA_API_KEY`, `KORA_HMAC_SECRET`                | With `KORA_URLS`                               | The relayer's credentials.                                                                                    |
| `KORA_FEE_PAYERS`                                 | With `KORA_URLS`                               | The fee payer public key of each replica, in the order of `KORA_URLS`.                                        |
| `KORA_PAYMENT_WALLET`                             | With `KORA_URLS`                               | The public key of the wallet the network cost is paid into.                                                   |
| `KORA_ACCOUNT_CREATION`                           | `on`                                           | `off` stops the relayer opening token accounts.                                                               |
| `PROFILE_ROLLUP_URL`                              | Unset: no profiles                             | The private rollup the profile program runs on. https, with no query string.                                  |
| `PROFILE_PROGRAM_ID`                              | Unset: no profiles                             | The profile program's address.                                                                                |
| `PROFILE_GATE_SECRET_KEY`                         | Unset: no profiles                             | The gate's secret key, as the JSON array of 64 bytes in its keypair file. A secret: never logged or returned. |
| `PROFILE_MAX_DATA_LEN`                            | `2048`                                         | The largest record a profile may carry, in bytes. At most 4096, and no more than the program allows.          |
| `PROFILE_DAILY_CREATE_CAP`                        | `500`                                          | The most profile creations the gate signs in 24 hours, whoever asks.                                          |
| `PORT`                                            | `4000`; set by Railway                         | The port to listen on.                                                                                        |
| `TRUSTED_PROXY_HOPS`                              | `0`; `1` on Railway                            | `1` reads the client address from the edge's `X-Real-IP` header.                                              |
| `RPC_PROVIDER_RPS`                                | `8`                                            | The most requests a second sent to the RPC provider.                                                          |
| `JUPITER_PROVIDER_RPS`                            | `5`                                            | The same for Jupiter.                                                                                         |
| `SESSION_STARTS_PER_IP_PER_HOUR`                  | `10`                                           | Sessions one client address may start in an hour.                                                             |
| `SESSION_STARTS_PER_HOUR`                         | `600`                                          | Sessions started in an hour in total.                                                                         |
| `SESSION_MAX_AGE_HOURS`                           | `24`                                           | A session older than this is refused and not renewed.                                                         |
| `SUPABASE_JWT_SECRET`                             | Unset                                          | Only for a project that signs sessions with one shared secret. At least 32 characters.                        |
| `JUPITER_API_KEY`                                 | Unset                                          | Raises Jupiter's keyless rate limit.                                                                          |
| `JUPITER_API_URL`                                 | `https://api.jup.ag`                           | The swap, lending and price venue.                                                                            |
| `MAGICBLOCK_API_URL`                              | `https://payments.magicblock.app`              | The private-payment host.                                                                                     |
| `PRICE_HISTORY_API_URL`                           | `https://datapi.jup.ag`                        | The chart source.                                                                                             |
| `UMAMI_URL`, `UMAMI_WEBSITE_ID`, `UMAMI_HOSTNAME` | Unset: no analytics                            | The analytics server, the site id and the host name events are counted under. All three or none.              |
| `ANALYTICS_SALT`                                  | Unset                                          | Keys the visitor code. Without it only totals are counted.                                                    |

Profiles are kept only when `PROFILE_ROLLUP_URL`, `PROFILE_PROGRAM_ID` and `PROFILE_GATE_SECRET_KEY` are all set. With any of the three unset the feature is off, `GET /v1/profile/config` says so, and the start is not refused. With all three set, a malformed one stops the start like any other variable.

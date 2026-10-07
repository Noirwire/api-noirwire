<p align="center">
  <img src=".github/assets/noirwire.svg" alt="" width="64" height="64">
</p>

<h1 align="center">NoirWire API</h1>
<p align="center">The server between the NoirWire wallets and every service they have to ask.</p>

<p align="center">
  <a href="https://github.com/Noirwire/api-noirwire/actions/workflows/ci.yml"><img src="https://github.com/Noirwire/api-noirwire/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <img src="https://img.shields.io/badge/version-0.1.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-proprietary-black" alt="License">
</p>

**NoirWire is a non-custodial Solana wallet, and this is the one server its web and mobile apps talk to: it relays their requests to the RPC provider, Jupiter, MagicBlock and NoirWire's fee relayer, so each of those sees this server's address and never a user's next to their wallet addresses.**

- A wallet address is treated as a secret. Nothing of a caller is forwarded upstream, stored or logged: not an IP, a token, an address, a transaction or a query string.
- It is not an open proxy. Every route takes a closed list of methods or paths, a bounded body and a bounded answer, and refuses the rest.
- The fee relayer signs only what this server has checked itself: the whole transaction template, the portfolio's own signature, and a price worked out from a SOL price it reads independently.
- Sessions are anonymous and short-lived. A token is a quota bucket, not an identity, and nothing that guards money depends on it.
- It fails closed: a bad configuration stops the start, a missing price stops the relayer, a full counter table refuses newcomers.

We publish this source so that anyone can read what stands between their wallet and the network. See [LICENSE](LICENSE) for what you may do with it.

## Architecture

TypeScript on Node 24 with NestJS and Express. No database: the only state is counters and cached market data in the memory of one process.

Each module keeps its logic in a `core/` folder of plain functions that import no framework, with a thin controller around it. A lint rule enforces that, so the logic's tests never need NestJS.

```
src/
  config/core/            the configuration, validated once at start-up
  common/core/            the relay, bounded reads, quotas, the error list, the log's only fields
  common/http/            admission, middleware (headers, CORS, deadline, log), the error filter
  auth/                   the token verifier (core/) and the guard on every /v1 route
  session/                starting and renewing anonymous sessions
  rpc/                    one allow-listed Solana JSON-RPC call
  jupiter/                allow-listed Jupiter paths
  private-payments/       allow-listed MagicBlock paths
  relayer/                the transaction template, the price, the budgets, the replicas
  profile/                the three profile transactions, the gate's signature, the rollup
  prices/, history/       market data, read once for everyone
  events/                 the closed list of usage events
  chain/core/             the network, the listed trackers, the chain reads
```

| Route                                    | What it does                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /health`                            | Liveness, no session                                                                |
| `POST /v1/session`                       | Starts an anonymous session                                                         |
| `POST /v1/session/refresh`               | Renews one, until it is too old                                                     |
| `POST /v1/rpc`                           | One allow-listed Solana JSON-RPC call, no batches                                   |
| `GET\|POST /v1/jupiter/*`                | Quotes, orders, landing a swap, Jupiter Lend                                        |
| `POST /v1/private-payments/*`            | MagicBlock private transfers                                                        |
| `GET\|POST /v1/relayer`                  | The relayer's pinned keys; price or co-sign a transaction                           |
| `GET /v1/profile/config`                 | Whether profiles are kept here, and the keys a profile transaction is built against |
| `POST /v1/profile/challenge`, `/session` | Signing in to the private rollup as a profile's owner                               |
| `POST /v1/profile/read`, `/blockhash`    | The owner's encrypted profile, and the rollup's blockhash                           |
| `POST /v1/profile/submit`                | Create, write or close a profile: checked in full, then co-signed and sent          |
| `GET /v1/prices`                         | Live prices of every listed asset                                                   |
| `GET /v1/history/:symbol/:range`         | One tracker's price history                                                         |
| `POST /v1/events`                        | One usage event from the closed list                                                |
| `GET /docs`, `GET /docs-json`            | The API explained in words, and its OpenAPI document                                |

The full contract, with every refusal, status code and privacy rule, is at `/docs` on a running copy and in [docs/openapi.json](docs/openapi.json). More in [docs/architecture.md](docs/architecture.md) and [docs/privacy-and-safety.md](docs/privacy-and-safety.md).

### How the repositories fit together

| Repository                                                       | What it is                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `api-noirwire` (this repository)                                 | The API every wallet talks to                                                 |
| [shared-noirwire](https://github.com/Noirwire/shared-noirwire)   | The wallet core both apps run on, including the clients that call this API    |
| [mobile-noirwire](https://github.com/Noirwire/mobile-noirwire)   | The Expo mobile app                                                           |
| [relayer-noirwire](https://github.com/Noirwire/relayer-noirwire) | The fee relayer, a fork of `solana-foundation/kora`, reached only by this API |
| app-noirwire                                                     | The Next.js web app (private)                                                 |
| landinpage-noirwire                                              | The marketing site (private)                                                  |

## Quick start

Node 24 and Docker (for the local identity provider).

```sh
git clone https://github.com/Noirwire/api-noirwire.git
cd api-noirwire
npm ci
cp .env.example .env        # working defaults: devnet, local Supabase, no relayer
npm run supabase:start      # Supabase Auth on port 54421
npm run dev                 # the API on http://localhost:4000, docs at /docs
```

Or both at once, in the background, for an app or a client library to develop against: `npm run dev:stack` starts the local Supabase and the API on port 4000 (devnet, the `.env.example` defaults) and prints the URLs; `npm run dev:stack:stop` stops what it started.

```sh
npm run dev:stack                     # starts the stack; open http://localhost:4000/docs for the full contract
TOKEN=$(curl -s -X POST http://localhost:4000/v1/session | jq -r .accessToken)
curl -s http://localhost:4000/v1/prices -H "Authorization: Bearer $TOKEN"
```

In another terminal, prove the chain end to end: a session is started through the API, used on real routes, renewed, and a request without one is refused.

```sh
npm run e2e:local
npm run supabase:stop       # when done
```

## Development

| Suite       | Command                    | What it covers                                                                                                                                                                                           | In CI                |
| ----------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Unit        | `npm test`                 | All framework-free logic: the transaction template and every hostile variation, pricing, budgets, quotas, the relay, bounded reads, the allow-lists, the configuration, the token verifier and the guard | Yes                  |
| Integration | `npm run test:integration` | The real HTTP stack with a local server standing in for every provider: each route, each refusal, auth, CORS, size caps, rate limits, what is forwarded and logged, and the OpenAPI file                 | Yes                  |
| Live        | `npm run test:live`        | Read-only calls through a running copy to the real providers. Runs only when `API_LIVE_URL` is set                                                                                                       | Manual dispatch only |

Also run in CI: `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm run build` and a Docker build.

`npm run openapi` rewrites `docs/openapi.json` from the code. An integration test fails when the committed file is stale. See [docs/testing.md](docs/testing.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Deployment

Railway, one replica: the steps are in [docs/deploy.md](docs/deploy.md).

## Environment

Every variable and its default is in [docs/environment.md](docs/environment.md).

Profiles (a wallet's own labels, encrypted on the device and kept on a private rollup) are optional. They are on only when `PROFILE_ROLLUP_URL`, `PROFILE_PROGRAM_ID` and `PROFILE_GATE_SECRET_KEY` are all set; `PROFILE_MAX_DATA_LEN` and `PROFILE_DAILY_CREATE_CAP` have defaults. With any of the first three unset the profile routes answer `404`, `GET /v1/profile/config` says `enabled: false`, and nothing else changes.

## Security

Report a vulnerability privately to **ph1l1ph@proton.me**. See [SECURITY.md](SECURITY.md).

What the code guarantees, and tests hold it to: nothing of a caller reaches a provider or the log; only allow-listed calls are relayed; a provider's answer is passed on only as bounded JSON; the relayer is asked to sign only a transaction that matches the template, carries the portfolio's signature and pays this server's price; a `401` only ever means the caller's own session. What it does not: the counters are per process and are not hard limits, and this code has not been audited.

## Licence

Proprietary, all rights reserved. See [LICENSE](LICENSE).

NoirWire: [noirwire.com](https://noirwire.com) · [shared-noirwire](https://github.com/Noirwire/shared-noirwire) · [mobile-noirwire](https://github.com/Noirwire/mobile-noirwire) · [relayer-noirwire](https://github.com/Noirwire/relayer-noirwire)

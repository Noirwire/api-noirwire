# Architecture

One NestJS service, no database. A wallet calls it; it calls a provider; the answer goes back. What it adds on the way is the reason it exists: an allow-list, a size cap, a rate limit, and, for the fee relayer, a full check of the transaction.

```
 web wallet (through the web app's own origin)  ─┐
                                                 ├─>  NoirWire API  ─┬─>  RPC provider
 mobile wallet (directly)                       ─┘        │          ├─>  Jupiter (trading, lending, prices, charts)
                                                          │          ├─>  MagicBlock private payments
                                                          │          ├─>  MagicBlock's private rollup (profiles)
                                                          │          ├─>  NoirWire's fee relayer (Kora), private network only
                                                          │          ├─>  NoirWire's analytics server (Umami)
                                                          └──────────┴─>  Supabase Auth (anonymous sessions)
```

## A request, step by step

1. **Headers.** Every response gets the headers of a JSON API that is nothing else: a policy that lets it load nothing, no framing, no type sniffing, no caching.
2. **Log.** One line is written when the response ends: the route's pattern, the status, the duration.
3. **Deadline.** A response that is not written within 60 seconds is answered `504`.
4. **CORS.** A request that names an `Origin` is served only if the origin is on the list; a foreign one is refused outright. A request with no `Origin` passes to the next step.
5. **Session.** Every route requires a session token unless it is marked public (`/health`, and the two session routes). The token's signature, issuer, audience, expiry and the session's age are checked.
6. **Admission.** The route's budgets are taken (session, address, total), then the body is read with a size cap and a five-second deadline. The framework parses no body: each route reads its own.
7. **The route's own rule.** The allow-list, the validation, and for the relayer the template, the signature and the price.
8. **The provider's allowance.** On the RPC and Jupiter routes, the request waits its session's turn at the provider gate (`src/common/core/providerGate.ts`), or is refused with `Retry-After`.
9. **The relay.** One upstream request, written from scratch. Coming back: a status and a JSON body under a size cap, or a fixed error.

## The folders

Each module has a `core/` folder of plain functions and a thin controller. `core/` imports no framework and nothing outside a `core/` folder; a lint rule in `eslint.config.mjs` enforces it. That is what lets the unit suite run the transaction checks, the pricing and the budgets without starting anything.

| Folder                  | What lives there                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/core`       | `loadConfig`: every variable read once, every problem named at once, the service refuses to start on any                                                                                                            |
| `src/common/core`       | `relay`, `admit`, `readCapped`, the quota store, the client address, the cache, the list of errors (`answer.ts`), the log's fields                                                                                  |
| `src/common/http`       | The middleware, the exception filter, admission bound to a request, the OpenAPI helpers                                                                                                                             |
| `src/auth`              | `core/verifier.ts` (jose) and the global `SessionGuard`                                                                                                                                                             |
| `src/session`           | `core/sessions.ts`: the two calls to Supabase Auth, and the maximum age                                                                                                                                             |
| `src/rpc`               | The method allow-list and the heavy-method budget                                                                                                                                                                   |
| `src/jupiter`           | The path allow-list and the body-to-query translation                                                                                                                                                               |
| `src/private-payments`  | The path allow-list                                                                                                                                                                                                 |
| `src/relayer/core`      | `relayed.ts` (the template), `relayer.ts` (the route's rules), `solPrice.ts` (Pyth), `accountRent.ts` (rent of the real account)                                                                                    |
| `src/profile/core`      | `transaction.ts` (the three profile transactions, and the gate's signature), `program.ts` (the program's accounts and errors), `rollup.ts` (the calls to the rollup), `profiles.ts` (the routes' rules and budgets) |
| `src/prices`, `history` | The sources and their caches                                                                                                                                                                                        |
| `src/events/core`       | The closed event list and what is forwarded                                                                                                                                                                         |
| `src/chain/core`        | The network's USDC mint, the listed trackers, the two chain reads the server makes for itself, ed25519 signing and verifying                                                                                        |

## State

All of it is in memory, in one process:

- **Counters.** Every rate limit and budget goes through one interface, `QuotaStore` (`src/common/core/quota.ts`). The implementation keeps fixed windows keyed by session id or client address for a minute (an hour for the hourly budgets). It fails closed: when a table is full of live windows, a newcomer is refused. This is why the service runs as **one replica**. A shared store would implement the same interface.
- **Caches.** Live prices (30 seconds), price series (5 minutes to 6 hours), the SOL price (30 seconds), the rent of a token account per mint (5 minutes), the token keys (10 minutes, and re-read when a token names an unknown key).

Nothing is written to disk. A restart forgets everything, which costs one read of each source.

## Shared with the wallets

Three things here must stay the same as in `@noirwire/shared`, which the wallets run:

- **The transaction template** (`src/relayer/core/relayed.ts`). The wallet reads a relayer-paid transaction with the same rules before the portfolio signs. Neither takes the other's word, so a difference only ever makes one side refuse what the other accepts.
- **The listed trackers** (`src/chain/core/stocks.generated.json`). A copy of the catalog the wallets ship. It decides which tokens the relayer pays to send, which prices are read and which charts exist. It is a copy because the catalog sits in the package's infrastructure entry, which loads the wallet's key handling with it. `@noirwire/shared` is a development dependency for one purpose: `tests/unit/catalog.test.ts` fails when the copy differs from the installed package's.
- **The usage event list** (`src/events/core/usageEvents.ts`).

`@solana/web3.js` and `@solana/spl-token` are pinned to the versions the wallets use.

## The relayer signs; the wallet sends

`POST /v1/relayer` `signTransaction` never broadcasts. The relayer is asked to sign only, and the answer is `{ transaction, signature }`: the fully signed transaction and its id. The wallet records the id durably, then sends the transaction itself through `POST /v1/rpc` `sendTransaction` (on the allow-list, under the heavy-call budget; a transaction is about 1.7 KB encoded and the route takes 64 KB).

The reason is a double payment. A relayed transaction's id is the fee payer's signature, which does not exist until the relayer has signed. If the server signed and sent in one step, a wallet that died right after would hold no id to look for, would later find no trace of the action, decide it was safe to try again, and the user would pay twice. With the id in hand before anything is sent, the wallet can always ask the chain what became of it.

Before the signed transaction is returned it is held to what was sent in: the same message byte for byte, the portfolio's signature untouched, and a valid signature of the pinned fee payer. A transaction that is signed and never sent costs the relayer nothing. It still counts against the signature budgets, which are taken at signing.

Failover follows from the same line. Until a replica has signed, moving on is free: `getPayerSigner` tries each replica in turn, and a transaction whose own replica is unreachable or turns the request away (for this server's credentials too) is answered `503 relayer_unavailable`, so the wallet builds again for another. Once a replica has answered the signing call there is no failover: an unusable answer is a `502 no_answer`.

## Errors

Every error body is `{ "code", "error" }`, from the one list in `src/common/core/answer.ts`. Each code has one status. A `401` only ever means that the caller's session is not accepted: a provider that refuses this server's own credentials is a `502 upstream_refused` and is logged as an operator error. A provider's own error body passes through as the provider wrote it.

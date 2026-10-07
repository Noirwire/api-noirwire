# Testing

Three suites, all Vitest.

## Unit: `npm test`

`tests/unit/`. The logic in the `core/` folders, with no framework and no network beyond a local key server.

| File                         | Covers                                                                                                                                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relayed.test.ts`            | The transaction template: every genuine shape, and every hostile variation with the fixed reason it is refused for. The pricing arithmetic.                                                                                                                            |
| `relayer.test.ts`            | The relayer route's rules with a stand-in relayer and chain: pricing, the SOL price and its floor, rent of the real account, the portfolio's signature, underpayment, the budgets, the replicas, what is logged                                                        |
| `profileTransaction.test.ts` | The three profile transactions: each genuine shape built with web3.js, every hostile variation with the fixed reason it is refused for, the gate's signature verified beside the owner's, a 2,000-byte record co-signed in the bytes it arrived in, and the size bound |
| `profiles.test.ts`           | The profile routes' rules with a stand-in rollup and a moved clock: nothing signed or sent for a refused transaction, the program's refusals as `409`, confirmation and its bound, "already processed", the creation budgets and the daily cap, profiles switched off  |
| `profileProgram.test.ts`     | The copy of the profile program's error numbers, discriminators and accounts against the parts of the program's IDL kept in `tests/support/profileIdl.ts`, and that copy against the program's own build where a checkout of it sits beside this repository            |
| `relay.test.ts`              | What is sent upstream and what comes back: headers, JSON only, size cap, `429`, `401`/`403`, timeouts, never-connected                                                                                                                                                 |
| `admit.test.ts`              | Budgets before the body, the size cap by length and by stream, the body deadline                                                                                                                                                                                       |
| `quota.test.ts`              | Limits per session, per address and in total; all-or-nothing budgets; failing closed when full                                                                                                                                                                         |
| `clientIp.test.ts`           | The client address with and without a trusted proxy; IPv6 by /64                                                                                                                                                                                                       |
| `rpc.test.ts`                | The method list, batches, malformed calls                                                                                                                                                                                                                              |
| `jupiter.test.ts`            | The path lists and the body-to-query translation                                                                                                                                                                                                                       |
| `config.test.ts`             | Every refusal at start-up                                                                                                                                                                                                                                              |
| `verifier.test.ts`           | Tokens against a local key server: valid, expired, wrong issuer, wrong audience, bad signature, shared secret, key rotation, algorithm confusion, session age                                                                                                          |
| `sessionGuard.test.ts`       | The guard: missing token, refusals, public routes, failing closed                                                                                                                                                                                                      |
| `sessions.test.ts`           | Starting and renewing a session with a stand-in identity provider                                                                                                                                                                                                      |
| `events.test.ts`             | The closed event list and what is forwarded                                                                                                                                                                                                                            |
| `catalog.test.ts`            | The listed trackers are exactly the catalog the installed `@noirwire/shared` ships                                                                                                                                                                                     |
| `marketData.test.ts`         | Prices, charts, and the read-once cache                                                                                                                                                                                                                                |

## Integration: `npm run test:integration`

`tests/integration/`. The real application over real HTTP. One local server (`support/providers.ts`) stands in for every provider: the RPC provider (including the chain reads the API makes for itself), Jupiter, the chart source, MagicBlock, the private rollup, two relayer replicas, Umami and Supabase Auth. It records what it was sent, so the tests can assert that nothing of the caller travelled. Nothing reaches the internet.

It covers each route's happy path, each allow-list refusal, batches, `429` pass-through, upstream `401` mapped to `502`, size caps, the body deadline, rate limits per session, per address and in total, CORS preflight for an allowed and a foreign origin, the token check on every route, the relayer's refusals and failover, the profile routes against the stand-in rollup (and switched off), the two session routes, the log's contents, and that `docs/openapi.json` matches the code.

## Live: `npm run test:live`

`tests/live/`. Read-only calls through a running copy to the real providers. Skipped unless `API_LIVE_URL` is set. In CI it runs only by manual dispatch (`.github/workflows/live-checks.yml`). It signs nothing and sends no transaction.

```sh
npm run supabase:start
npm run dev                                   # in another terminal
API_LIVE_URL=http://localhost:4000 npm run test:live
```

## A local stack for the apps: `npm run dev:stack`

`scripts/dev-stack.mjs` starts the local Supabase stack and the API on port 4000 (devnet, the `.env.example` defaults) in the background and prints the URLs. `npm run dev:stack:stop` stops what it started. The apps and the client library's live tests run against it.

## End to end, locally: `npm run e2e:local`

`scripts/e2e-local.mjs`. Against a running copy and the local Supabase stack: starts a session through the API, calls real routes with it, renews it, and checks that a request without one is refused.

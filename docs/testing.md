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
| `rewardsRules.test.ts`       | The rewards arithmetic this server does: the season's weeks and the claim window, a share in basis points, the signed messages (a join's carries its invite code), the fee read from a trade's token balances and each reason a trade earns nothing                    |
| `rewards.test.ts`            | The rewards routes' rules with the ledger in memory, a stand-in chain, a moved clock: joining, the signed invite code, the daily cap, signatures, the time window, every claim refusal, lazy settlement, nothing of the portfolio or transaction stored or logged      |
| `rewardsUpstreams.test.ts`   | What the rewards database is sent over REST (one SQL function, the secret key, a fingerprint) and how its answers are read; the one `getTransaction` call, and a transaction read only under its first signature                                                       |
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

`tests/integration/`. The real application over real HTTP. One local server (`support/providers.ts`) stands in for every provider: the RPC provider (including the chain reads the API makes for itself), Jupiter, the chart source, MagicBlock, the private rollup, two relayer replicas, Umami, Supabase Auth and the rewards database's REST interface (over a ledger kept in memory, `tests/support/rewards.ts`). It records what it was sent, so the tests can assert that nothing of the caller travelled. Nothing reaches the internet.

It covers each route's happy path, each allow-list refusal, batches, `429` pass-through, upstream `401` mapped to `502`, size caps, the body deadline, rate limits per session, per address and in total, CORS preflight for an allowed and a foreign origin, the token check on every route, the relayer's refusals and failover, the profile routes against the stand-in rollup (and switched off), the rewards routes against the stand-in database and chain (and switched off), each rewards refusal with its status and code, the two session routes, the log's contents, and that `docs/openapi.json` matches the code.

### The rewards SQL: `tests/integration/rewardsSql.test.ts`

The migration in `supabase/migrations` is executed, not only read. The suite loads the file into a Postgres that runs inside the test process (`@electric-sql/pglite`, a development dependency: no Docker and no service container, in CI either), creates the `anon`, `authenticated` and `service_role` roles as a Supabase project has them, and calls the functions through the application's own database adapter, as `service_role`, with the argument names the adapter really sends.

It covers: joining once and the uniqueness of a code; an invite code that binds only at the first join, never to its own member, never when unknown or not active; the cap on new members per UTC day; a credit adding its fee, and a fingerprint refused the second time with no total changed; a code becoming active with the first credit; the split of a week (rounded down, never above the pot, 1.1 for an invited member's first eight weeks, 0.2 to the inviter, nothing of either for a trade from before the member joined, nothing for an empty week); a week settled once however often it is asked for; no credit to a settled week; a member's state; member numbers (in the order of joining, kept on a second join, none used up by a refused join); a trade of the double hour (shown as paid, counted twice in the share, the settlement and the inviter's 0.2); the counts of members and of a week's traders (by member, in that week alone, the same in a member's state); row level security on all five tables with no policy; and `anon` and `authenticated` refused on every table and every function.

One test holds the two copies of the rules together. The other rewards tests run against a stand-in that keeps the ledger in memory (`tests/support/rewards.ts`) and scores by its own copy of the rules; the parity test runs a fixed set of members and fees through that copy and through the SQL settlement and fails when a single member's points differ.

**Still not executed by any suite:**

- **The REST interface itself.** PostgREST is stood in for by one line of SQL per call. That it answers a function that returns nothing with an empty body, turns a JSON string into a `bigint`, and takes the secret key in both headers is taken from its documentation.
- **Two requests at once.** The in-process Postgres is one connection, so the locks that keep a claim out of a week being settled, and two joins from passing the daily cap together, are never contended. Their effect in sequence is tested; that they hold under concurrency is not.
- **A real Supabase project.** The three roles are created by the suite as the project has them; the project's own default privileges on new tables and functions are not there. The migration revokes and grants explicitly so as not to depend on them.

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

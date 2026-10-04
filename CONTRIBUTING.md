# Contributing

## Before you commit

Run all of these. CI runs the same checks and a pull request does not merge until they pass.

```sh
npm run lint
npm run typecheck
npm run format:check
npm run test:all
npm run build
```

`npm run test:all` runs the unit suite then the integration suite. `npm test` alone only runs the unit suite, so an HTTP or contract failure in `tests/integration/` would not show up before a commit: run `test:all`, not `test`.

`npm run format` fixes formatting. A change to a route's documentation or shape also needs `npm run openapi`, which rewrites `docs/openapi.json`; an integration test fails while it is stale.

## Commits

- Keep the subject under 50 characters.
- Start it with a conventional prefix: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`, `ci:` or `build:`.
- Write it in the imperative: `fix: refuse a second batch`, not `fixed` or `fixes`.
- One change per commit. Explain why in the body when the reason is not obvious from the change.

## Tests

Every change comes with its tests. A new rule has a test for each branch; a fixed bug has a test that failed before the fix. A new refusal is tested twice: in the `core/` logic, and over HTTP in `tests/integration/`.

- Give each test one failure it uniquely catches; repeat across layers only where the boundary changes.
- Assert money, keys, authorization, accessibility or an observable decision; never exact prose or an input echoed back.
- Keep one real crypto round trip per boundary; seed fixtures elsewhere and use controlled clocks, not sleeps.

## The structure rule

Each module keeps its logic in `core/`: plain functions that import no framework and nothing outside a `core/` folder. Controllers and providers are thin. `npm run lint` enforces this, so the logic's tests never need NestJS.

## Code

- Small modules with one job each, named in the product's words: portfolio, funding wallet, tracker.
- No dead code and no commented-out code. Comment only where the reason is not obvious.
- Build what the change needs and nothing more. A new dependency needs a reason in the pull request.
- Use relative imports with the `.js` extension. The service runs as ES modules.
- Every input is validated with zod at the boundary. Every error comes from the one list in `src/common/core/answer.ts`.
- The log has no free-form field. If something new has to be logged, it is a fixed word, and it is added to `LogLine`.
- A new route is closed by default: it requires a session unless it is marked `@Public()`, and it states its quotas, its body cap and its answer cap.

## Text people read

- Say "portfolio", "funding wallet" and "trackers".
- No em dashes. Three periods for an ellipsis.
- Say plainly what happened and what to do next.

## Security issues

Do not open an issue or a pull request for a vulnerability. See [SECURITY.md](SECURITY.md).

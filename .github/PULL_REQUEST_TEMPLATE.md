## What and why

<!-- The problem, the approach, and which module(s) it touches (session, rpc, jupiter,
     private-payments, relayer, prices, history, events, common). Link an issue if one exists. -->

## Testing

<!-- The commands you ran, and their result. At minimum: npm run lint, npm run typecheck,
     npm run format:check, npm test, npm run test:integration. -->

## Checklist

- [ ] `npm run lint`, `npm run typecheck`, `npm run format:check`, `npm test` and `npm run test:integration` all pass locally
- [ ] A new rule or refusal is tested in `core/` and over HTTP
- [ ] `docs/openapi.json` was regenerated (`npm run openapi`) if a route or its documentation changed
- [ ] Nothing of a caller is forwarded upstream or logged, and the log gained no free-form field
- [ ] No key, secret or `.env` value was committed
- [ ] No internal planning references, phase numbers or roadmap language were added

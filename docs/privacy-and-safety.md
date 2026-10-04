# Privacy and safety

## What this server is for

A wallet address is treated as a secret. What gives one away off chain is not the chain but the services a wallet has to ask: each would otherwise see the user's IP address next to the addresses it is asked about, and the RPC provider would see the funding wallet and every portfolio arrive from that one IP. So the wallets ask this server, and this server asks the provider.

**Every upstream request is written from scratch** (`src/common/core/relay.ts`): the body, a content type, a fixed user agent and this server's own key for the provider. No IP, token, session id, cookie, referer, origin or browser name goes with it. Coming back, only a status and a JSON body pass, under a size cap; a provider's headers never do, and a body that is not JSON is replaced by a fixed error.

**One address per request.** The wallets read each address separately, and this server forwards what it receives and never merges two requests. A JSON-RPC batch is refused, and the one read that lists an address's recent transactions (`getSignaturesForAddress`, which the wallet needs to find a payment that landed without its id being recorded) takes exactly one address and a stated limit of at most 50.

**Nothing is kept.** There is no database. The log has one line per request with the route's pattern, the status and the duration, and for a refusal one fixed word. The type of a log line (`src/common/core/log.ts`) has no free-form field, so there is nowhere to put a token, a session id, an address, a body or a query string, and the integration suite checks that none appears.

## What is left, plainly

| Who                  | Sees the user's IP                         | Sees addresses                                                | Can link funding wallet to portfolio                                              |
| -------------------- | ------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| This server          | Yes, or the web app's server's (see below) | In transit, every one. Nothing is stored or logged.           | It could, if it logged. It does not, and you have to trust that, or read it here. |
| The hosting platform | Yes                                        | Not in URLs: addresses travel in request bodies only.         | Not from its request logs, which record a path, a status and an IP.               |
| RPC provider         | No                                         | Every address read, and every transaction sent.               | Not from any single request. By timing, plausibly: see below.                     |
| Jupiter              | No                                         | The portfolio that trades or lends. Never the funding wallet. | No.                                                                               |
| MagicBlock           | No                                         | The funding wallet and the portfolio, in one request.         | Yes. A private transfer cannot be built without naming both.                      |
| NoirWire's relayer   | No                                         | The portfolio that sends or lends, and its counterparty.      | No. One relayed transaction names one portfolio and never the funding wallet.     |
| Supabase Auth        | No                                         | None. It is never sent one.                                   | No.                                                                               |
| NoirWire's analytics | No                                         | None. The event list has no field for one.                    | No.                                                                               |

Timing is the honest gap. All of a wallet's requests reach a provider from this server, moments apart. With few users online, a provider that looks for addresses always read together can guess they share an owner. Splitting the requests removes the proof, not the hint. The relay does not delay or pad requests to hide this.

And everything on chain is public whatever this server does. It keeps a network address away from the services that see wallet addresses. It does not make transactions private.

## Sessions

Every `/v1` route but the two session routes requires `Authorization: Bearer <token>`. The token is a Supabase **anonymous** session, started and renewed by this server on the wallet's behalf (`src/session/core/sessions.ts`), so Supabase sees this server's address and never a user's.

- **A session is a quota bucket, not an identity.** It proves that this API issued it and that it has not expired. It names nobody, it is tied to no wallet, and anyone can get another. Nothing that guards money depends on it.
- **It is the join key, so it is short-lived.** One session's requests can be told to belong together, by this server while they pass and by nobody else. A session older than `SESSION_MAX_AGE_HOURS` (24 by default) is refused on every route and is not renewed; the wallet starts a new one, unrelated to the last.
- **Verification** (`src/auth/core/verifier.ts`): the signature against the project's published keys (cached, re-read when a token names an unknown key, which is how a rotated key is picked up), or against a shared secret when one is configured; the issuer; the audience `authenticated`; the expiry, with five seconds of tolerance. The algorithm is chosen by this server's configuration, never by the token: a public key is never used as a shared secret.
- **A `401` means only that the session is not accepted.** A provider that turns down this server's own credentials is answered as a `502 upstream_refused` and logged as an operator error, because a wallet reads a `401` on a submit as "nothing was sent".

## Limits

**Per caller.** Every route counts a request against three budgets, per minute: the session's, the client address's, and a total for the route.

**Per provider.** A provider allows this server's key only so many requests a second, counted together whoever they are for. So the RPC route and the Jupiter routes send each provider fewer than it allows (`RPC_PROVIDER_RPS`, `JUPITER_PROVIDER_RPS`), through a token bucket with a small burst (`src/common/core/providerGate.ts`). Requests wait in a line per session and the lines are served in turn, so a quiet wallet is served however loud another is. A request that would wait more than about 400 ms is answered `429 rate_limited` with `Retry-After`. The costly RPC calls are held to half the rate as well. The per-minute budgets follow from the same numbers: a route's total is what the gate lets through in a minute, a session may take half of it. The server's own reads of a provider (the SOL price, a mint, the price index) wait in the same line.

**Starting a session** is the one thing that needs no token, and each session is a new set of budgets, so it is rationed hardest: 10 an hour per client address and 600 an hour in total, unless configured (`SESSION_STARTS_PER_IP_PER_HOUR`, `SESSION_STARTS_PER_HOUR`). A wallet starts a session only when it has none or its last was retired; otherwise it refreshes.

**The client address** is never one a caller wrote. With no trusted proxy it is the socket's. Behind Railway's edge (`TRUSTED_PROXY_HOPS=1`) it is the `X-Real-IP` header the edge sets; when that header is missing or is not an address, it falls back to the socket's. `X-Forwarded-For` is not read at all. The web app's own server forwards its pages' requests, which would make every web user look like that server; when the operator configures `EDGE_SHARED_SECRET` and a request carries it in `X-NoirWire-Edge` (compared in constant time), the address is the one that server reports in `X-NoirWire-Client-IP`. Without the matching secret that header is ignored.

None of these is a hard limit, and none should be read as one:

- The counters live in the memory of one process (`src/common/core/quota.ts`). The service runs as one replica for that reason; a second would double every number. A restart forgets them, the session budgets included.
- A session costs little to replace, so the per-session limits and the fair turn at the provider gate keep wallets from crowding each other out. They are not a defence against someone who holds many sessions; rationing session starts is.
- When a counter table is full of live windows, a newcomer is refused, not waved through.

The hard limits are elsewhere: the provider gate (this server never asks more of a provider than it is configured to), and for the relayer the SOL kept in each fee payer wallet, which the operator keeps small.

**Not built yet.** Two things would make session starts hold against a determined abuser, and are recorded here as follow-up work: a durable budget (a shared store behind `QuotaStore`, so counts survive a restart and hold across replicas), and an abuse challenge before a session is issued (a proof of work or an attestation). Until then the defaults are deliberately low.

## The fee relayer

The relayer (a Kora server) signs a transaction as its fee payer and is paid back in USDC inside that same transaction. This server is the only thing that can reach it, and holds its credentials. It is not a signing service: anyone can call this API without ever running the wallet, and a session says nothing about who holds it, so every check is made on the transaction itself.

`src/relayer/core/relayed.ts` reads a transaction from its bytes into one of a few exact shapes or refuses it: a legacy message with no lookup table; a pinned fee payer and exactly one other signer, the portfolio; no priority fee and no System instruction; at most one account opened, only for the action beside it; one action from a short list (a send of USDC or a listed tracker, or Jupiter Lend's deposit, withdrawal or redemption (a whole position taken back, counted in receipt shares) in the one layout the program takes); and one bounded USDC payment into the pinned payment wallet's account. The fee payer appears nowhere except as the funder of that one account.

`src/relayer/core/relayer.ts` then sets the price, which is this server's and not the relayer's: twice the network fee, and for an account the relayer opens its rent plus a tenth. The rent is that of the account the mint really needs, read from the mint through this server's RPC (`accountRent.ts`), and it is charged whether or not the account exists when asked: a relayer release that charges nothing for an existing account can otherwise be made to open accounts unpaid. The SOL price is Pyth's SOL/USD feed, read from its account through the same RPC (`solPrice.ts`), used for thirty seconds at most, never below a fixed floor, and refused when stale, unverified or uncertain. Nothing is priced or signed while it and the price behind the relayer's own estimate differ by more than 5%. The fee can never exceed a cap fixed in code (0.05 USDC, or 2.5 USDC when an account is opened).

Before a signature, the payment must cover that price (to within 2%, for a price that moved since the review), the transaction must already carry the portfolio's own valid signature, and the signature budgets must allow it: 10 a minute per session, 30 per address, and 60 a minute and 600 an hour in total. A refused transaction is not counted against the total.

The relayer runs as one or more replicas, each with a fee payer key of its own, all pinned in this server's configuration and never learned from the relayer. A replica that does not answer is passed over for the next, freely, while nothing is signed. A transaction names its fee payer, so once the portfolio has signed one only that replica is asked. The answers tell the wallet what it may do next: `503 relayer_unavailable` means nothing was signed (the replica was unreachable, or turned the request away), so the wallet may build again for another; `502 no_answer` means what the replica did is not known, so the wallet waits for the chain to settle that transaction first.

Signing never broadcasts. The wallet gets the signed transaction and its id, records the id, and sends the transaction itself through `/v1/rpc`, so an action can never be in flight without the wallet knowing what to look for. The reason is in [architecture.md](architecture.md).

## The service itself

- **Configuration is validated at start-up** and the service refuses to start on anything missing or malformed: mainnet without a dedicated RPC, an RPC URL that names the other network, half a relayer configuration, fee payers that do not match the replicas one to one, an origin that is not exact, a key address that is not https.
- **No route takes a query string.** One is refused with `400 invalid_request` everywhere, the same way.
- **Bodies are bounded and streamed.** The framework parses none: each route reads its own with a size cap, stopping at the limit, and a five-second deadline.
- **Everything has a timeout.** Thirty seconds for a provider, eight for a relayer replica, the chart source and the price index, ten for the identity provider, five for analytics, sixty for a response as a whole.
- **Answers are JSON and nothing else**, with a fixed content type, `Cache-Control: no-store`, `nosniff`, and a content policy under which a response opened as a document can load and run nothing.
- **Errors say nothing.** A fixed code and sentence: no stack trace, no exception message and no provider message.
- **CORS** allows only the configured origins, without credentials, and a browser on any other origin is refused outright.
- **Redirects from a provider are not followed.**

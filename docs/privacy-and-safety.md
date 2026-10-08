# Privacy and safety

## What this server is for

A wallet address is treated as a secret. What gives one away off chain is not the chain but the services a wallet has to ask: each would otherwise see the user's IP address next to the addresses it is asked about, and the RPC provider would see the funding wallet and every portfolio arrive from that one IP. So the wallets ask this server, and this server asks the provider.

**Every upstream request is written from scratch** (`src/common/core/relay.ts`): the body, a content type, a fixed user agent and this server's own key for the provider. No IP, token, session id, cookie, referer, origin or browser name goes with it. Coming back, only a status and a JSON body pass, under a size cap; a provider's headers never do, and a body that is not JSON is replaced by a fixed error.

**One address per request.** The wallets read each address separately, and this server forwards what it receives and never merges two requests. A JSON-RPC batch is refused, and the one read that lists an address's recent transactions (`getSignaturesForAddress`, which the wallet needs to find a payment that landed without its id being recorded) takes exactly one address and a stated limit of at most 50.

**Nothing of a wallet is kept.** No address, transaction, session or IP is written anywhere. The one thing stored at all is the rewards ledger, for a wallet that joined rewards and only where rewards are configured: it is kept under a key that is not a wallet address, and is described under [Rewards](#rewards). The log has one line per request with the route's pattern, the status and the duration, and for a refusal one fixed word. The type of a log line (`src/common/core/log.ts`) has no free-form field, so there is nowhere to put a token, a session id, an address, a body or a query string, and the integration suite checks that none appears.

## What is left, plainly

| Who                         | Sees the user's IP                         | Sees addresses                                                                                | Can link funding wallet to portfolio                                              |
| --------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| This server                 | Yes, or the web app's server's (see below) | In transit, every one. Nothing is stored or logged.                                           | It could, if it logged. It does not, and you have to trust that, or read it here. |
| The hosting platform        | Yes                                        | Not in URLs: addresses travel in request bodies only.                                         | Not from its request logs, which record a path, a status and an IP.               |
| RPC provider                | No                                         | Every address read, and every transaction sent.                                               | Not from any single request. By timing, plausibly: see below.                     |
| Jupiter                     | No                                         | The portfolio that trades or lends. Never the funding wallet.                                 | No.                                                                               |
| MagicBlock                  | No                                         | The funding wallet and the portfolio, in one request.                                         | Yes. A private transfer cannot be built without naming both.                      |
| NoirWire's relayer          | No                                         | The portfolio that sends or lends, and its counterparty.                                      | No. One relayed transaction names one portfolio and never the funding wallet.     |
| MagicBlock's private rollup | No                                         | None. A profile's owner is a key derived for the profile alone, and the record is ciphertext. | No.                                                                               |
| Supabase Auth               | No                                         | None. It is never sent one.                                                                   | No.                                                                               |
| NoirWire's rewards database | No                                         | None. A member is a rewards key, derived for rewards alone. No portfolio is ever written.     | No.                                                                               |
| NoirWire's analytics        | No                                         | None. The event list has no field for one.                                                    | No.                                                                               |

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

## Profiles

A profile is a wallet's own labels (portfolio names, icons, the watchlist), encrypted on the device and kept as one small account on MagicBlock's private rollup, so that restoring the recovery phrase elsewhere brings them back. This server and the rollup only ever see ciphertext. The account belongs to a key derived for it alone, never the funding wallet's and never a portfolio's. The feature is optional: without its configuration the routes are not there, and the wallets work the same.

The program takes a creation or a write only with the signature of a gate key, which is held here and nowhere else and is the fee payer of both. A creation spends rent that the program's sponsor puts up. So this is not a signing service either: `src/profile/core/transaction.ts` reads a transaction from its bytes into one of three exact shapes or refuses it. A legacy message with no lookup table and exactly one instruction, for the profile program; that instruction's accounts in the program's order, each with the signer and writable flags the program expects, the sponsor, the profile and its permission account worked out again from the owner key in the instruction; no other account and no other signer in the message; the gate as fee payer of a creation or a write, the owner as fee payer of a closing; the owner's own valid signature; a record that is not empty and no longer than the configured limit. The gate signs the very message that was checked, and only then.

A read names an owner key and never an account: the address is derived here. The rollup's read token is the caller's, travels to the rollup in the query string as the rollup requires, and is never logged.

Creations are rationed harder than anything else here: 3 an hour per session, 10 an hour per address, and a ceiling on how many the gate signs in 24 hours in total (`PROFILE_DAILY_CREATE_CAP`, 500 unless configured). At the ceiling a creation is answered `429` and writes, closings and reads go on. Writes are held to 30 an hour per session. A refused transaction is counted against none of them. Like every counter here these live in the memory of one process, the 24 hours are a fixed window that begins with the first creation counted, and a restart forgets them. The hard limit on what can be lost is the SOL the sponsor holds.

The program's own refusals that a wallet acts on are answered as `409` under the program's name for them (`StaleRevision`, `ProfileExists`, `ProfileMissing`, `Paused`, `RecordTooLarge`). The rollup's messages are never passed on.

## Rewards

Rewards are points for trades, for a wallet that asks for them: each week of a twelve week season, 100,000 points are split between the members by the trading fees their claimed trades paid NoirWire. A wallet that never joins sends nothing to these routes. The feature is optional: without its configuration the routes are not there.

A member is a rewards key, an ed25519 key the wallet derives from the recovery phrase for this alone. It is not a Solana account, holds nothing, and is never the profile key, the funding wallet's key or a portfolio's. Every request is signed by it over a fixed text (`src/rewards/core/messages.ts`), and a join or a read also carries the time, which must be within 300 seconds of this server's clock. A join's signature covers the invite code too, as this server takes it (trimmed and in capitals, or empty): a join whose code is not the signed one is refused, so nobody on the way can tie a new member to an inviter of their choosing.

**What is stored**, in the Postgres of the Supabase project, in tables only the secret key reads or writes (row level security on, no policy, every function closed to the public roles): the rewards key, its referral code, who invited it, the week and the UTC day it joined, its member number (its place in the order of joining), its fee total per week as paid and as counted toward the score, its points per settled week, and one fingerprint per claimed transaction. There is no column for a portfolio, a transaction, a session, an IP address or a time of day (`supabase/migrations`).

**A claim is the one request that names a portfolio next to a rewards key.** It has to: the portfolio's signature over the claim is what stops anyone else claiming the trade. Both the portfolio and the transaction's id are used for the checks and then dropped. What is kept of the transaction is `HMAC-SHA256` of its id under a secret only this server holds, so that a trade is credited once; the id cannot be read back from it without that secret. Neither is logged or put in an error, and the unit and integration suites look for both in everything stored, logged and answered. This server does see the pair in transit, like every address it relays, and the RPC provider is sent the transaction's id alone, from this server's address.

**What is answered of other members: two counts.** `GET /v1/rewards/config` says how many keys have joined in all, and it and a member's state say how many members have a fee credited in the running week, so that a wallet can show how early a member would be. A member's own number says the same of the past: member 317 knows that 316 keys joined before. Each is a number and nothing else: no member, no fee and no total, and it is the same for everyone who asks. Config is asked by wallets that have not joined, so the count is read at most once in 60 seconds and kept in memory in between, with nothing of the caller sent to the database; when the database gives no answer the count is null and the rest of the answer stands, so whether rewards are on never depends on the database. In a week with very few traders the count does say that somebody traded, and a member who watches it move learns when another member's first claim of the week landed, to the minute.

**What the ledger still shows.** A weekly fee total says how much a member traded that week, to anyone who can read the database, and a claim arrives moments after its trade. Someone holding both the database and this server's fingerprint secret could test whether a given transaction was claimed, though not by whom: a fingerprint is not stored next to a member.

**Nothing a caller says decides what a trade is worth.** `src/rewards/core/claim.ts` reads the transaction from this server's own RPC provider, at `finalized` and under its first signature only: it must have succeeded, the portfolio must be one of its signers, and the fee is how much the USDC token account owned by NoirWire's referral account grew, by the transaction's own token balances. Its block time must fall inside the season, and no more than 24 hours after its week ended.

Recording the fingerprint and adding the fee are one step in the database, and so is settling a week: each is a single SQL function, and a duplicate or a second settlement changes nothing. A week is settled on the first request that reaches this server after its claims closed, at most once, whoever asks.

**An invite is worth something only from the week it was used in.** A trade made in a week before its member joined, and claimed afterwards inside the day of grace, counts once: no bonus for the member and no share for the inviter. Otherwise a code handed over after a good week would pay for trades it had nothing to do with.

**New members are rationed by the day.** A member costs nothing to make and a session is free to replace, so the number of keys that become members on one UTC day is capped (`REWARDS_DAILY_JOIN_CAP`, 2,000 unless configured), in the database and inside the same step that makes the member, so that two joins at once cannot pass it. The same step gives the member their number, the next in the order of joining; a join that is refused takes none.

**The double hour is the server's to apply.** Where one is configured (`REWARDS_DOUBLE_HOUR_START`), a trade whose block time falls in that hour has its fee counted twice toward its member's score for the week. Whether it does is decided here, when the claim is credited, from the block the chain put the trade in: a claim has no field for it, and no clock of the caller's is read. The member is always shown the fee the trade really paid; the counted fee is kept beside it and is what shares, the inviter's 0.2 and the settlement use. The week still splits the same 100,000 points, so the hour moves points between members and makes none. It must be announced before it happens and set before it starts, and changing it afterwards rewrites nothing already credited. Past the cap a new key is answered `429` and nothing is created; a key that is already a member is answered as always. Unlike the counters elsewhere here this one is not in memory: it is a count of rows, and a restart does not forget it.

## The service itself

- **Configuration is validated at start-up** and the service refuses to start on anything missing or malformed: mainnet without a dedicated RPC, an RPC URL that names the other network, half a relayer configuration, fee payers that do not match the replicas one to one, an origin that is not exact, a key address that is not https.
- **No route takes a query string.** One is refused with `400 invalid_request` everywhere, the same way.
- **Bodies are bounded and streamed.** The framework parses none: each route reads its own with a size cap, stopping at the limit, and a five-second deadline.
- **Everything has a timeout.** Thirty seconds for a provider, eight for a relayer replica, the chart source, the price index, the rewards database and the read of a claimed transaction, ten for the identity provider, five for analytics, sixty for a response as a whole.
- **Answers are JSON and nothing else**, with a fixed content type, `Cache-Control: no-store`, `nosniff`, and a content policy under which a response opened as a document can load and run nothing.
- **Errors say nothing.** A fixed code and sentence: no stack trace, no exception message and no provider message.
- **CORS** allows only the configured origins, without credentials, and a browser on any other origin is refused outright.
- **Redirects from a provider are not followed.**

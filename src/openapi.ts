import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";
import { ERRORS, type ErrorCode } from "./common/core/answer.js";
import { SESSION_SCHEME } from "./common/http/api-docs.js";

/** What each code means to a client, next to the sentence it is sent with. */
const MEANING: Record<ErrorCode, string> = {
  invalid_request: "The body, a field or the query is not what the route takes. Nothing was done.",
  unauthorized: "No session token, or one that does not verify. Start or refresh a session.",
  session_expired: "The session is past its maximum age. Start a new one with `POST /v1/session`.",
  session_invalid: "The refresh token is unknown, already used or revoked. Start a new session.",
  origin_not_allowed: "A browser on an origin that is not on this API's list.",
  method_not_allowed: "A JSON-RPC or relayer method outside the route's list. Nothing was done.",
  not_found: "No such route, or a path, symbol or range outside a route's list.",
  request_timeout: "The body did not arrive within 5 seconds.",
  request_too_large: "The body is over the route's size cap.",
  refused: "The relayer route refused the transaction. Nothing was signed.",
  insufficient_payment:
    "The relayed transaction pays less than the current price. Ask for a new price.",
  rate_limited:
    "A quota is spent, or a provider is rate limiting. Nothing was done. Retry with backoff.",
  internal_error: "An unexpected failure in this API.",
  upstream_failed: "A provider's answer was not JSON, was too large, or its connection broke.",
  upstream_refused:
    "A provider refused this server's own credentials. An operator's to fix. Never a 401.",
  no_answer: "The relayer gave no usable answer: what it did with the request is not known.",
  unavailable:
    "What the request needs is not available (no token keys, no identity provider). Nothing was done.",
  relayer_unavailable:
    "No relayer, no replica that could be used, or no price to charge by. The relayer signed nothing: the action may be built again.",
  upstream_not_reached:
    "A provider could not be connected to at all: it never received the request.",
  upstream_timeout: "A provider did not answer within the route's time limit.",
  response_timeout: "This API did not finish answering within 60 seconds.",
};

const ERROR_ROWS = (Object.keys(ERRORS) as ErrorCode[]).map(
  (code) => `| \`${code}\` | \`${ERRORS[code][0]}\` | ${MEANING[code]} |`,
);

const DESCRIPTION = [
  "The NoirWire API stands between the NoirWire wallets (web and mobile) and every outside service a wallet has to ask: the Solana RPC provider, Jupiter, MagicBlock's private payments, NoirWire's fee relayer, the price sources and NoirWire's analytics server. A wallet talks only to this API, so each of those services sees this server's address and never a user's next to the wallet addresses it is asked about.",
  "",
  "## Sessions",
  "",
  "Every `/v1` route except the two session routes requires `Authorization: Bearer <accessToken>`. A wallet gets a token from `POST /v1/session` and renews it at `POST /v1/session/refresh`.",
  "",
  "- **What a session proves:** that this API issued it and that it has not expired.",
  "- **What it does not prove:** anything about who holds it. It is not a login. It names no person, no wallet and no device; anyone can get one, and anyone can get another.",
  "- **When to start one:** only when a wallet has no session, or its session was refused as `session_expired` or `session_invalid`. Otherwise refresh: starting sessions is rationed far harder.",
  "- **What it is for:** counting. A session is a quota bucket, so limits can be kept per caller and not only per network address.",
  "- **How long it lasts:** an access token lives about an hour (`expiresAt`, Unix time in seconds). A session as a whole is refused after a maximum age (24 hours by default), on every route and at refresh, with a `401` whose code is `session_expired`. A token whose session age cannot be established is refused the same way. The wallet then starts a new, unrelated session, so the key that joins one wallet's requests together does not live long.",
  "- **Nothing that guards money depends on it.** The fee relayer's checks are made on the transaction itself and are the same for every caller: see `POST /v1/relayer`.",
  "",
  "## What contains wallet addresses, and who receives it",
  "",
  "| Route | Carries addresses | Passed to |",
  "| --- | --- | --- |",
  "| `POST /v1/rpc` | Yes: the address read, or a whole transaction | The RPC provider |",
  "| `POST /v1/jupiter/*` | Yes: the portfolio that trades or lends | Jupiter |",
  "| `GET /v1/jupiter/*` | No | Jupiter |",
  "| `POST /v1/private-payments/*` | Yes: the funding wallet and the portfolio together | MagicBlock |",
  "| `POST /v1/relayer` | Yes: the portfolio, its counterparty and the amount | NoirWire's relayer and its RPC provider |",
  "| `GET /v1/relayer` | No | Nobody |",
  "| `GET /v1/prices`, `GET /v1/history/...` | No | Jupiter, asked by this server on its own schedule, not per caller |",
  "| `POST /v1/events` | No: the closed event list has no field for one | NoirWire's analytics server |",
  "| `POST /v1/session`, `POST /v1/session/refresh` | No | The identity provider (Supabase Auth), asked by this server |",
  "",
  "A provider receives the request's content, a fixed user agent and this server's own credentials for it. It never receives the caller's IP address, token, session id, origin, referer, cookies or browser name. Coming back, only a status and a JSON body pass, up to a size cap per route; a provider's headers, and any body that is not JSON, never do.",
  "",
  "Each provider still learns what it is asked. The RPC provider sees every address read and every transaction sent, and all of one wallet's requests reach it from this server moments apart, so it can guess which addresses belong together by timing. MagicBlock sees both ends of a private transfer. This API removes the caller's network address from those pictures; it does not remove the pictures.",
  "",
  "## What this API logs and keeps",
  "",
  "- **Stored:** nothing. There is no database.",
  "- **Logged:** one line per request with the route's pattern, the status code and the duration, plus, for a refusal or an upstream failure, one fixed word. Never a token, a session id, an address, a transaction, an IP address, a request body or a query string.",
  "- **Held in memory:** counters keyed by session id and by client address, each for one minute (one hour for the hourly budgets), then dropped. Cached public market data.",
  "- **This server does see** every request in transit, including its addresses and the caller's IP. That it keeps none of it is a property of this code, which is published so it can be read.",
  "",
  "## Quotas and errors",
  "",
  "Each route counts a request three times, per minute: against the session, against the client address, and against a total for the route. When any is spent the answer is `429` with code `rate_limited` and nothing was done.",
  "",
  "The routes that reach the RPC provider and Jupiter are also held to what the provider allows this server's key: this server sends each provider fewer requests a second than that, requests wait briefly in a line per session, and the lines are served in turn, so one caller cannot spend the allowance for everyone. A request that would wait too long is answered `429 rate_limited` with a `Retry-After` header (in seconds). A provider's own `429` is passed on as `rate_limited` too. Retry with backoff. The numbers are stated on each route. Counters live in the memory of one process and are not hard limits.",
  "",
  "The client address is the one the hosting platform reports, never one a caller wrote: `X-Forwarded-For` is not read. One operator mechanism exists beside it and is not for third parties: the web app's own server, which forwards its pages' requests, proves itself with a shared secret in `X-NoirWire-Edge` and reports the browser's address in `X-NoirWire-Client-IP`. Without the matching secret both headers are ignored.",
  "",
  "Every answer is JSON (or empty), with a fixed JSON content type, and is never cacheable (`Cache-Control: no-store`).",
  "",
  "## Errors",
  "",
  "Every error this API writes has one shape, and nothing else in it: no stack trace, no provider message and nothing echoed from the request.",
  "",
  "```json",
  '{ "code": "rate_limited", "error": "Too many requests. Wait and try again." }',
  "```",
  "",
  "`code` is stable and is what a client acts on. `error` is a plain sentence for a person and may be reworded. Every code, and the one status it comes with:",
  "",
  "| Code | Status | Meaning |",
  "| --- | --- | --- |",
  ...ERROR_ROWS,
  "",
  '**A `401` means one thing only: the session token is not accepted here.** A wallet may therefore read a `401` on a submit as "nothing was sent". A provider that refuses this server\'s own credentials (it answers 401 or 403 to this server) is never passed on as a 401 or a 403: it is a `502` with code `upstream_refused`, and is logged as an operator error.',
  "",
  "A provider's own error body (a Jupiter quote that cannot be filled, a JSON-RPC error from the RPC provider) is not one of this API's errors: it is passed back as the provider wrote it, with the provider's status, provided it is JSON. The exceptions are a provider's `401` and `403` (see above) and its `429`, which becomes this API's `rate_limited`.",
  "",
  "## What no API can hide",
  "",
  "Everything a wallet does on Solana is public: balances, transfers, trades and the accounts involved can be read by anyone, for ever, whatever route the request took. This API keeps a user's network address away from the services that see their wallet addresses. It does not make on-chain activity private.",
  "",
  "All values in the examples are dummies.",
].join("\n");

/** The OpenAPI document. It depends on the code alone, never on configuration, so it can be committed. */
export function openApiDocument(app: INestApplication): OpenAPIObject {
  const options = new DocumentBuilder()
    .setTitle("NoirWire API")
    .setVersion("1")
    .setDescription(DESCRIPTION)
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "The `accessToken` from `POST /v1/session`. An anonymous session: a quota bucket, not an identity.",
      },
      SESSION_SCHEME,
    )
    .build();
  return SwaggerModule.createDocument(app, options);
}

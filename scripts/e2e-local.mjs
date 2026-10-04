// Proves the chain end to end against a running copy of this API and the
// local Supabase stack: a session is started through the API (which asks
// Supabase for an anonymous one), the token is used on a real route, the
// session is renewed, and a request without a token is refused.
//
//   npm run supabase:start
//   npm run build && npm run start:local     (in another terminal; or npm run dev)
//   npm run e2e:local
//
// Tokens are never printed.
const api = (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`).replace(
  /\/+$/,
  "",
);

async function call(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json };
}

function step(name, passed, detail) {
  console.log(`${passed ? "ok  " : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!passed) process.exitCode = 1;
  return passed;
}

const json = { "content-type": "application/json" };

const health = await call("/health").catch(() => null);
if (
  !step("GET /health", health?.status === 200, health ? `${health.status}` : `no API at ${api}`)
) {
  process.exit(1);
}

const refused = await call("/v1/prices");
step(
  "GET /v1/prices without a token is refused",
  refused.status === 401 && refused.json?.code === "unauthorized",
  `${refused.status} ${refused.json?.code}`,
);

const started = await call("/v1/session", { method: "POST" });
const session = started.json ?? {};
const startedOk =
  started.status === 200 &&
  typeof session.accessToken === "string" &&
  typeof session.refreshToken === "string" &&
  Number.isInteger(session.expiresAt);
if (
  !step(
    "POST /v1/session starts an anonymous session",
    startedOk,
    startedOk
      ? `expires in ${session.expiresAt - Math.floor(Date.now() / 1000)} s`
      : `${started.status} ${started.json?.code ?? ""} (is the local Supabase stack up?)`,
  )
) {
  process.exit(1);
}

const authorized = { authorization: `Bearer ${session.accessToken}` };
const prices = await call("/v1/prices", { headers: authorized });
const symbols = Object.keys(prices.json?.prices ?? {});
step(
  "GET /v1/prices with the session's token",
  prices.status === 200 && symbols.length > 0,
  prices.status === 200
    ? `${symbols.length} assets priced, age ${prices.headers.get("age")} s, SOL ${prices.json.prices.SOL?.usd}`
    : `${prices.status} ${prices.json?.code ?? ""}`,
);

const pins = await call("/v1/relayer", { headers: authorized });
step("GET /v1/relayer", pins.status === 200, `available: ${pins.json?.available}`);

const genesis = await call("/v1/rpc", {
  method: "POST",
  headers: { ...authorized, ...json },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash" }),
});
step(
  "POST /v1/rpc getGenesisHash",
  genesis.status === 200,
  `${genesis.json?.result ?? genesis.status}`,
);

const renewed = await call("/v1/session/refresh", {
  method: "POST",
  headers: json,
  body: JSON.stringify({ refreshToken: session.refreshToken }),
});
const renewedOk = renewed.status === 200 && renewed.json?.accessToken !== session.accessToken;
step("POST /v1/session/refresh renews the session", renewedOk, `${renewed.status}`);

if (renewedOk) {
  const again = await call("/v1/prices", {
    headers: { authorization: `Bearer ${renewed.json.accessToken}` },
  });
  step("GET /v1/prices with the renewed token", again.status === 200, `${again.status}`);
}

const forged = await call("/v1/prices", { headers: { authorization: "Bearer a.b.c" } });
step("a made-up token is refused", forged.status === 401, `${forged.status} ${forged.json?.code}`);

console.log(process.exitCode ? "\nThe chain is broken." : "\nThe chain holds end to end.");

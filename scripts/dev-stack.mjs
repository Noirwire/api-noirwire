// Starts, or stops, everything a wallet needs to talk to locally: the local
// Supabase stack (anonymous sessions) and this API on port 4000, on Solana
// devnet with the defaults in .env.example.
//
//   npm run dev:stack        start both, wait until the API answers, print the URLs
//   npm run dev:stack:stop   stop what the start left running
//
// The API runs in the background from a fresh build; its log is in
// .dev-stack/api.log. Only what this script started is stopped.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const stateDir = `${root}.dev-stack`;
const stateFile = `${stateDir}/state.json`;
const logFile = `${stateDir}/api.log`;
const PORT = 4000;
const API = `http://localhost:${PORT}`;
const SUPABASE = "http://127.0.0.1:54421";

const run = (command, args) =>
  spawnSync(command, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] }).status === 0;

const answers = async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok;
  } catch {
    return false;
  }
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readState = () =>
  existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;

async function start() {
  const previous = readState();
  if (previous?.pid && alive(previous.pid) && (await answers(`${API}/health`))) {
    console.log("The stack is already running.");
    return report();
  }
  if (await answers(`${API}/health`)) {
    console.error(`Something else is already answering on port ${PORT}. Stop it first.`);
    process.exit(1);
  }

  mkdirSync(stateDir, { recursive: true });
  const supabaseWasUp = await answers(`${SUPABASE}/auth/v1/health`);
  if (!supabaseWasUp) {
    console.log("Starting the local Supabase stack...");
    if (!run("npx", ["supabase", "start"])) process.exit(1);
  }

  console.log("Building the API...");
  if (!run("npm", ["run", "--silent", "build"])) process.exit(1);

  const log = openSync(logFile, "w");
  const api = spawn(process.execPath, ["--env-file=.env.example", "dist/main.js"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    env: { ...process.env, PORT: String(PORT) },
  });
  api.unref();
  writeFileSync(stateFile, JSON.stringify({ pid: api.pid, startedSupabase: !supabaseWasUp }));

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await answers(`${API}/health`)) return report();
    if (!alive(api.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error(`The API did not start. See ${logFile}:`);
  console.error(readFileSync(logFile, "utf8"));
  process.exit(1);
}

function report() {
  console.log(`
The NoirWire API is running on Solana devnet.

  API        ${API}
  Docs       ${API}/docs
  OpenAPI    ${API}/docs-json
  Supabase   ${SUPABASE}   (used by the API only; a wallet never calls it)
  Log        .dev-stack/api.log

  Start a session:  curl -s -X POST ${API}/v1/session
  Stop:             npm run dev:stack:stop
`);
}

function stop() {
  const state = readState();
  if (!state) {
    console.log("Nothing to stop: the stack was not started by `npm run dev:stack`.");
    return;
  }
  if (state.pid && alive(state.pid)) {
    process.kill(state.pid, "SIGTERM");
    console.log("Stopped the API.");
  }
  if (state.startedSupabase) {
    run("npx", ["supabase", "stop"]);
  } else {
    console.log("The Supabase stack was already running before the start, so it is left running.");
  }
  rmSync(stateDir, { recursive: true, force: true });
}

if (process.argv[2] === "stop") stop();
else await start();

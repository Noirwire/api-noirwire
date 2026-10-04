import { createApp } from "./app.js";
import type { Log } from "./common/core/log.js";
import { ConfigError, loadConfig, type Config } from "./config/core/config.js";

/** One JSON line per event, to standard output. See `LogLine` for the only fields there are. */
const log: Log = (line) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

function configOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    log({ event: "lifecycle", state: "config_refused" });
    // Names the variables that are wrong, never their values.
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : "Configuration refused."}\n`,
    );
    process.exit(1);
  }
}

const config = configOrExit();
const app = await createApp(config, log);
await app.listen(config.port, "0.0.0.0");
log({ event: "lifecycle", state: "listening" });

// The framework closes the server on these signals: it stops accepting
// connections and lets the requests in flight finish.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => log({ event: "lifecycle", state: "stopping" }));
}

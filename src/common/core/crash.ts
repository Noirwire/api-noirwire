import type { Log } from "./log.js";

/** Records that the process is going down and leaves with a failure code, so the supervisor starts it again. */
export function exitOnCrash(log: Log, exit: (code: number) => void): void {
  log({ event: "lifecycle", state: "crashed" });
  exit(1);
}

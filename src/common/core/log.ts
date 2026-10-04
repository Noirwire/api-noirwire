/**
 * The only things this service writes to its log. Every field is a fixed
 * word, a route pattern, a status code or a duration: never a token, a
 * session id, an address, a transaction, an IP, a body or a query string.
 * The type is what enforces it: there is no free-form field to put one in.
 */
export type LogLine =
  | { event: "request"; route: string; status: number; ms: number }
  /** A refusal or an upstream failure, as a fixed reason. */
  | { event: "refusal"; route: string; status: number; reason: string }
  /** Something an operator has to fix: a provider turned down this server's own credentials. */
  | { event: "operator_error"; route: string; status: number; reason: string }
  | { event: "error"; route: string; name: string }
  | { event: "lifecycle"; state: "listening" | "stopping" | "config_refused" };

export type Log = (line: LogLine) => void;

export const silentLog: Log = () => undefined;

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The address a request arrived from, as something this server can trust
 * reports it. Nothing a caller can write is ever read on its own word:
 * `x-forwarded-for` is a list any client can start with whatever it likes,
 * and is not read at all.
 *
 * - With no trusted proxy, the address is the socket's.
 * - With one (Railway's edge), it is the `x-real-ip` header, which Railway
 *   documents as the one "for identifying client's remote IP" and sets
 *   itself on every request it passes on. When that header is missing or is
 *   not an address, the request did not come the way it should have, and the
 *   address falls back to the socket's, never to another header.
 * - The web app's own server forwards its pages' requests, so those arrive
 *   from that server's address. When the operator has configured a shared
 *   secret and the request carries it in `x-noirwire-edge`, the address is
 *   the one that server reports in `x-noirwire-client-ip`. Without the
 *   matching secret that header is ignored like any other a caller wrote.
 */
export type ClientIpSource = {
  trustedProxyHops: 0 | 1;
  /** The secret the web app's edge code proves itself with, or null when there is none. */
  edgeSecret: string | null;
  socketAddress: string | undefined;
  header(name: string): string | undefined;
};

export const UNKNOWN_CLIENT = "unknown";
export const EDGE_SECRET_HEADER = "x-noirwire-edge";
export const EDGE_CLIENT_IP_HEADER = "x-noirwire-client-ip";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Whether `given` is `secret`, compared in the same time whatever was sent. */
function sameSecret(given: string | undefined, secret: string): boolean {
  return given !== undefined && timingSafeEqual(digest(given), digest(secret));
}

export function clientIp(source: ClientIpSource): string {
  if (
    source.edgeSecret !== null &&
    sameSecret(source.header(EDGE_SECRET_HEADER), source.edgeSecret)
  ) {
    const reported = rateKeyOf(source.header(EDGE_CLIENT_IP_HEADER));
    if (reported !== UNKNOWN_CLIENT) return reported;
  }
  const socket = rateKeyOf(source.socketAddress);
  if (source.trustedProxyHops === 0) return socket;
  const real = rateKeyOf(source.header("x-real-ip"));
  return real === UNKNOWN_CLIENT ? socket : real;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/** Expands an IPv6 address to its eight groups, or null when it is not one. */
function ipv6Groups(address: string): string[] | null {
  const [head, tail, ...rest] = address.split("::");
  if (rest.length > 0) return null;
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const left = groups(head);
  const right = groups(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 1) return null;
  const all = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  return all.every((group) => /^[0-9a-f]{1,4}$/i.test(group)) ? all : null;
}

/**
 * The key an address is counted under. An IPv4 address is itself. An IPv6
 * address is its /64: a single subscriber holds a whole /64, so counting
 * each of its addresses apart would give one person as many budgets as they
 * cared to use. Anything that is not an address is the shared unknown key.
 */
export function rateKeyOf(address: string | undefined): string {
  const value = address?.trim() ?? "";
  const mapped = IPV4_MAPPED.exec(value);
  const v4 = mapped ? mapped[1] : value;
  const octets = IPV4.exec(v4);
  if (octets) {
    return octets.slice(1).every((octet) => Number(octet) <= 255) ? v4 : UNKNOWN_CLIENT;
  }
  const zoneless = value.split("%")[0];
  const groups = ipv6Groups(zoneless);
  if (!groups) return UNKNOWN_CLIENT;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

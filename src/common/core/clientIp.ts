/**
 * The address a request arrived from, as the hosting platform reports it.
 *
 * `x-forwarded-for` is a list any client can start with whatever it likes,
 * so nothing a caller can choose is ever read. With no trusted proxy the
 * address is the socket's. With one (Railway's edge), it is the `x-real-ip`
 * header that edge sets, or failing that the last `x-forwarded-for` entry,
 * the hop that reached this server. A request that should have come through
 * the proxy and names neither is counted under one shared key.
 *
 * A request the web app's host forwards carries that host's address, not
 * the browser's. That is expected: limits are keyed on the session first.
 */
export type ClientIpSource = {
  trustedProxyHops: 0 | 1;
  socketAddress: string | undefined;
  header(name: string): string | undefined;
};

export const UNKNOWN_CLIENT = "unknown";

export function clientIp(source: ClientIpSource): string {
  if (source.trustedProxyHops === 0) return rateKeyOf(source.socketAddress);
  const real = source.header("x-real-ip")?.split(",")[0]?.trim();
  const lastHop = source.header("x-forwarded-for")?.split(",").at(-1)?.trim();
  return rateKeyOf(real || lastHop);
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

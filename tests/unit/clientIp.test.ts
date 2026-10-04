import { describe, expect, it } from "vitest";
import { clientIp, rateKeyOf, UNKNOWN_CLIENT } from "../../src/common/core/clientIp.js";

const SECRET = "an-edge-secret-of-at-least-32-characters";
const SOCKET = "10.0.0.9";

const from = (
  trustedProxyHops: 0 | 1,
  headers: Record<string, string>,
  options: { socketAddress?: string; edgeSecret?: string | null } = {},
) =>
  clientIp({
    trustedProxyHops,
    edgeSecret: options.edgeSecret ?? null,
    socketAddress: "socketAddress" in options ? options.socketAddress : SOCKET,
    header: (name) => headers[name],
  });

describe("the client address", () => {
  it("is the socket's when no proxy is trusted, whatever the headers claim", () => {
    const forged = { "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.8" };
    expect(from(0, forged, { socketAddress: "198.51.100.4" })).toBe("198.51.100.4");
    expect(from(0, forged, { socketAddress: "::ffff:198.51.100.4" })).toBe("198.51.100.4");
  });

  it("is the platform's x-real-ip behind its edge", () => {
    expect(from(1, { "x-real-ip": "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("never reads x-forwarded-for, first entry or last", () => {
    const headers = { "x-real-ip": "198.51.100.4", "x-forwarded-for": "192.0.2.1, 10.1.1.1" };
    expect(from(1, headers)).toBe("198.51.100.4");
    expect(from(1, { "x-forwarded-for": "192.0.2.1, 198.51.100.5" })).toBe(SOCKET);
    expect(from(0, { "x-forwarded-for": "192.0.2.1" })).toBe(SOCKET);
  });

  it("falls back to the socket when the trusted header is missing or is not an address", () => {
    expect(from(1, {})).toBe(SOCKET);
    expect(from(1, { "x-real-ip": "not an address" })).toBe(SOCKET);
    expect(from(1, { "x-real-ip": "999.1.1.1" })).toBe(SOCKET);
    expect(from(1, { "x-real-ip": "203.0.113.7, 203.0.113.8" })).toBe(SOCKET);
    expect(from(1, { "x-real-ip": "" })).toBe(SOCKET);
  });

  it("counts a request with no usable address at all under one shared key", () => {
    expect(from(1, {}, { socketAddress: undefined })).toBe(UNKNOWN_CLIENT);
    expect(from(0, {}, { socketAddress: undefined })).toBe(UNKNOWN_CLIENT);
  });
});

describe("the web app's edge", () => {
  const edge = (secret: string | undefined, ip: string | undefined) => ({
    ...(secret === undefined ? {} : { "x-noirwire-edge": secret }),
    ...(ip === undefined ? {} : { "x-noirwire-client-ip": ip }),
    "x-real-ip": "198.51.100.20",
  });

  it("may report the browser's address when it proves itself with the secret", () => {
    expect(from(1, edge(SECRET, "203.0.113.90"), { edgeSecret: SECRET })).toBe("203.0.113.90");
    expect(from(0, edge(SECRET, "203.0.113.90"), { edgeSecret: SECRET })).toBe("203.0.113.90");
    expect(from(1, edge(SECRET, "2001:db8:1:2::9"), { edgeSecret: SECRET })).toBe(
      "2001:db8:1:2::/64",
    );
  });

  it("is ignored without the secret, with a wrong one, or with one that only starts right", () => {
    for (const given of [
      undefined,
      "",
      "wrong",
      SECRET.slice(0, -1),
      `${SECRET}x`,
      SECRET.toUpperCase(),
    ]) {
      expect(from(1, edge(given, "203.0.113.90"), { edgeSecret: SECRET }), String(given)).toBe(
        "198.51.100.20",
      );
    }
  });

  it("is ignored entirely when no secret is configured, whatever the caller sends", () => {
    expect(from(1, edge(SECRET, "203.0.113.90"))).toBe("198.51.100.20");
    expect(from(1, edge("", "203.0.113.90"))).toBe("198.51.100.20");
    expect(from(0, edge("null", "203.0.113.90"))).toBe(SOCKET);
  });

  it("falls back to the platform's address when the secret is right and the reported address is not one", () => {
    expect(from(1, edge(SECRET, "not an address"), { edgeSecret: SECRET })).toBe("198.51.100.20");
    expect(from(1, edge(SECRET, undefined), { edgeSecret: SECRET })).toBe("198.51.100.20");
  });
});

describe("the key an address is counted under", () => {
  it("is the address itself for IPv4", () => {
    expect(rateKeyOf("192.0.2.10")).toBe("192.0.2.10");
    expect(rateKeyOf(" 192.0.2.10 ")).toBe("192.0.2.10");
  });

  it("is the /64 for IPv6, so one subscriber is one key", () => {
    const first = rateKeyOf("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
    expect(first).toBe("2001:db8:1234:5678::/64");
    expect(rateKeyOf("2001:0DB8:1234:5678::1")).toBe(first);
    expect(rateKeyOf("2001:db8:1234:5679::1")).not.toBe(first);
    expect(rateKeyOf("::1")).toBe("0:0:0:0::/64");
    expect(rateKeyOf("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("is the shared unknown key for anything that is not an address", () => {
    for (const value of [undefined, "", "abc", "1.2.3", "1:2:3", "::g", "1::2::3"]) {
      expect(rateKeyOf(value)).toBe(UNKNOWN_CLIENT);
    }
  });
});

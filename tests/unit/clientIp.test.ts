import { describe, expect, it } from "vitest";
import { clientIp, rateKeyOf, UNKNOWN_CLIENT } from "../../src/common/core/clientIp.js";

const from = (
  trustedProxyHops: 0 | 1,
  headers: Record<string, string>,
  socketAddress: string | undefined = "10.0.0.9",
) => clientIp({ trustedProxyHops, socketAddress, header: (name) => headers[name] });

describe("the client address", () => {
  it("is the socket's when no proxy is trusted, whatever the headers claim", () => {
    const forged = { "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.8" };
    expect(from(0, forged, "198.51.100.4")).toBe("198.51.100.4");
    expect(from(0, forged, "::ffff:198.51.100.4")).toBe("198.51.100.4");
  });

  it("is the platform's x-real-ip behind its edge", () => {
    expect(from(1, { "x-real-ip": "203.0.113.7" })).toBe("203.0.113.7");
  });

  it("counts by the platform's address, whatever the caller puts first in x-forwarded-for", () => {
    const headers = { "x-real-ip": "198.51.100.4", "x-forwarded-for": "192.0.2.1, 10.1.1.1" };
    expect(from(1, headers)).toBe("198.51.100.4");
  });

  it("falls back to the last x-forwarded-for hop, never the first", () => {
    expect(from(1, { "x-forwarded-for": "192.0.2.1, 198.51.100.5" })).toBe("198.51.100.5");
  });

  it("counts a request that names no address under one shared key", () => {
    expect(from(1, {})).toBe(UNKNOWN_CLIENT);
    expect(
      clientIp({ trustedProxyHops: 0, socketAddress: undefined, header: () => undefined }),
    ).toBe(UNKNOWN_CLIENT);
    expect(from(1, { "x-real-ip": "not an address" })).toBe(UNKNOWN_CLIENT);
    expect(from(1, { "x-real-ip": "999.1.1.1" })).toBe(UNKNOWN_CLIENT);
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

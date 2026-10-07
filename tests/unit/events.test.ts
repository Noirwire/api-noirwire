import { describe, expect, it } from "vitest";
import type { AnalyticsConfig } from "../../src/config/core/config.js";
import { forwardedEvent, visitorCode } from "../../src/events/core/forward.js";
import { cleanEvent, isOnChain } from "../../src/events/core/usageEvents.js";

describe("cleanEvent", () => {
  it("passes a page view and a listed event with listed values", () => {
    expect(cleanEvent({ path: "/markets/:symbol", display: "390x844" })).toEqual({
      path: "/markets/:symbol",
      display: "390x844",
    });
    expect(
      cleanEvent({ path: "/portfolios/:id", name: "account_created", data: { kind: "pie" } }),
    ).toEqual({ path: "/portfolios/:id", name: "account_created", data: { kind: "pie" } });
  });

  it("refuses a path that still carries a portfolio id or a query", () => {
    expect(cleanEvent({ path: "/portfolios/acc_k3j2h1g0" })).toBeNull();
    expect(cleanEvent({ path: "/portfolio?next=/x" })).toBeNull();
    expect(cleanEvent({ path: "/markets/NVDAx" })).toBeNull();
  });

  it("refuses anything free-form: unknown events, extra fields, unlisted values", () => {
    const base = { path: "/portfolio" };
    expect(cleanEvent({ ...base, name: "anything_else" })).toBeNull();
    expect(cleanEvent({ ...base, name: "sent", data: { to: "9xQe...address" } })).toBeNull();
    expect(cleanEvent({ ...base, name: "watchlist_toggled" })).not.toBeNull();
    for (const symbol of ["9xQe", "SPYx", "NVDAx"]) {
      expect(cleanEvent({ ...base, name: "watchlist_toggled", data: { symbol } })).toBeNull();
    }
    expect(cleanEvent({ ...base, data: { note: "no name" } })).toBeNull();
    expect(cleanEvent({ ...base, visitor: "3f1c2a9e-5b7d-4c1e-9a2f-0d6b8e4c7a11" })).toBeNull();
  });

  it("counts a labels sync by where it stopped, and by nothing about the record", () => {
    const base = { path: "/portfolio" };
    expect(cleanEvent({ ...base, name: "profile_synced" })).not.toBeNull();
    expect(
      cleanEvent({ ...base, name: "profile_sync_failed", data: { stage: "config" } }),
    ).not.toBeNull();
    expect(
      cleanEvent({ ...base, name: "profile_sync_failed", data: { stage: "elsewhere" } }),
    ).toBeNull();
    expect(cleanEvent({ ...base, name: "profile_synced", data: { revision: 4 } })).toBeNull();
    expect(isOnChain("profile_synced")).toBe(true);
  });

  it("refuses what is not an event at all", () => {
    for (const input of [null, undefined, "text", 7, [], {}, { path: 7 }, { name: "sent" }]) {
      expect(cleanEvent(input)).toBeNull();
    }
    expect(cleanEvent({ path: "/", name: "constructor" })).toBeNull();
    expect(cleanEvent({ path: "/", name: "toString" })).toBeNull();
  });

  it("drops a display that is not a size, and keeps the event", () => {
    expect(cleanEvent({ path: "/", display: "a wallet address" })).toEqual({ path: "/" });
    expect(cleanEvent({ path: "/", display: 390 })).toEqual({ path: "/" });
  });

  it("gives a trade no room for an asset or a size, before or after signing", () => {
    const base = { path: "/portfolios/:id" };
    for (const name of ["trade_quoted", "trade_placed"]) {
      expect(cleanEvent({ ...base, name, data: { side: "buy" } })).not.toBeNull();
      expect(cleanEvent({ ...base, name, data: { side: "buy", symbol: "SPYx" } })).toBeNull();
      expect(cleanEvent({ ...base, name, data: { side: "buy", size: "10 to 100" } })).toBeNull();
    }
  });

  it("passes the unlock snapshot as bands and yes/no answers, never an exact count", () => {
    const state = {
      age: "8-30d",
      accounts: "2+",
      pies: "1",
      trades: "2-5",
      funded: "yes",
      invested: "yes",
      has_funded: "yes",
      has_traded: "yes",
    };
    expect(cleanEvent({ path: "/", name: "wallet_unlocked", data: state })?.data).toEqual(state);
    expect(
      cleanEvent({ path: "/", name: "wallet_unlocked", data: { ...state, trades: 37 } }),
    ).toBeNull();
    const { age: _age, ...missing } = state;
    expect(cleanEvent({ path: "/", name: "wallet_unlocked", data: missing })).toBeNull();
  });

  it("keeps where a visit came from only as listed names", () => {
    const sent = { path: "/", arrival: { source: "reddit", medium: "social", campaign: "launch" } };
    expect(cleanEvent(sent)?.arrival).toEqual(sent.arrival);
    expect(cleanEvent({ path: "/", arrival: { source: "alice-7f3a" } })?.arrival).toBeUndefined();
    expect(cleanEvent({ path: "/", arrival: { campaign: "for-alice" } })?.arrival).toBeUndefined();
    expect(cleanEvent({ path: "/", name: "wallet_created", arrival: sent.arrival })).toBeNull();
  });
});

describe("isOnChain", () => {
  it("marks what lands on chain, and nothing before signing", () => {
    expect(isOnChain("trade_placed")).toBe(true);
    expect(isOnChain("private_funding_arrived")).toBe(true);
    expect(isOnChain("trade_failed")).toBe(true);
    expect(isOnChain("trade_quoted")).toBe(false);
    expect(isOnChain("trade_reviewed")).toBe(false);
    expect(isOnChain("wallet_unlocked")).toBe(false);
  });
});

describe("forwarding an event", () => {
  const analytics: AnalyticsConfig = {
    url: "https://stats.example.com",
    website: "site-id",
    hostname: "app.example.com",
    salt: "server-only-secret",
  };
  const from = { sessionId: "session-abc", browser: "Mozilla/5.0 (iPhone) Safari/605" };
  const now = Date.parse("2026-10-04T12:00:00Z");
  const forward = (event: unknown, over: Partial<AnalyticsConfig> = {}) => {
    const forwarded = forwardedEvent(JSON.stringify(event), from, { ...analytics, ...over }, now);
    return forwarded && { ...forwarded, body: JSON.parse(forwarded.body) };
  };

  it("sends a screen view with the site's host, the browser and a visitor code", () => {
    expect(forward({ path: "/markets/:symbol", display: "390x844" })).toEqual({
      url: "https://stats.example.com/api/send",
      headers: { "Content-Type": "application/json", "User-Agent": from.browser },
      body: {
        type: "event",
        payload: {
          website: "site-id",
          hostname: "app.example.com",
          url: "/markets/:symbol",
          title: "NoirWire",
          id: visitorCode("server-only-secret", "session-abc", now),
          screen: "390x844",
        },
      },
    });
  });

  it("never sends the session id itself, only a keyed code that changes every month", () => {
    const code = visitorCode("server-only-secret", "session-abc", now)!;
    expect(code).toMatch(/^[0-9a-f]{48}$/);
    expect(JSON.stringify(forward({ path: "/" }))).not.toContain("session-abc");
    expect(visitorCode("server-only-secret", "session-abc", now + 1_000)).toBe(code);
    expect(visitorCode("server-only-secret", "session-abc", now + 40 * 86_400_000)).not.toBe(code);
    expect(visitorCode("server-only-secret", "session-xyz", now)).not.toBe(code);
    expect(visitorCode("another-secret", "session-abc", now)).not.toBe(code);
  });

  it("sends no visitor code at all without the secret", () => {
    expect(visitorCode(null, "session-abc", now)).toBeNull();
    expect(forward({ path: "/" }, { salt: null })?.body.payload).not.toHaveProperty("id");
  });

  it("forwards an on-chain event with no visitor code, no browser and no display", () => {
    const forwarded = forward({
      path: "/portfolios/:id",
      display: "390x844",
      name: "trade_placed",
      data: { side: "buy" },
    });
    expect(forwarded?.headers["User-Agent"]).toBe("Mozilla/5.0 (compatible; NoirWire)");
    expect(forwarded?.body.payload).toEqual({
      website: "site-id",
      hostname: "app.example.com",
      url: "/portfolios/:id",
      title: "NoirWire",
      name: "trade_placed",
      data: { side: "buy" },
    });
  });

  it("puts campaign tags back on the URL the analytics server reads them from", () => {
    const forwarded = forward({ path: "/", arrival: { source: "x", campaign: "launch" } });
    expect(forwarded?.body.payload.url).toBe("/?utm_source=x&utm_campaign=launch");
  });

  it("forwards nothing for a body that is not a listed event", () => {
    expect(forwardedEvent("not json", from, analytics, now)).toBeNull();
    expect(forward({ path: "/portfolios/acc_1" })).toBeNull();
    expect(forward({ path: "/", name: "sent", data: { to: "address" } })).toBeNull();
  });

  it("uses a neutral browser name when the caller sent none, and bounds a long one", () => {
    const quiet = forwardedEvent(
      '{"path":"/"}',
      { sessionId: "s", browser: undefined },
      analytics,
      now,
    );
    expect(quiet?.headers["User-Agent"]).toBe("Mozilla/5.0 (compatible; NoirWire)");
    const long = forwardedEvent(
      '{"path":"/"}',
      { sessionId: "s", browser: "x".repeat(5_000) },
      analytics,
      now,
    );
    expect(long?.headers["User-Agent"]).toHaveLength(512);
  });
});

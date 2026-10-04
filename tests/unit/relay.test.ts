import { describe, expect, it, vi } from "vitest";
import type { LogLine } from "../../src/common/core/log.js";
import { createRelay } from "../../src/common/core/relay.js";

const URL_ = "https://provider.example/rpc";
const ADDRESS = "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ";

type Sent = { url: string; method: string; headers: Record<string, string>; body?: string };

function setup(reply: (init: RequestInit) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const logged: LogLine[] = [];
  const relay = createRelay({
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({
        url,
        method: init.method ?? "GET",
        headers: Object.fromEntries(new Headers(init.headers)),
        body: init.body as string | undefined,
      });
      return reply(init);
    }) as unknown as typeof fetch,
    log: (line) => void logged.push(line),
  });
  return { relay, sent, logged };
}

const init = { method: "POST" as const, body: `{"address":"${ADDRESS}"}`, maxResponseBytes: 1_024 };

describe("the relay", () => {
  it("sends the body and nothing of anyone's request: three headers it wrote itself", async () => {
    const { relay, sent } = setup(() => Response.json({ result: 1 }));
    const answer = await relay("rpc", URL_, init);
    expect(answer).toEqual({ status: 200, body: '{"result":1}' });
    expect(sent).toEqual([
      {
        url: URL_,
        method: "POST",
        body: init.body,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 (compatible; NoirWire)",
        },
      },
    ]);
  });

  it("adds only the headers the route itself supplies, and no content type to a GET", async () => {
    const { relay, sent } = setup(() => Response.json({}));
    await relay("jupiter", URL_, {
      method: "GET",
      headers: { "x-api-key": "server-key" },
      maxResponseBytes: 1_024,
    });
    expect(sent[0].headers).toEqual({
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (compatible; NoirWire)",
      "x-api-key": "server-key",
    });
    expect(sent[0].body).toBeUndefined();
  });

  it("passes back the status and the JSON body, and no upstream header at all", async () => {
    const { relay } = setup(
      () =>
        new Response('{"error":"busy"}', {
          status: 503,
          headers: { "content-type": "text/plain", "set-cookie": "provider=1" },
        }),
    );
    expect(await relay("rpc", URL_, init)).toEqual({ status: 503, body: '{"error":"busy"}' });
  });

  it("passes an empty answer back as an empty answer", async () => {
    const { relay } = setup(() => new Response(null, { status: 204 }));
    expect(await relay("rpc", URL_, init)).toEqual({ status: 204, body: null });
  });

  it("never passes a provider's 401 or 403 on: it is a 502, and an operator's to fix", async () => {
    for (const status of [401, 403]) {
      const { relay, logged } = setup(() =>
        Response.json({ error: "invalid api key" }, { status }),
      );
      const answer = await relay("jupiter", URL_, init);
      expect(answer.status).toBe(502);
      expect(JSON.parse(answer.body!)).toEqual({
        code: "upstream_refused",
        error: "The provider refused this server's own credentials.",
      });
      expect(logged).toEqual([
        {
          event: "operator_error",
          route: "jupiter",
          status,
          reason: "upstream_refused_credentials",
        },
      ]);
    }
  });

  it("gives every failure its own code", async () => {
    const codeOf = async (reply: () => Response) =>
      JSON.parse((await setup(reply).relay("rpc", URL_, init)).body!).code;
    expect(await codeOf(() => new Response("<html>"))).toBe("upstream_failed");
    expect(
      await codeOf(() => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }),
    ).toBe("upstream_not_reached");
    expect(
      await codeOf(() => {
        throw new TypeError("fetch failed");
      }),
    ).toBe("upstream_failed");
  });

  it("never passes on a provider's HTML: it becomes a fixed JSON 502", async () => {
    const page = "<!doctype html><script>fetch('https://evil.example')</script>";
    const { relay, logged } = setup(
      () => new Response(page, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const answer = await relay("rpc", URL_, init);
    expect(answer.status).toBe(502);
    expect(answer.body).not.toContain("<");
    expect(JSON.parse(answer.body!)).toEqual({
      code: "upstream_failed",
      error: "The provider did not give a usable answer.",
    });
    expect(logged).toEqual([
      { event: "refusal", route: "rpc", status: 502, reason: "upstream_answer_not_json" },
    ]);
  });

  it("passes a provider's rate limit on as 429, so the wallet waits and retries", async () => {
    const { relay, logged } = setup(() => new Response("Too Many Requests", { status: 429 }));
    const answer = await relay("rpc", URL_, init);
    expect(answer.status).toBe(429);
    expect(JSON.parse(answer.body!).code).toBe("rate_limited");
    expect(logged[0]).toMatchObject({ status: 429, reason: "upstream_rate_limit" });
  });

  it("answers 502 to an upstream body past the ceiling, without reading the rest", async () => {
    let pulls = 0;
    const megabyte = new Uint8Array(1024 * 1024).fill(0x20);
    const { relay } = setup(
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulls += 1;
                controller.enqueue(megabyte);
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    const answer = await relay("rpc", URL_, { ...init, maxResponseBytes: 4 * 1024 * 1024 });
    expect(answer.status).toBe(502);
    expect(pulls).toBeLessThanOrEqual(6);
  });

  it("answers 504 when the provider does not, and logs nothing about the request", async () => {
    vi.useFakeTimers();
    try {
      const { relay, logged } = setup(
        (sent) =>
          new Promise((_resolve, reject) => {
            sent.signal!.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const pending = relay("rpc", URL_, init);
      await vi.advanceTimersByTimeAsync(31_000);
      expect((await pending).status).toBe(504);
      expect(logged).toEqual([
        { event: "refusal", route: "rpc", status: 504, reason: "upstream_timed_out" },
      ]);
      expect(JSON.stringify(logged)).not.toContain(ADDRESS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits only as long as the route says for an upstream with a stand-in", async () => {
    vi.useFakeTimers();
    try {
      const { relay } = setup(
        (sent) =>
          new Promise((_resolve, reject) => {
            sent.signal!.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const pending = relay("relayer", URL_, { ...init, timeoutMs: 8_000 });
      await vi.advanceTimersByTimeAsync(8_100);
      expect((await pending).status).toBe(504);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells an upstream that was never reached (503) from one whose connection broke (502)", async () => {
    const failing = (code: string) =>
      setup(() => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
      }).relay("rpc", URL_, init);
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]) {
      expect((await failing(code)).status).toBe(503);
    }
    expect((await failing("ECONNRESET")).status).toBe(502);
    expect((await failing("UND_ERR_SOCKET")).status).toBe(502);
  });

  it("does not follow a provider's redirect to somewhere else", async () => {
    const { relay, sent } = setup((sentInit) => {
      expect(sentInit.redirect).toBe("error");
      return Response.json({});
    });
    await relay("rpc", URL_, init);
    expect(sent).toHaveLength(1);
  });
});

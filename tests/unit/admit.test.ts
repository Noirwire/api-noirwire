import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { admit, type Admitted } from "../../src/common/core/admit.js";
import { createMemoryQuotaStore, MINUTE_MS, type Budget } from "../../src/common/core/quota.js";

const budgets = (limit = 100): Budget[] => [
  { scope: "session", key: "rpc|s", limit, windowMs: MINUTE_MS },
];
const statusAndCode = (admitted: Admitted) =>
  "refused" in admitted
    ? [admitted.refused.status, JSON.parse(admitted.refused.body!).code]
    : "admitted";
const bodyOf = (text: string) => Readable.from([Buffer.from(text)]);

/** A request body that arrives in pieces, as `next` hands them out. Counts what was asked for. */
function streamed(next: (pulls: number) => Uint8Array | null | "wait") {
  const seen = { pulls: 0 };
  const body = new Readable({
    highWaterMark: 1,
    read() {
      seen.pulls += 1;
      const chunk = next(seen.pulls);
      if (chunk === "wait") return;
      this.push(chunk);
    },
  });
  return { body, seen };
}

describe("admitting a request", () => {
  it("hands over the body of a request under its limits", async () => {
    const admitted = await admit(
      { contentLength: "7", body: bodyOf('{"a":1}') },
      { budgets: budgets(), maxBodyBytes: 64 },
      createMemoryQuotaStore(),
    );
    expect(admitted).toEqual({ body: '{"a":1}' });
  });

  it("refuses a request past its budget before reading any of its body", async () => {
    const quotas = createMemoryQuotaStore();
    const rule = { budgets: budgets(1), maxBodyBytes: 64 };
    await admit({ contentLength: "2", body: bodyOf("{}") }, rule, quotas);
    const { body, seen } = streamed(() => Buffer.from("{}"));
    const second = await admit({ contentLength: "2", body }, rule, quotas);
    expect(statusAndCode(second)).toEqual([429, "rate_limited"]);
    expect(seen.pulls).toBe(0);
  });

  it("refuses a body its content-length says is too large, without reading it", async () => {
    const { body, seen } = streamed(() => Buffer.alloc(1024));
    const admitted = await admit(
      { contentLength: "70000", body },
      { budgets: budgets(), maxBodyBytes: 65_536 },
      createMemoryQuotaStore(),
    );
    expect(statusAndCode(admitted)).toEqual([413, "request_too_large"]);
    expect(seen.pulls).toBe(0);
  });

  it("stops reading a streamed body the moment it passes the limit, whatever its length claimed", async () => {
    const kilobyte = new Uint8Array(1024).fill(0x41);
    const { body, seen } = streamed(() => kilobyte);
    const admitted = await admit(
      { contentLength: undefined, body },
      { budgets: budgets(), maxBodyBytes: 64 * 1024 },
      createMemoryQuotaStore(),
    );
    expect("refused" in admitted && admitted.refused.status).toBe(413);
    // 64 KB allowed: the read ends at the first piece past it, not at the end of the stream.
    expect(seen.pulls).toBeLessThanOrEqual(68);
    expect(body.isPaused()).toBe(true);
  });

  it("gives up on a body that does not arrive", async () => {
    const { body } = streamed((pulls) => (pulls === 1 ? new Uint8Array([0x7b]) : "wait"));
    const admitted = await admit(
      { contentLength: undefined, body },
      { budgets: budgets(), maxBodyBytes: 64 },
      createMemoryQuotaStore(),
      50,
    );
    expect(statusAndCode(admitted)).toEqual([408, "request_timeout"]);
  });

  it("answers 400 to a body that breaks off", async () => {
    const body = new Readable({
      read() {
        this.destroy(new Error("aborted by the client"));
      },
    });
    const admitted = await admit(
      { contentLength: undefined, body },
      { budgets: budgets(), maxBodyBytes: 64 },
      createMemoryQuotaStore(),
    );
    expect(statusAndCode(admitted)).toEqual([400, "invalid_request"]);
  });

  it("takes no body at all on a route that reads none", async () => {
    const rule = { budgets: budgets(), maxBodyBytes: 0 };
    const empty = await admit(
      { contentLength: undefined, body: bodyOf("") },
      rule,
      createMemoryQuotaStore(),
    );
    expect(empty).toEqual({ body: "" });
    const some = await admit(
      { contentLength: "1", body: bodyOf("x") },
      rule,
      createMemoryQuotaStore(),
    );
    expect("refused" in some && some.refused.status).toBe(413);
  });
});

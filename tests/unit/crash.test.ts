import { describe, expect, it } from "vitest";
import { exitOnCrash } from "../../src/common/core/crash.js";
import type { LogLine } from "../../src/common/core/log.js";

describe("a crash", () => {
  it("is logged as a fixed word and ends the process with a failure code", () => {
    const logged: LogLine[] = [];
    const codes: number[] = [];
    exitOnCrash(
      (line) => void logged.push(line),
      (code) => void codes.push(code),
    );
    expect(logged).toEqual([{ event: "lifecycle", state: "crashed" }]);
    expect(codes).toEqual([1]);
  });
});

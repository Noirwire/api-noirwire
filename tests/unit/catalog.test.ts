import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { base58 } from "../../src/chain/core/bytes.js";
import { ALL_STOCKS } from "../../src/chain/core/tokenRegistry.js";

/**
 * The listed trackers are a copy of the catalog the wallets ship in
 * @noirwire/shared. The catalog lives in that package's infrastructure
 * entry, which loads the wallet's key handling with it, so this server
 * carries a copy and this test fails the moment the two differ. To fix it,
 * copy the package's file over src/chain/core/stocks.generated.json.
 */
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown[];

describe("the listed trackers", () => {
  it("are exactly the catalog the installed @noirwire/shared ships", () => {
    const shared = read(
      "node_modules/@noirwire/shared/dist/infrastructure/solana/stocks.generated.json",
    );
    expect(read("src/chain/core/stocks.generated.json")).toEqual(shared);
    expect(ALL_STOCKS).toHaveLength(shared.length);
  });
});

describe("base58", () => {
  it("writes bytes as Solana writes an address or a transaction id", () => {
    for (const stock of ALL_STOCKS.slice(0, 5)) {
      expect(base58(stock.mint.toBytes())).toBe(stock.mint.toBase58());
    }
    expect(base58(new Uint8Array(32))).toBe("11111111111111111111111111111111");
    expect(base58(new Uint8Array([0, 0, 1]))).toBe("112");
    expect(base58(new Uint8Array(0))).toBe("");
  });
});

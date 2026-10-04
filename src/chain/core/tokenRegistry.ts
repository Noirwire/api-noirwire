import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import generatedStocks from "./stocks.generated.json" with { type: "json" };

/**
 * Every tokenized stock (tracker) the wallets can hold. The list is the one
 * the wallets ship (`stocks.generated.json` in @noirwire/shared), copied here
 * as committed data: nothing fetches it at runtime. It decides which tokens
 * the relayer pays to send, which prices are read and which charts exist, so
 * the two copies have to be kept the same: a test fails when this one
 * differs from the installed package's.
 *
 * These are mainnet mints, all Token-2022, and have no devnet counterpart.
 */
export type StockDefinition = {
  symbol: string;
  mint: PublicKey;
  decimals: number;
  programId: PublicKey;
};

const STOCKS: StockDefinition[] = generatedStocks.map((entry) => ({
  symbol: entry.symbol,
  mint: new PublicKey(entry.mint),
  decimals: entry.decimals,
  programId: TOKEN_2022_PROGRAM_ID,
}));

/** Listed and retired alike: a held stock keeps its price and its history, and can still be sent. */
export const ALL_STOCKS: readonly StockDefinition[] = STOCKS;

const STOCK_BY_SYMBOL = new Map(STOCKS.map((stock) => [stock.symbol, stock]));
const STOCK_BY_LOWERCASE = new Map(STOCKS.map((stock) => [stock.symbol.toLowerCase(), stock]));
const STOCK_BY_MINT = new Map(STOCKS.map((stock) => [stock.mint.toBase58(), stock]));

/** The tracker a symbol names, however it was typed: "nvdax" and "NVDAx" both find NVDAx. */
export function stockBySymbol(symbol: string): StockDefinition | undefined {
  return STOCK_BY_SYMBOL.get(symbol) ?? STOCK_BY_LOWERCASE.get(symbol.trim().toLowerCase());
}

export function stockByMint(mint: string): StockDefinition | undefined {
  return STOCK_BY_MINT.get(mint);
}

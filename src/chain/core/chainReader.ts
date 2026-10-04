import type { PublicKey } from "@solana/web3.js";

/**
 * The two chain reads this server makes for itself, through its own RPC
 * provider: an account's data (Pyth's price account, a mint) and the rent of
 * an account of a given size. A web3.js `Connection` satisfies it.
 */
export type ChainAccount = { owner: PublicKey; data: Uint8Array };

export type ChainReader = {
  getAccountInfo(address: PublicKey, commitment: "confirmed"): Promise<ChainAccount | null>;
  getMinimumBalanceForRentExemption(bytes: number): Promise<number>;
};

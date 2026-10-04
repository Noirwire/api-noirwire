import { PublicKey } from "@solana/web3.js";

/**
 * Chain configuration. One value, the network, decides the USDC mint, so a
 * half-flipped deploy (a mainnet RPC with the devnet mint) cannot be
 * expressed. Nothing else in this repository hardcodes a cluster or the mint.
 */
export type Network = "mainnet" | "devnet";

const USDC_MINT: Record<Network, string> = {
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

/** The public devnet RPC, for a devnet server with no provider of its own. Mainnet has none, on purpose. */
export const DEVNET_RPC_URL = "https://api.devnet.solana.com";

export function usdcMint(network: Network): string {
  return USDC_MINT[network];
}

const mintKeys = new Map<Network, PublicKey>();

/** The USDC mint as a key, one object per network. */
export function usdcMintKey(network: Network): PublicKey {
  let key = mintKeys.get(network);
  if (!key) {
    key = new PublicKey(USDC_MINT[network]);
    mintKeys.set(network, key);
  }
  return key;
}

export function isAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

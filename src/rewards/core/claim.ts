import { claimOpen, seasonWeekAt } from "./weeks.js";

/**
 * What a claimed trade is worth, read from the transaction as the chain
 * recorded it and from nothing the caller says.
 *
 * The fee of a NoirWire trade is paid, by Jupiter, into the USDC token
 * account of NoirWire's referral account. In a transaction's own token
 * balances that account appears as an entry whose `owner` is the referral
 * account and whose `mint` is USDC, before and after. The fee is how much
 * it grew by.
 */

/** One entry of a transaction's token balances, as the RPC writes it. */
export type TokenBalance = {
  /** The position of the token account among the transaction's accounts. */
  accountIndex: number;
  mint: string;
  /** The key that controls the token account. */
  owner: string | null;
  /** The balance in the token's smallest unit. */
  amount: bigint;
};

/** A finalized transaction, as much of it as a claim is checked against. */
export type ChainTransaction = {
  succeeded: boolean;
  /** When its block was produced, in Unix seconds. */
  blockTime: number;
  signers: string[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
};

/** How much USDC the token accounts of `referralAccount` gained in the transaction, in micro-USDC. Never negative. */
export function referralFee(
  transaction: ChainTransaction,
  referralAccount: string,
  usdcMint: string,
): bigint {
  let fee = 0n;
  for (const after of transaction.postTokenBalances) {
    if (after.owner !== referralAccount || after.mint !== usdcMint) continue;
    // An account opened by this very transaction has no entry before it: it held nothing.
    const before = transaction.preTokenBalances.find(
      (entry) => entry.accountIndex === after.accountIndex && entry.mint === usdcMint,
    );
    fee += after.amount - (before?.amount ?? 0n);
  }
  return fee > 0n ? fee : 0n;
}

/** Why a transaction earns nothing. Each is one of this API's error codes. */
export type ClaimRefusal =
  "transaction_failed" | "not_a_signer" | "no_referral_fee" | "outside_claim_window";

export type ClaimReading =
  { ok: true; week: number; feeMicroUsdc: bigint } | { ok: false; code: ClaimRefusal };

export type ClaimTerms = {
  portfolio: string;
  referralAccount: string;
  usdcMint: string;
  seasonStartMs: number;
  nowMs: number;
};

/** The week and the fee a transaction is credited with, or why it is not. */
export function readClaim(transaction: ChainTransaction, terms: ClaimTerms): ClaimReading {
  if (!transaction.succeeded) return { ok: false, code: "transaction_failed" };
  if (!transaction.signers.includes(terms.portfolio)) return { ok: false, code: "not_a_signer" };
  const feeMicroUsdc = referralFee(transaction, terms.referralAccount, terms.usdcMint);
  if (feeMicroUsdc === 0n) return { ok: false, code: "no_referral_fee" };
  const week = seasonWeekAt(terms.seasonStartMs, transaction.blockTime * 1_000);
  if (week === null || !claimOpen(terms.seasonStartMs, week, terms.nowMs)) {
    return { ok: false, code: "outside_claim_window" };
  }
  return { ok: true, week, feeMicroUsdc };
}

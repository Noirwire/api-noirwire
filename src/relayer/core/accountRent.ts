import {
  ACCOUNT_SIZE,
  ExtensionType,
  getAccountLen,
  getExtensionTypes,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
} from "@solana/spl-token";
import type { AccountInfo, PublicKey } from "@solana/web3.js";
import { Buffer } from "node:buffer";
import type { ChainReader } from "../../chain/core/chainReader.js";

/**
 * What it costs the relayer to open a token account for a mint: the rent of
 * an account of the size that mint really needs, read from the chain.
 *
 * A Token-2022 account is not a fixed size. The mint's extensions decide
 * which extensions each of its accounts must carry, so two mints under the
 * same program can need accounts of different sizes, and an issuer can add
 * an extension later. A constant would let a larger account be opened at the
 * relayer's expense for the price of a smaller one.
 */

/**
 * The extensions the token program gives every account of a mint that
 * carries the one on the left. This is the program's own rule for sizing a
 * new account, which is what the relayer is charged rent on. The client
 * library's helper is not used for it: it also counts a confidential
 * transfer extension that an account only gains when its owner asks for it,
 * and comes out far too large.
 */
const ACCOUNT_EXTENSION_FOR: [mint: ExtensionType, account: ExtensionType][] = [
  [ExtensionType.TransferFeeConfig, ExtensionType.TransferFeeAmount],
  [ExtensionType.NonTransferable, ExtensionType.NonTransferableAccount],
  [ExtensionType.TransferHook, ExtensionType.TransferHookAccount],
  [ExtensionType.PausableConfig, ExtensionType.PausableAccount],
];

/** The size of an associated token account for a mint carrying `mintExtensions`. */
export function associatedAccountLen(programId: PublicKey, mintExtensions: ExtensionType[]) {
  if (!programId.equals(TOKEN_2022_PROGRAM_ID)) return ACCOUNT_SIZE;
  // The associated-token-account program makes every Token-2022 account's owner immutable.
  return getAccountLen([
    ExtensionType.ImmutableOwner,
    ...ACCOUNT_EXTENSION_FOR.filter(([mint]) => mintExtensions.includes(mint)).map(
      ([, account]) => account,
    ),
  ]);
}

/** A mint's extensions change rarely and the rent rate does not move in practice. */
const TTL_MS = 5 * 60_000;

export type AccountRent = (
  mint: PublicKey,
  programId: PublicKey,
  now?: number,
) => Promise<bigint | null>;

/** The rent in lamports of a token account for `mint`, or null when the mint cannot be read. */
export function createAccountRent(chain: ChainReader): AccountRent {
  const rents = new Map<string, { at: number; lamports: bigint }>();
  return async (mint, programId, now = Date.now()) => {
    const key = mint.toBase58();
    const known = rents.get(key);
    if (known && now - known.at < TTL_MS) return known.lamports;
    try {
      const account = await chain.getAccountInfo(mint, "confirmed");
      if (!account) return null;
      // Refuses an account the token program does not own, or one that is not a mint.
      const info = unpackMint(
        mint,
        { ...account, data: Buffer.from(account.data) } as AccountInfo<Buffer>,
        programId,
      );
      const rent = await chain.getMinimumBalanceForRentExemption(
        associatedAccountLen(programId, getExtensionTypes(info.tlvData)),
      );
      if (!Number.isSafeInteger(rent) || rent <= 0) return null;
      rents.set(key, { at: now, lamports: BigInt(rent) });
      return BigInt(rent);
    } catch {
      return null;
    }
  };
}

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  type VersionedTransaction,
} from "@solana/web3.js";
import { bytesEqual, readU64LE } from "../../chain/core/bytes.js";
import { ALL_STOCKS, stockByMint } from "../../chain/core/tokenRegistry.js";

/**
 * What a relayer-paid transaction is, read from its bytes.
 *
 * NoirWire's fee relayer signs as fee payer for a transaction that pays it
 * back in USDC. Two parties stand in front of that signature and both ask
 * the same question: this API, which anyone on the internet can call
 * without ever running the wallet, and the wallet itself before the
 * portfolio signs (the same reading, in @noirwire/shared). Neither takes the
 * other's word. A transaction is one of the few exact shapes below or it is
 * refused; there is no "close enough".
 *
 * Everything is decided from the transaction and the pinned keys alone,
 * with no chain read, so the route can refuse before it spends anything.
 * "Owned by the portfolio" therefore means "is the portfolio's associated
 * token account", which is an address that can be derived.
 */

const USDC_DECIMALS = 6;

/**
 * What the relayer charges, which this API decides and enforces. The relayer runs its own check with a small margin, only to
 * cover its cost; the prices people pay are these.
 *
 * A relayer-paid transaction has two signatures, so the network takes 10,000
 * lamports for it. The portfolio pays `NETWORK_FEE_MULTIPLE_BPS` of that:
 * twice the real cost.
 *
 * Opening a token account costs its rent, which the relayer puts up and
 * never gets back: it stays in the account, and is the account owner's to
 * reclaim by closing it. The portfolio pays `RENT_MULTIPLE_BPS` of it, the
 * rent and a tenth more. It is charged for every create instruction the
 * relayer funds, whether or not the account exists when the price is asked:
 * an account that exists then can be closed before the transaction lands,
 * and a relayer that charged nothing would be opening it for nothing, as
 * often as anyone cared to repeat it.
 */
export const RELAYED_NETWORK_FEE_LAMPORTS = 10_000n;
export const NETWORK_FEE_MULTIPLE_BPS = 20_000n;
export const RENT_MULTIPLE_BPS = 11_000n;

/**
 * What an action costs the portfolio, in lamports, before it is priced in
 * USDC. `rentLamports` is the rent of the account it opens, read from the
 * chain for that mint by whoever prices it, or null when it opens none.
 */
export function relayedCostLamports(rentLamports: bigint | null): bigint {
  const fee = (RELAYED_NETWORK_FEE_LAMPORTS * NETWORK_FEE_MULTIPLE_BPS) / 10_000n;
  return rentLamports === null ? fee : fee + (rentLamports * RENT_MULTIPLE_BPS) / 10_000n;
}

/**
 * `lamports` in raw USDC units at `solPriceUsd` dollars a SOL, rounded up.
 * The price is taken in whole cents so the sum stays in integers.
 */
export function lamportsInUsdc(lamports: bigint, solPriceUsd: number): bigint {
  const cents = BigInt(Math.ceil(solPriceUsd * 100));
  // A lamport is a billionth of a SOL and a raw unit a millionth of a dollar.
  return (lamports * cents + 99_999n) / 100_000n;
}

/**
 * The most a relayer-paid transaction may pay for its network cost, in raw
 * USDC units, whatever anyone asks. The fee always comes from this API;
 * these only bound it, so that a wrong or hostile price cannot
 * take more than a known amount. Held by the route and by the wallet alike.
 *
 * - No account opened: 0.05 USDC. The charge is 20,000 lamports, so this
 *   holds up to a SOL price of 2,500 USD.
 * - One token account opened: 2.5 USDC. The charge for a tracker's account
 *   as the trackers stand today (179 bytes) is 2,370,392 lamports, so this
 *   holds up to 1,054 USD a SOL. At 200 USD the charge is about 0.47 USDC.
 */
export const MAX_RELAYER_FEE_RAW = 50_000n;
export const MAX_RELAYER_FEE_OPENING_RAW = 2_500_000n;

export function relayerFeeCap(opensAccount: boolean): bigint {
  return opensAccount ? MAX_RELAYER_FEE_OPENING_RAW : MAX_RELAYER_FEE_RAW;
}

/** Jupiter Lend, and the receipt token its USDC vault mints. */
export const LEND_PROGRAM = new PublicKey("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
export const LEND_RECEIPT_MINT = new PublicKey("9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D");

/**
 * Jupiter Lend's deposit and withdraw instructions for the USDC vault, as
 * its API builds them: an 8-byte discriminator, the amount, and a fixed list
 * of accounts that opens with the depositor and the depositor's two token
 * accounts. Everything after those three is the vault's own and the same for
 * every depositor, read off instructions built for different addresses. An
 * instruction that differs anywhere is refused, so if Jupiter moves an
 * account the relayer stops paying for Earn until this list is updated,
 * and Earn is paid for the other way meanwhile.
 */
const LEND_DATA_LEN = 16;
const LEND_SHAPES = {
  deposit: {
    discriminator: [0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6],
    /** The depositor's own accounts, after the depositor: what is spent, then what is received. */
    own: (usdc: PublicKey) => [usdc, LEND_RECEIPT_MINT],
    vault: [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "5nmGjA4s7ATzpBQXC5RNceRpaJ7pYw2wKsNBWyuSAZV6",
      "2vVYHYM8VYnvZqQWpTJSj8o8DBf1wM8pVs3bsTgYZiqJ",
      "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D",
      "94vK29npVbyRHXH63rRcTiSr26SFhrQTzbpNJuhQEDu",
      "Hf9gtkM4dpVBahVSzEXSVCAPpKzBsBcns3s8As3z77oF",
      "5pjzT5dFTsXcwixoab1QDLvZQvpYJxJeBphkyfHGn688",
      "BmkUoKMFYBxNSzWXyUjyMJjMAaVz4d8ZnxwwmhDCUXFB",
      "7s1da8DduuBFqGra5bJBjpnvL5E9mGzCuMk1Qkh4or2Z",
      "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC",
      "5xSPBiD3TibamAnwHDhZABdB4z4F9dcj5PnbteroBTTd",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "11111111111111111111111111111111",
    ],
  },
  withdraw: {
    discriminator: [0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22],
    own: (usdc: PublicKey) => [LEND_RECEIPT_MINT, usdc],
    vault: [
      "5nmGjA4s7ATzpBQXC5RNceRpaJ7pYw2wKsNBWyuSAZV6",
      "2vVYHYM8VYnvZqQWpTJSj8o8DBf1wM8pVs3bsTgYZiqJ",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D",
      "94vK29npVbyRHXH63rRcTiSr26SFhrQTzbpNJuhQEDu",
      "Hf9gtkM4dpVBahVSzEXSVCAPpKzBsBcns3s8As3z77oF",
      "5pjzT5dFTsXcwixoab1QDLvZQvpYJxJeBphkyfHGn688",
      "BmkUoKMFYBxNSzWXyUjyMJjMAaVz4d8ZnxwwmhDCUXFB",
      "HN1r4VfkDn53xQQfeGDYrNuDKFdemAhZsHYRwBrFhsW",
      "7s1da8DduuBFqGra5bJBjpnvL5E9mGzCuMk1Qkh4or2Z",
      "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC",
      "5xSPBiD3TibamAnwHDhZABdB4z4F9dcj5PnbteroBTTd",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "11111111111111111111111111111111",
    ],
  },
} as const;

/** The keys a relayer-paid transaction is built against, as this server pins them. */
export type RelayerPins = {
  feePayers: PublicKey[];
  paymentWallet: PublicKey;
  /** The USDC mint of the configured network: what the payment is made in. */
  usdcMint: PublicKey;
  /**
   * Whether the relayer opens token accounts at all. On unless the server
   * switches it off, which sends every action that has to open one to be
   * paid for the other way.
   */
  accountCreation: boolean;
};

/** A token account the fee payer opens as part of the action. */
export type OpenedAccount = { owner: PublicKey; mint: PublicKey; programId: PublicKey };

export type RelayedAction =
  | {
      kind: "send";
      mint: PublicKey;
      programId: PublicKey;
      /** The portfolio's own account for the mint, and where the tokens go. */
      source: PublicKey;
      destination: PublicKey;
      amountRaw: bigint;
    }
  | { kind: "deposit" | "withdraw"; amountRaw: bigint }
  /** Nothing but opening the portfolio's own account for a tracker, ahead of a first buy. */
  | { kind: "open" };

/** A transaction that passed, as the facts every later check is made against. */
export type Relayed = {
  feePayer: PublicKey;
  portfolio: PublicKey;
  /** What the payment transfers to the relayer's payment account. */
  feeRaw: bigint;
  action: RelayedAction;
  opens: OpenedAccount | null;
};

/** Why a transaction is not one the relayer pays for. Fixed words, safe to log: none names an address. */
export type RelayedRefusal =
  | "lookup_table"
  | "fee_payer_not_pinned"
  | "signers"
  | "compute_budget"
  | "system_instruction"
  | "instruction_count"
  | "fee_payer_named"
  | "payment"
  | "payment_above_cap"
  | "account_creation"
  | "action";

type Reading = { ok: true; relayed: Relayed } | { ok: false; reason: RelayedRefusal };

const REQUIRED_SIGNATURES = 2;
const TRANSFER_CHECKED = 12;
const TRANSFER_CHECKED_LEN = 10;
const CREATE_IDEMPOTENT = 1;
const CREATE_ATA_ACCOUNTS = 6;

const USDC_DECIMALS_AND_PROGRAM = { decimals: USDC_DECIMALS, programId: TOKEN_PROGRAM_ID };

/** The token the wallets send at `mint`, or undefined: nothing else is relayed. */
function sendable(mint: string, usdc: PublicKey) {
  return mint === usdc.toBase58() ? USDC_DECIMALS_AND_PROGRAM : stockByMint(mint);
}
const TRACKERS = new Set(ALL_STOCKS.map((stock) => stock.mint.toBase58()));

function ata(mint: PublicKey, owner: PublicKey, programId: PublicKey = TOKEN_PROGRAM_ID) {
  return getAssociatedTokenAddressSync(mint, owner, true, programId);
}

type Instruction = { programId: PublicKey; accounts: PublicKey[]; data: Uint8Array };

/** A `TransferChecked` on the portfolio's own authority, or null when it is anything else. */
function transferChecked(instruction: Instruction, portfolio: PublicKey) {
  const { programId, accounts, data } = instruction;
  const isToken = programId.equals(TOKEN_PROGRAM_ID) || programId.equals(TOKEN_2022_PROGRAM_ID);
  if (!isToken || data.length !== TRANSFER_CHECKED_LEN || data[0] !== TRANSFER_CHECKED) return null;
  if (accounts.length !== 4 || !accounts[3].equals(portfolio)) return null;
  const [source, mint, destination] = accounts;
  return { programId, source, mint, destination, amountRaw: readU64LE(data, 1), decimals: data[9] };
}

/** A `CreateIdempotent` of an associated token account, funded by the fee payer, or null. */
function createdAccount(instruction: Instruction, feePayer: PublicKey): OpenedAccount | null {
  const { accounts, data } = instruction;
  if (!instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return null;
  if (data.length !== 1 || data[0] !== CREATE_IDEMPOTENT) return null;
  if (accounts.length !== CREATE_ATA_ACCOUNTS) return null;
  const [funder, account, owner, mint, system, programId] = accounts;
  const derived =
    funder.equals(feePayer) &&
    system.equals(SystemProgram.programId) &&
    (programId.equals(TOKEN_PROGRAM_ID) || programId.equals(TOKEN_2022_PROGRAM_ID)) &&
    account.equals(ata(mint, owner, programId));
  return derived ? { owner, mint, programId } : null;
}

function lendAction(
  instruction: Instruction,
  portfolio: PublicKey,
  usdc: PublicKey,
): RelayedAction | null {
  const { accounts, data } = instruction;
  if (!instruction.programId.equals(LEND_PROGRAM) || data.length !== LEND_DATA_LEN) return null;
  for (const kind of ["deposit", "withdraw"] as const) {
    const shape = LEND_SHAPES[kind];
    if (!bytesEqual(data.subarray(0, 8), Uint8Array.from(shape.discriminator))) continue;
    const expected = [
      portfolio,
      ...shape.own(usdc).map((mint) => ata(mint, portfolio)),
      ...shape.vault.map((key) => new PublicKey(key)),
    ];
    const matches =
      accounts.length === expected.length &&
      accounts.every((account, index) => account.equals(expected[index]));
    const amountRaw = readU64LE(data, 8);
    return matches && amountRaw > 0n ? { kind, amountRaw } : null;
  }
  return null;
}

function sendAction(
  instruction: Instruction,
  portfolio: PublicKey,
  usdc: PublicKey,
): Extract<RelayedAction, { kind: "send" }> | null {
  const sent = transferChecked(instruction, portfolio);
  const token = sent && sendable(sent.mint.toBase58(), usdc);
  if (!sent || !token) return null;
  const { mint, programId, source, destination, amountRaw } = sent;
  const listed =
    programId.equals(token.programId) &&
    sent.decimals === token.decimals &&
    source.equals(ata(mint, portfolio, programId)) &&
    !destination.equals(source) &&
    amountRaw > 0n;
  return listed ? { kind: "send", mint, programId, source, destination, amountRaw } : null;
}

/**
 * Whether `opened` is the one account `action` may have opened for it:
 * - a send, the recipient's account for the token sent, whoever they are;
 * - a deposit, this portfolio's account for the receipt it is paid in;
 * - a withdrawal, this portfolio's USDC account, which it is paid into;
 * - nothing else at all, this portfolio's own account for a listed tracker.
 */
function opensFor(
  opened: OpenedAccount,
  action: RelayedAction,
  portfolio: PublicKey,
  usdc: PublicKey,
): boolean {
  const { owner, mint, programId } = opened;
  if (action.kind === "send") {
    return (
      mint.equals(action.mint) &&
      programId.equals(action.programId) &&
      ata(mint, owner, programId).equals(action.destination)
    );
  }
  if (!owner.equals(portfolio)) return false;
  if (action.kind === "open") {
    return TRACKERS.has(mint.toBase58()) && programId.equals(TOKEN_2022_PROGRAM_ID);
  }
  const paidIn = action.kind === "deposit" ? LEND_RECEIPT_MINT : usdc;
  return mint.equals(paidIn) && programId.equals(TOKEN_PROGRAM_ID);
}

/**
 * Reads `transaction` as a relayer-paid one, or says why it is not:
 *
 * - a legacy message with no lookup table, so every account is in plain sight;
 * - the fee payer is a pinned relayer key, and the only other signer is one
 *   portfolio, which signs read-only on a send so none of its SOL can move;
 * - no ComputeBudget instruction (a priority fee would be the relayer's to
 *   pay) and no System instruction at all, which also rules out a durable
 *   nonce;
 * - the instructions are, in order and with nothing else: at most one
 *   `CreateIdempotent` of a token account, funded by the fee payer; at most
 *   one action; and the payment. There is always an action or an account;
 * - the payment is one USDC `TransferChecked` out of the portfolio's own
 *   account, on its own authority, into the pinned payment wallet's account,
 *   for no more than the cap, and nothing else names that account;
 * - the action is one `TransferChecked` of a token the app lists, out of the
 *   portfolio's own account, or Jupiter Lend's deposit or withdraw for this
 *   portfolio in the one layout its API builds;
 * - an account is opened only for the action beside it (see `opensFor`), so
 *   the relayer cannot be made to open accounts for strangers or for tokens
 *   the app does not hold, and never together with a `CloseAccount`: no
 *   shape here has room for one;
 * - the fee payer appears in no instruction except as the funder of that one
 *   account: it pays the fee and nothing else is ever asked of it.
 *
 * What the payment has to be at least is not decided here. That needs a
 * price, and is enforced where the price is read (relayer.ts).
 */
export function readRelayed(transaction: VersionedTransaction, pins: RelayerPins): Reading {
  const refuse = (reason: RelayedRefusal): Reading => ({ ok: false, reason });
  const { message } = transaction;
  if (message.version !== "legacy" || message.addressTableLookups.length > 0) {
    return refuse("lookup_table");
  }
  const keys = message.staticAccountKeys;
  const feePayer = keys[0];
  if (!feePayer || !pins.feePayers.some((pinned) => pinned.equals(feePayer))) {
    return refuse("fee_payer_not_pinned");
  }
  const portfolio = keys[1];
  if (message.header.numRequiredSignatures !== REQUIRED_SIGNATURES || !portfolio) {
    return refuse("signers");
  }

  const instructions: Instruction[] = [];
  for (const compiled of message.compiledInstructions) {
    const programId = keys[compiled.programIdIndex];
    const accounts = compiled.accountKeyIndexes.map((index) => keys[index]);
    if (!programId || accounts.some((account) => !account)) return refuse("action");
    if (programId.equals(ComputeBudgetProgram.programId)) return refuse("compute_budget");
    if (programId.equals(SystemProgram.programId)) return refuse("system_instruction");
    instructions.push({ programId, accounts, data: compiled.data });
  }
  if (instructions.length !== 2 && instructions.length !== 3) return refuse("instruction_count");

  const payment = instructions[instructions.length - 1];
  const first = instructions[0];
  const opened = createdAccount(first, feePayer);
  const acted = instructions.length === 3 ? instructions[1] : opened ? null : first;
  if (instructions.length === 3 && !opened) return refuse("account_creation");
  if (opened && !pins.accountCreation) return refuse("account_creation");

  const named = (instruction: Instruction, key: PublicKey) =>
    instruction.accounts.some((account) => account.equals(key));
  const feePayerNamed =
    named(payment, feePayer) ||
    (acted !== null && named(acted, feePayer)) ||
    (!opened && named(first, feePayer));
  if (feePayerNamed) return refuse("fee_payer_named");

  const usdc = pins.usdcMint;
  const paymentAccount = ata(usdc, pins.paymentWallet);
  const paid = transferChecked(payment, portfolio);
  const paysRelayer =
    paid !== null &&
    paid.programId.equals(TOKEN_PROGRAM_ID) &&
    paid.mint.equals(usdc) &&
    paid.decimals === USDC_DECIMALS &&
    paid.source.equals(ata(usdc, portfolio)) &&
    paid.destination.equals(paymentAccount) &&
    paid.amountRaw > 0n;
  if (!paysRelayer) return refuse("payment");
  if (instructions.slice(0, -1).some((instruction) => named(instruction, paymentAccount))) {
    return refuse("payment");
  }
  if (paid.amountRaw > relayerFeeCap(opened !== null)) return refuse("payment_above_cap");

  const action: RelayedAction | null = acted
    ? (lendAction(acted, portfolio, usdc) ?? sendAction(acted, portfolio, usdc))
    : { kind: "open" };
  if (!action) return refuse("action");
  if (action.kind === "send" && message.isAccountWritable(1)) return refuse("signers");
  if (opened && !opensFor(opened, action, portfolio, usdc)) return refuse("account_creation");

  return {
    ok: true,
    relayed: { feePayer, portfolio, feeRaw: paid.amountRaw, action, opens: opened },
  };
}

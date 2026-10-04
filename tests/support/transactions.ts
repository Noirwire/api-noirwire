import {
  ACCOUNT_SIZE,
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  ExtensionType,
  getAccountLen,
  getAssociatedTokenAddressSync,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { usdcMintKey } from "../../src/chain/core/network.js";
import { ALL_STOCKS } from "../../src/chain/core/tokenRegistry.js";
import {
  LEND_PROGRAM,
  LEND_RECEIPT_MINT,
  MAX_RELAYER_FEE_OPENING_RAW,
  MAX_RELAYER_FEE_RAW,
} from "../../src/relayer/core/relayed.js";

/**
 * Relayer-paid transactions as a wallet builds them, and every hostile
 * variation of them. The genuine shapes are the ones the wallets' own code
 * produces; the hostile ones are what anyone could post instead.
 */

export const USDC = usdcMintKey("devnet");
export const tracker = ALL_STOCKS[0];
export const PLAIN_FEE = 20_000n;
/** Rent as the chain charges it: 6,960 lamports for each byte, and for 128 bytes of overhead. */
export const rentOf = (bytes: number) => (bytes + 128) * 6_960;
/** What opening an account of `bytes` costs: its rent and a tenth more, and twice the network fee. */
export const openingFee = (bytes: number) => PLAIN_FEE + (BigInt(rentOf(bytes)) * 11n) / 10n;
export const OPENING_FEE = openingFee(ACCOUNT_SIZE);
/** The trackers' mints carry a transfer hook slot, so each of their accounts carries its counterpart. */
export const TRACKER_ACCOUNT = getAccountLen([
  ExtensionType.ImmutableOwner,
  ExtensionType.TransferHookAccount,
]);
export const TRACKER_OPENING_FEE = openingFee(TRACKER_ACCOUNT);

export const ataFor = (mint: PublicKey, owner: PublicKey, programId = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(mint, owner, true, programId);

const LEND_VAULT = {
  deposit: [
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
  withdraw: [
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
};
const LEND_DISCRIMINATOR = {
  deposit: [0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6],
  withdraw: [0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22],
};

export type Hostile = Record<string, [() => VersionedTransaction, string]>;

/** The transactions of one relayer, one payment wallet, one portfolio and one recipient. */
export function scenario() {
  const relayer = Keypair.generate();
  const paymentWallet = Keypair.generate().publicKey;
  const portfolio = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const owner = portfolio.publicKey;
  const cash = ataFor(USDC, owner);
  const paymentAccount = ataFor(USDC, paymentWallet);

  function payment(feeRaw: bigint, to = paymentAccount, mint = USDC, from = cash) {
    return createTransferCheckedInstruction(from, mint, to, owner, feeRaw, 6);
  }

  function sendUsdc(amountRaw = 5_000_000n, to = recipient) {
    return createTransferCheckedInstruction(cash, USDC, ataFor(USDC, to), owner, amountRaw, 6);
  }

  function sendTracker(amountRaw = 1_000_000n, to = recipient) {
    const { mint, programId, decimals } = tracker;
    return createTransferCheckedInstruction(
      ataFor(mint, owner, programId),
      mint,
      ataFor(mint, to, programId),
      owner,
      amountRaw,
      decimals,
      undefined,
      programId,
    );
  }

  function open(account: PublicKey, of: PublicKey, mint: PublicKey, programId = TOKEN_PROGRAM_ID) {
    return createAssociatedTokenAccountIdempotentInstruction(
      relayer.publicKey,
      account,
      of,
      mint,
      programId,
    );
  }

  /** Jupiter Lend's instruction as its API builds it, for `depositor`. */
  function lend(kind: "deposit" | "withdraw", amountRaw = 7_000_000n, depositor = owner) {
    const data = Buffer.alloc(16);
    Buffer.from(LEND_DISCRIMINATOR[kind]).copy(data);
    data.writeBigUInt64LE(amountRaw, 8);
    const own =
      kind === "deposit"
        ? [ataFor(USDC, depositor), ataFor(LEND_RECEIPT_MINT, depositor)]
        : [ataFor(LEND_RECEIPT_MINT, depositor), ataFor(USDC, depositor)];
    return new TransactionInstruction({
      programId: LEND_PROGRAM,
      keys: [
        { pubkey: depositor, isSigner: true, isWritable: true },
        ...own.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
        ...LEND_VAULT[kind].map((key) => ({
          pubkey: new PublicKey(key),
          isSigner: false,
          isWritable: false,
        })),
      ],
      data,
    });
  }

  function compile(instructions: TransactionInstruction[], payer = relayer.publicKey) {
    return new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions,
      }).compileToLegacyMessage(),
    );
  }

  const genuine = {
    sendUsdc: () => compile([sendUsdc(), payment(PLAIN_FEE)]),
    sendTracker: () => compile([sendTracker(), payment(PLAIN_FEE)]),
    sendToNew: () =>
      compile([open(ataFor(USDC, recipient), recipient, USDC), sendUsdc(), payment(OPENING_FEE)]),
    deposit: () => compile([lend("deposit"), payment(PLAIN_FEE)]),
    firstDeposit: () =>
      compile([
        open(ataFor(LEND_RECEIPT_MINT, owner), owner, LEND_RECEIPT_MINT),
        lend("deposit"),
        payment(OPENING_FEE),
      ]),
    withdraw: () => compile([lend("withdraw"), payment(PLAIN_FEE)]),
    withdrawToNoAccount: () =>
      compile([open(cash, owner, USDC), lend("withdraw"), payment(OPENING_FEE)]),
    openHolding: () =>
      compile([
        open(
          ataFor(tracker.mint, owner, tracker.programId),
          owner,
          tracker.mint,
          tracker.programId,
        ),
        payment(TRACKER_OPENING_FEE),
      ]),
  };

  /** Every transaction that is not a relayer-paid one, with the fixed reason it is refused for. */
  const hostile: Hostile = {
    "a fee payer that is not pinned": [
      () => compile([sendUsdc(), payment(PLAIN_FEE)], Keypair.generate().publicKey),
      "fee_payer_not_pinned",
    ],
    "a third signer": [
      () => {
        const transfer = sendUsdc();
        transfer.keys.push({
          pubkey: Keypair.generate().publicKey,
          isSigner: true,
          isWritable: false,
        });
        return compile([transfer, payment(PLAIN_FEE)]);
      },
      "signers",
    ],
    "no portfolio signing at all": [
      () =>
        compile([
          new TransactionInstruction({
            programId: TOKEN_PROGRAM_ID,
            keys: [],
            data: Buffer.alloc(1),
          }),
          new TransactionInstruction({
            programId: TOKEN_PROGRAM_ID,
            keys: [],
            data: Buffer.alloc(1),
          }),
        ]),
      "signers",
    ],
    "a lookup table": [
      () =>
        new VersionedTransaction(
          new TransactionMessage({
            payerKey: relayer.publicKey,
            recentBlockhash: Keypair.generate().publicKey.toBase58(),
            instructions: [sendUsdc(), payment(PLAIN_FEE)],
          }).compileToV0Message([
            new AddressLookupTableAccount({
              key: Keypair.generate().publicKey,
              state: {
                deactivationSlot: 0n,
                lastExtendedSlot: 0,
                lastExtendedSlotStartIndex: 0,
                addresses: [ataFor(USDC, recipient)],
              },
            }),
          ]),
        ),
      "lookup_table",
    ],
    "a priority fee": [
      () =>
        compile([
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }),
          sendUsdc(),
          payment(PLAIN_FEE),
        ]),
      "compute_budget",
    ],
    "a raw System transfer of the fee payer's SOL": [
      () =>
        compile([
          SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: owner, lamports: 1 }),
          payment(PLAIN_FEE),
        ]),
      "system_instruction",
    ],
    "a durable nonce": [
      () =>
        compile([
          SystemProgram.nonceAdvance({
            noncePubkey: Keypair.generate().publicKey,
            authorizedPubkey: owner,
          }),
          sendUsdc(),
          payment(PLAIN_FEE),
        ]),
      "system_instruction",
    ],
    "no payment": [() => compile([sendUsdc(), sendUsdc(1n)]), "payment"],
    "a second payment": [() => compile([payment(PLAIN_FEE), payment(PLAIN_FEE)]), "payment"],
    "a payment above the cap": [
      () => compile([sendUsdc(), payment(MAX_RELAYER_FEE_RAW + 1n)]),
      "payment_above_cap",
    ],
    "an opening payment above its cap": [
      () =>
        compile([
          open(ataFor(USDC, recipient), recipient, USDC),
          sendUsdc(),
          payment(MAX_RELAYER_FEE_OPENING_RAW + 1n),
        ]),
      "payment_above_cap",
    ],
    "a payment to another account": [
      () => compile([sendUsdc(), payment(PLAIN_FEE, ataFor(USDC, Keypair.generate().publicKey))]),
      "payment",
    ],
    "a payment to the fee payer's own account": [
      () => compile([sendUsdc(), payment(PLAIN_FEE, ataFor(USDC, relayer.publicKey))]),
      "payment",
    ],
    "a payment in another token": [
      () =>
        compile([
          sendUsdc(),
          createTransferCheckedInstruction(
            ataFor(tracker.mint, owner, tracker.programId),
            tracker.mint,
            ataFor(tracker.mint, paymentWallet, tracker.programId),
            owner,
            PLAIN_FEE,
            tracker.decimals,
            undefined,
            tracker.programId,
          ),
        ]),
      "payment",
    ],
    "a payment out of an account that is not the portfolio's own": [
      () =>
        compile([
          sendUsdc(),
          payment(PLAIN_FEE, paymentAccount, USDC, Keypair.generate().publicKey),
        ]),
      "payment",
    ],
    "an extra instruction": [
      () => compile([sendUsdc(), sendUsdc(1n), sendUsdc(2n), payment(PLAIN_FEE)]),
      "instruction_count",
    ],
    "a program outside the shapes (Memo)": [
      () =>
        compile([
          new TransactionInstruction({
            programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
            keys: [],
            data: Buffer.from("hi"),
          }),
          payment(PLAIN_FEE),
        ]),
      "action",
    ],
    "an approval in place of the action": [
      () =>
        compile([
          createApproveInstruction(cash, Keypair.generate().publicKey, owner, 1n),
          payment(1n),
        ]),
      "action",
    ],
    "a CloseAccount in place of the action": [
      () => compile([createCloseAccountInstruction(cash, owner, owner), payment(PLAIN_FEE)]),
      "action",
    ],
    "an account opened and then closed": [
      () => {
        const account = ataFor(tracker.mint, owner, tracker.programId);
        return compile([
          open(account, owner, tracker.mint, tracker.programId),
          createCloseAccountInstruction(account, owner, owner, [], TOKEN_2022_PROGRAM_ID),
          payment(OPENING_FEE),
        ]);
      },
      "action",
    ],
    "a send out of an account the portfolio does not own": [
      () =>
        compile([
          createTransferCheckedInstruction(
            ataFor(USDC, Keypair.generate().publicKey),
            USDC,
            ataFor(USDC, recipient),
            owner,
            1n,
            6,
          ),
          payment(PLAIN_FEE),
        ]),
      "action",
    ],
    "a send of a token the app does not list": [
      () => {
        const mint = Keypair.generate().publicKey;
        return compile([
          createTransferCheckedInstruction(
            ataFor(mint, owner),
            mint,
            ataFor(mint, recipient),
            owner,
            1n,
            6,
          ),
          payment(PLAIN_FEE),
        ]);
      },
      "action",
    ],
    "a send on the fee payer's authority": [
      () =>
        compile([
          createTransferCheckedInstruction(
            ataFor(USDC, relayer.publicKey),
            USDC,
            cash,
            relayer.publicKey,
            1n,
            6,
          ),
          payment(PLAIN_FEE),
        ]),
      "fee_payer_named",
    ],
    "a Lend deposit of the fee payer's own funds": [
      () => compile([lend("deposit", 1_000n, relayer.publicKey), payment(PLAIN_FEE)]),
      "fee_payer_named",
    ],
    "a Lend instruction with one account swapped": [
      () => {
        const instruction = lend("deposit");
        instruction.keys[5].pubkey = Keypair.generate().publicKey;
        return compile([instruction, payment(PLAIN_FEE)]);
      },
      "action",
    ],
    "a Lend instruction for somebody else's token accounts": [
      () => {
        const instruction = lend("withdraw");
        instruction.keys[2].pubkey = ataFor(USDC, Keypair.generate().publicKey);
        return compile([instruction, payment(PLAIN_FEE)]);
      },
      "action",
    ],
    "another Lend instruction": [
      () => {
        const instruction = lend("deposit");
        instruction.data = Buffer.concat([Buffer.alloc(8, 7), instruction.data.subarray(8)]);
        return compile([instruction, payment(PLAIN_FEE)]);
      },
      "action",
    ],
    "an account opened for a stranger": [
      () => {
        const stranger = Keypair.generate().publicKey;
        return compile([
          open(ataFor(USDC, stranger), stranger, USDC),
          sendUsdc(),
          payment(OPENING_FEE),
        ]);
      },
      "account_creation",
    ],
    "an account opened for a token the app does not hold": [
      () => {
        const mint = Keypair.generate().publicKey;
        return compile([open(ataFor(mint, owner), owner, mint), payment(OPENING_FEE)]);
      },
      "account_creation",
    ],
    "the portfolio's own USDC account opened on its own": [
      () => compile([open(cash, owner, USDC), payment(OPENING_FEE)]),
      "account_creation",
    ],
    "a deposit that opens a tracker account": [
      () =>
        compile([
          open(
            ataFor(tracker.mint, owner, tracker.programId),
            owner,
            tracker.mint,
            tracker.programId,
          ),
          lend("deposit"),
          payment(OPENING_FEE),
        ]),
      "account_creation",
    ],
    "two accounts opened": [
      () => {
        const other = Keypair.generate().publicKey;
        return compile([
          open(ataFor(USDC, recipient), recipient, USDC),
          open(ataFor(USDC, other), other, USDC),
          payment(OPENING_FEE),
        ]);
      },
      "fee_payer_named",
    ],
    "a plain Create in place of CreateIdempotent": [
      () =>
        compile([
          createAssociatedTokenAccountInstruction(
            relayer.publicKey,
            ataFor(USDC, recipient),
            recipient,
            USDC,
          ),
          sendUsdc(),
          payment(OPENING_FEE),
        ]),
      "account_creation",
    ],
    "an account opened at an address that is not the owner's": [
      () => {
        const instruction = open(ataFor(USDC, recipient), recipient, USDC);
        instruction.keys[2].pubkey = Keypair.generate().publicKey;
        return compile([instruction, sendUsdc(), payment(OPENING_FEE)]);
      },
      "account_creation",
    ],
  };

  const encode = (transaction: VersionedTransaction) =>
    Buffer.from(transaction.serialize()).toString("base64");
  const signedByPortfolio = (transaction: VersionedTransaction) => {
    transaction.sign([portfolio]);
    return transaction;
  };

  return {
    relayer,
    paymentWallet,
    portfolio,
    recipient,
    owner,
    cash,
    payment,
    sendUsdc,
    open,
    compile,
    genuine,
    hostile,
    encode,
    signedByPortfolio,
  };
}

export const PYTH_ACCOUNT = "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE";
const PYTH_RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
const SOL_USD_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** Pyth's price account as its receiver program writes it. */
export function pythAccount(
  usd: number,
  ageSeconds: number,
  over: { verified?: number; confidence?: bigint; now?: number } = {},
) {
  const data = Buffer.alloc(134);
  data[40] = over.verified ?? 1;
  Buffer.from(SOL_USD_FEED, "hex").copy(data, 41);
  const price = BigInt(Math.round(usd * 1e8));
  data.writeBigInt64LE(price, 73);
  data.writeBigUInt64LE(over.confidence ?? price / 1_000n, 81);
  data.writeInt32LE(-8, 89);
  data.writeBigInt64LE(BigInt(Math.floor((over.now ?? Date.now()) / 1000) - ageSeconds), 93);
  return { owner: PYTH_RECEIVER, data, lamports: 1, executable: false, rentEpoch: 0 };
}

/** A mint account, with the given Token-2022 extensions when it has any. */
export function mintAccount(
  programId: PublicKey,
  decimals: number,
  extensions: [type: number, length: number][] = [],
) {
  const tlv = extensions.reduce((sum, [, length]) => sum + 4 + length, 0);
  const data = Buffer.alloc(extensions.length ? ACCOUNT_SIZE + 1 + tlv : MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  if (extensions.length) {
    data[ACCOUNT_SIZE] = 1;
    let offset = ACCOUNT_SIZE + 1;
    for (const [type, length] of extensions) {
      data.writeUInt16LE(type, offset);
      data.writeUInt16LE(length, offset + 2);
      offset += 4 + length;
    }
  }
  return { owner: programId, data, lamports: 1, executable: false, rentEpoch: 0 };
}

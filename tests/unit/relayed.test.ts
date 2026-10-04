import { ComputeBudgetProgram, type VersionedTransaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  lamportsInUsdc,
  LEND_RECEIPT_MINT,
  readRelayed,
  relayedCostLamports,
  type RelayerPins,
} from "../../src/relayer/core/relayed.js";
import { PLAIN_FEE, scenario, USDC } from "../support/transactions.js";

/**
 * A relayer-paid transaction is one of a few exact shapes or it is refused.
 * These build the genuine shapes and then every hostile variation of them.
 * The wallets hold their own reading to the same list in @noirwire/shared.
 */

const { relayer, paymentWallet, owner, recipient, genuine, hostile } = scenario();

const pins: RelayerPins = {
  feePayers: [relayer.publicKey],
  paymentWallet,
  usdcMint: USDC,
  accountCreation: true,
};

describe("reading a relayer-paid transaction", () => {
  it("reads each genuine shape, with what it pays and what it does", () => {
    const read = (transaction: VersionedTransaction) => {
      const reading = readRelayed(transaction, pins);
      if (!reading.ok) throw new Error(reading.reason);
      return reading.relayed;
    };

    const send = read(genuine.sendUsdc());
    expect(send.feePayer.equals(relayer.publicKey)).toBe(true);
    expect(send.portfolio.equals(owner)).toBe(true);
    expect(send.feeRaw).toBe(PLAIN_FEE);
    expect(send.opens).toBeNull();
    expect(send.action).toMatchObject({ kind: "send", amountRaw: 5_000_000n });

    expect(read(genuine.sendTracker()).action).toMatchObject({
      kind: "send",
      amountRaw: 1_000_000n,
    });
    expect(read(genuine.sendToNew()).opens?.owner.equals(recipient)).toBe(true);
    expect(read(genuine.deposit()).action).toEqual({ kind: "deposit", amountRaw: 7_000_000n });
    expect(read(genuine.firstDeposit()).opens?.mint.equals(LEND_RECEIPT_MINT)).toBe(true);
    expect(read(genuine.withdraw()).action).toEqual({ kind: "withdraw", amountRaw: 7_000_000n });
    expect(read(genuine.withdrawToNoAccount()).opens?.mint.equals(USDC)).toBe(true);
    expect(read(genuine.openHolding())).toMatchObject({ action: { kind: "open" } });
  });

  it("builds a send with the relayer first, the portfolio second and read-only, and no priority fee", () => {
    const { message } = genuine.sendToNew();
    expect(message.staticAccountKeys[0].equals(relayer.publicKey)).toBe(true);
    expect(message.staticAccountKeys[1].equals(owner)).toBe(true);
    expect(message.header.numRequiredSignatures).toBe(2);
    expect(message.isAccountWritable(1)).toBe(false);
    const programs = message.compiledInstructions.map(
      (instruction) => message.staticAccountKeys[instruction.programIdIndex],
    );
    expect(programs.some((program) => program.equals(ComputeBudgetProgram.programId))).toBe(false);
  });

  it.each(Object.entries(hostile))("refuses %s", (_name, [build, reason]) => {
    expect(readRelayed(build(), pins)).toEqual({ ok: false, reason });
  });

  it("opens no account at all when the server has that switched off", () => {
    const off = { ...pins, accountCreation: false };
    expect(readRelayed(genuine.sendUsdc(), off).ok).toBe(true);
    for (const build of [genuine.sendToNew, genuine.firstDeposit, genuine.openHolding]) {
      expect(readRelayed(build(), off)).toEqual({ ok: false, reason: "account_creation" });
    }
  });

  it("takes the payment in the configured network's USDC and no other", () => {
    const otherNetwork = { ...pins, usdcMint: LEND_RECEIPT_MINT };
    expect(readRelayed(genuine.sendUsdc(), otherNetwork)).toEqual({
      ok: false,
      reason: "payment",
    });
  });
});

describe("what the relayer charges", () => {
  it("is twice the network fee, and for an opened account its rent and a tenth more", () => {
    expect(relayedCostLamports(null)).toBe(20_000n);
    expect(relayedCostLamports(2_039_280n)).toBe(20_000n + 2_243_208n);
    expect(relayedCostLamports(2_136_720n)).toBe(20_000n + 2_350_392n);
  });

  it("is priced in USDC at the SOL price, rounded up", () => {
    expect(lamportsInUsdc(20_000n, 1_000)).toBe(20_000n);
    expect(lamportsInUsdc(20_000n, 150)).toBe(3_000n);
    expect(lamportsInUsdc(2_263_208n, 200)).toBe(452_642n);
    expect(lamportsInUsdc(1n, 0.01)).toBe(1n);
  });
});

import { Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { base58 } from "../../src/chain/core/bytes.js";
import { signerOf } from "../../src/chain/core/signatures.js";
import {
  forRollup,
  maxTransactionBytes,
  readProfileTransaction,
  type ProfilePins,
} from "../../src/profile/core/transaction.js";
import { MAX_DATA_LEN, MESSAGE_AT, profileScenario, verified } from "../support/profiles.js";

/**
 * A profile transaction is one of three exact shapes or it is refused. These
 * build the genuine shapes with web3.js, as a wallet does, and then every
 * hostile variation of them.
 */

const { programId, gate, owner, genuine, hostile, record } = profileScenario();
const pins: ProfilePins = { programId, gate: gate.publicKey, maxDataLen: MAX_DATA_LEN };

function read(bytes: Uint8Array) {
  const reading = readProfileTransaction(bytes, pins);
  if (!reading.ok) throw new Error(reading.reason);
  return reading;
}

describe("reading a profile transaction", () => {
  it("reads a creation, a write and a closing for what they are", () => {
    expect(read(genuine.create()).action).toBe("create");
    expect(read(genuine.write()).action).toBe("write");
    expect(read(genuine.close()).action).toBe("close");
  });

  it("does not depend on the order a wallet's library lists the account keys in", () => {
    expect(read(genuine.createWithLegacyClass()).action).toBe("create");
  });

  it("takes a record of exactly the limit", () => {
    expect(read(genuine.write(record(MAX_DATA_LEN))).action).toBe("write");
  });

  it.each(Object.entries(hostile))("refuses %s", (_name, [build, reason]) => {
    expect(readProfileTransaction(build(), pins)).toEqual({ ok: false, reason });
  });

  it("takes the largest transaction there is, and refuses one byte more before reading it", () => {
    const largest = genuine.create(record(MAX_DATA_LEN));
    expect(largest.length).toBe(maxTransactionBytes(MAX_DATA_LEN));
    expect(read(largest).action).toBe("create");

    const over = genuine.create(record(MAX_DATA_LEN + 1));
    expect(over.length).toBe(maxTransactionBytes(MAX_DATA_LEN) + 1);
    expect(readProfileTransaction(over, pins)).toEqual({ ok: false, reason: "too_large" });
    // Bytes that are no transaction at all are turned away for their length alone.
    expect(readProfileTransaction(new Uint8Array(over.length), pins)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});

describe("a transaction larger than Solana's own limit", () => {
  const large: ProfilePins = { ...pins, maxDataLen: 2_048 };
  const signAsGate = signerOf(gate.secretKey);

  it.each(["create", "write"] as const)(
    "is co-signed where it lies: a %s of 2,000 bytes goes on unchanged but for the gate's 64 bytes",
    (kind) => {
      const sent = genuine.byHand(kind, record(2_000));
      expect(sent.length).toBeGreaterThan(1_232);
      const reading = readProfileTransaction(sent, large);
      if (!reading.ok) throw new Error(reading.reason);
      const { transaction, signature } = forRollup(reading, signAsGate);

      // The message is the one the wallet sent, read here from the wallet's own bytes.
      const message = sent.subarray(MESSAGE_AT);
      expect(verified(gate.publicKey, message, transaction.subarray(1, 65))).toBe(true);
      expect(verified(owner.publicKey, message, transaction.subarray(65, 129))).toBe(true);
      expect(transaction.length).toBe(sent.length);
      expect(transaction[0]).toBe(sent[0]);
      expect(Buffer.from(transaction.subarray(65)).equals(sent.subarray(65))).toBe(true);
      expect(signature).toBe(base58(transaction.subarray(1, 65)));
    },
  );

  it("is still held to every check: a large write for another owner's profile is refused", () => {
    const sent = genuine.byHand("write", record(2_000));
    // The fourth key of a write's message is the profile.
    sent[MESSAGE_AT + 4 + 3 * 32] ^= 1;
    expect(readProfileTransaction(sent, large)).toEqual({ ok: false, reason: "accounts" });
  });
});

describe("the gate's signature", () => {
  const signAsGate = signerOf(gate.secretKey);

  it.each(["create", "write"] as const)(
    "completes a %s: both signatures verify, over the message the owner signed",
    (kind) => {
      const sent = genuine[kind]();
      const { transaction, signature } = forRollup(read(sent), signAsGate);

      const landed = Transaction.from(transaction);
      expect(landed.verifySignatures()).toBe(true);
      expect(landed.feePayer?.equals(gate.publicKey)).toBe(true);
      expect(signature).toBe(base58(landed.signatures[0].signature as Uint8Array));
      // Only the gate's place changed: the owner's signature and the message are the wallet's.
      expect(Buffer.from(transaction.subarray(65))).toEqual(Buffer.from(sent.subarray(65)));
    },
  );

  it("adds nothing to a closing, which is the owner's alone", () => {
    const sent = genuine.close();
    let asked = 0;
    const { transaction, signature } = forRollup(read(sent), (message) => {
      asked += 1;
      return signAsGate(message);
    });
    expect(asked).toBe(0);
    expect(Buffer.from(transaction)).toEqual(Buffer.from(sent));
    expect(Transaction.from(transaction).verifySignatures()).toBe(true);
    expect(signature).toBe(base58(sent.subarray(1, 65)));
  });
});

import { Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { base58 } from "../../src/chain/core/bytes.js";
import { signerOf } from "../../src/chain/core/signatures.js";
import {
  forRollup,
  readProfileTransaction,
  type ProfilePins,
} from "../../src/profile/core/transaction.js";
import { MAX_DATA_LEN, profileScenario } from "../support/profiles.js";

/**
 * A profile transaction is one of three exact shapes or it is refused. These
 * build the genuine shapes with web3.js, as a wallet does, and then every
 * hostile variation of them.
 */

const { programId, gate, genuine, hostile, record } = profileScenario();
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

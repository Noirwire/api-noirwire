import { PublicKey } from "@solana/web3.js";

/**
 * A legacy transaction read straight from its bytes.
 *
 * The rollup takes transactions far larger than Solana's 1,232 bytes, and a
 * profile record needs them. The library's own writers refuse anything over
 * that size, so a transaction is never written out again here: it is read
 * where it lies, and the message every signature is over is the very slice
 * of bytes that came in.
 *
 * The read is exact. Every length is in its shortest form, nothing runs past
 * the end, and nothing is left over after the last instruction: one
 * transaction has one spelling, and anything else is refused.
 */

const SIGNATURE_BYTES = 64;
const KEY_BYTES = 32;
/** The first byte of a versioned message has this bit set. A legacy message's first byte is a signer count. */
const VERSIONED = 0x80;

export type WireInstruction = { program: number; accounts: number[]; data: Uint8Array };

export type WireTransaction = {
  /** One per required signer, in the order of the keys. Views into the bytes read. */
  signatures: Uint8Array[];
  /** The message exactly as it was received. */
  message: Uint8Array;
  keys: PublicKey[];
  instructions: WireInstruction[];
  isSigner(index: number): boolean;
  isWritable(index: number): boolean;
};

export type WireReading =
  { ok: true; transaction: WireTransaction } | { ok: false; reason: string };

class Malformed extends Error {}

/** Walks `bytes` forward, refusing to step past the end. */
function reader(bytes: Uint8Array) {
  let at = 0;
  const take = (length: number): Uint8Array => {
    if (at + length > bytes.length) throw new Malformed();
    at += length;
    return bytes.subarray(at - length, at);
  };
  const byte = () => take(1)[0];
  return {
    take,
    byte,
    /** A length as Solana writes one: seven bits a byte, low bits first, at most three bytes, in its shortest form. */
    length(): number {
      let value = 0;
      for (let shift = 0; shift <= 14; shift += 7) {
        const next = byte();
        value |= (next & 0x7f) << shift;
        if ((next & 0x80) === 0) {
          if (next === 0 && shift > 0) throw new Malformed();
          return value;
        }
      }
      throw new Malformed();
    },
    done: () => at === bytes.length,
    rest: () => bytes.subarray(at),
  };
}

export function readWire(bytes: Uint8Array): WireReading {
  const refuse = (reason: string): WireReading => ({ ok: false, reason });
  try {
    const outer = reader(bytes);
    const signatures = Array.from({ length: outer.length() }, () => outer.take(SIGNATURE_BYTES));
    const message = outer.rest();

    const inner = reader(message);
    const signers = inner.byte();
    // A lookup table would name accounts this read cannot see.
    if (signers & VERSIONED) return refuse("not_legacy");
    const readonlySigners = inner.byte();
    const readonlyOthers = inner.byte();
    if (signatures.length !== signers) return refuse("signature_count");

    const keys = Array.from({ length: inner.length() }, () => new PublicKey(inner.take(KEY_BYTES)));
    if (signers < 1 || readonlySigners >= signers || signers + readonlyOthers > keys.length) {
      return refuse("not_a_transaction");
    }
    inner.take(KEY_BYTES); // The recent blockhash.
    const instructions = Array.from({ length: inner.length() }, () => ({
      program: inner.byte(),
      accounts: [...inner.take(inner.length())],
      data: inner.take(inner.length()),
    }));
    if (!inner.done()) return refuse("trailing_bytes");

    return {
      ok: true,
      transaction: {
        signatures,
        message,
        keys,
        instructions,
        isSigner: (index) => index < signers,
        isWritable: (index) =>
          index < signers
            ? index < signers - readonlySigners
            : index < keys.length - readonlyOthers,
      },
    };
  } catch (error) {
    if (error instanceof Malformed) return refuse("not_a_transaction");
    throw error;
  }
}

/** How many bytes a length takes on the wire. */
export function lengthBytes(length: number): number {
  return length < 0x80 ? 1 : length < 0x4000 ? 2 : 3;
}

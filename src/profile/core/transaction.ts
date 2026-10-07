import type { PublicKey } from "@solana/web3.js";
import { base58, bytesEqual } from "../../chain/core/bytes.js";
import { signedBy, type Signer } from "../../chain/core/signatures.js";
import { accountsOf, DISCRIMINATORS, OWNER_POSITION, type ProfileAction } from "./program.js";
import { lengthBytes, readWire } from "./wire.js";

/**
 * What a profile transaction is, read from its bytes.
 *
 * The gate key signs as fee payer for a creation and a write, and a
 * creation spends the sponsor's rent. Anyone can post a transaction here
 * without ever running the wallet, so nothing about it is assumed: it is
 * read where it lies (wire.ts), the accounts it must name are worked out
 * again from the owner key found in it, and it is one of the three exact
 * shapes below or it is refused. There is no "close enough".
 *
 * Everything is decided from the transaction and the pinned keys alone,
 * with no chain read. The message is never written out again: what the
 * owner signed, what the gate signs and what is sent on are the same bytes.
 */

export type ProfilePins = {
  programId: PublicKey;
  /** The key this server signs with, and the only fee payer of a creation or a write. */
  gate: PublicKey;
  /** The largest record a creation or a write may carry, in bytes. */
  maxDataLen: number;
};

export type ProfileTransaction = {
  action: ProfileAction;
  /** The whole transaction as it was received. */
  bytes: Uint8Array;
  /** The message every signature is over: the part of `bytes` after the signatures. */
  message: Uint8Array;
};

export type ProfileReading = ({ ok: true } & ProfileTransaction) | { ok: false; reason: string };

const SIGNATURE_BYTES = 64;
const KEY_BYTES = 32;
const DISCRIMINATOR_BYTES = 8;
/** The bytes before the record in a write: the discriminator and the expected revision. */
const WRITE_HEADER_BYTES = DISCRIMINATOR_BYTES + 8;
/** A creation names eight accounts, and its message lists them and the program. */
const CREATION_ACCOUNTS = 8;

/**
 * The size of the largest transaction there is: a creation carrying a
 * record of `maxDataLen` bytes. A write names fewer accounts, and a closing
 * carries no record. Anything longer is refused before it is read.
 */
export function maxTransactionBytes(maxDataLen: number): number {
  const data = DISCRIMINATOR_BYTES + 4 + maxDataLen;
  const instruction = 1 + 1 + CREATION_ACCOUNTS + lengthBytes(data) + data;
  const message = 3 + 1 + (CREATION_ACCOUNTS + 1) * KEY_BYTES + KEY_BYTES + 1 + instruction;
  return 1 + 2 * SIGNATURE_BYTES + message;
}

function actionOf(data: Uint8Array): ProfileAction | null {
  const discriminator = data.subarray(0, DISCRIMINATOR_BYTES);
  const actions = Object.keys(DISCRIMINATORS) as ProfileAction[];
  return actions.find((action) => bytesEqual(DISCRIMINATORS[action], discriminator)) ?? null;
}

/**
 * The length of the record the instruction carries, when its data is
 * exactly what the program reads and nothing more: a u32 length and that
 * many bytes after the fixed part. Null for anything else, and for a
 * closing that carries any argument at all.
 */
function recordLength(action: ProfileAction, data: Uint8Array): number | null {
  if (action === "close") return data.length === DISCRIMINATOR_BYTES ? 0 : null;
  const at = action === "create" ? DISCRIMINATOR_BYTES : WRITE_HEADER_BYTES;
  if (data.length < at + 4) return null;
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);
  return data.length === at + 4 + length ? length : null;
}

/** Reads `bytes` as one of the three profile transactions, or says with a fixed word why it is not one. */
export function readProfileTransaction(bytes: Uint8Array, pins: ProfilePins): ProfileReading {
  const refuse = (reason: string): ProfileReading => ({ ok: false, reason });

  if (bytes.length > maxTransactionBytes(pins.maxDataLen)) return refuse("too_large");
  const wire = readWire(bytes);
  if (!wire.ok) return refuse(wire.reason);
  const { signatures, message, keys, instructions, isSigner, isWritable } = wire.transaction;
  if (instructions.length !== 1) return refuse("instruction_count");

  const [{ program, accounts: named, data }] = instructions;
  if (!keys[program]?.equals(pins.programId)) return refuse("program");
  const action = actionOf(data);
  if (!action) return refuse("instruction");
  const length = recordLength(action, data);
  if (length === null) return refuse("instruction_data");
  if (action !== "close" && length === 0) return refuse("empty_record");
  if (length > pins.maxDataLen) return refuse("record_too_large");

  const owner = keys[named[OWNER_POSITION[action]]];
  if (!owner || owner.equals(pins.gate)) return refuse("accounts");
  const expected = accountsOf(action, owner, pins);
  // The first key pays the fee: the gate, or the owner of a profile being closed.
  if (!keys[0].equals(expected[0].key)) return refuse("fee_payer");

  // Every key the message lists is one the instruction names, once, or the
  // program: there is no room for another account or another signer.
  const used = new Set([...named, program]);
  if (named.length !== expected.length || used.size !== expected.length + 1) {
    return refuse("accounts");
  }
  if (keys.length !== used.size) return refuse("accounts");
  if (isSigner(program) || isWritable(program)) return refuse("accounts");
  for (const [position, slot] of expected.entries()) {
    const index = named[position];
    if (
      !keys[index]?.equals(slot.key) ||
      isSigner(index) !== slot.signer ||
      isWritable(index) !== slot.writable
    ) {
      return refuse("accounts");
    }
  }

  // The owner has committed to exactly these bytes, or nothing is added to them and nothing is sent.
  const ownerSignature = signatures[named[OWNER_POSITION[action]]];
  if (!signedBy(owner, message, ownerSignature)) return refuse("owner_signature");

  return { ok: true, action, bytes, message };
}

export type ForRollup = {
  /** The whole transaction, ready to send. */
  transaction: Uint8Array;
  /** Its id: the first signature, base58. */
  signature: string;
};

/** Where the first signature lies: after the one byte that counts them. */
const FIRST_SIGNATURE_AT = 1;

/**
 * A transaction that passed `readProfileTransaction`, as it is sent to the
 * rollup: the bytes that came in, and for a creation or a write the gate's
 * signature written into the fee payer's place, over the very message the
 * owner signed. A closing is the owner's alone and is sent as it came.
 */
export function forRollup(read: ProfileTransaction, signAsGate: Signer): ForRollup {
  const transaction = Uint8Array.from(read.bytes);
  if (read.action !== "close") transaction.set(signAsGate(read.message), FIRST_SIGNATURE_AT);
  return {
    transaction,
    signature: base58(
      transaction.subarray(FIRST_SIGNATURE_AT, FIRST_SIGNATURE_AT + SIGNATURE_BYTES),
    ),
  };
}

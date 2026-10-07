import { VersionedTransaction, type PublicKey } from "@solana/web3.js";
import { Buffer } from "node:buffer";
import { base58, bytesEqual } from "../../chain/core/bytes.js";
import { signedBy, type Signer } from "../../chain/core/signatures.js";
import { accountsOf, DISCRIMINATORS, OWNER_POSITION, type ProfileAction } from "./program.js";

/**
 * What a profile transaction is, read from its bytes.
 *
 * The gate key signs as fee payer for a creation and a write, and a
 * creation spends the sponsor's rent. Anyone can post a transaction here
 * without ever running the wallet, so nothing about it is assumed: it is
 * decoded, the accounts it must name are worked out again from the owner
 * key found in it, and it is one of the three exact shapes below or it is
 * refused. There is no "close enough".
 *
 * Everything is decided from the transaction and the pinned keys alone,
 * with no chain read.
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
  /** The message every signature is over, exactly as it will be sent. */
  message: Uint8Array;
  /** One signature per signer, in the message's order. The gate's place, when it has one, is the first. */
  signatures: Uint8Array[];
};

export type ProfileReading = ({ ok: true } & ProfileTransaction) | { ok: false; reason: string };

const DISCRIMINATOR_BYTES = 8;
/** The bytes before the record in a write: the discriminator and the expected revision. */
const WRITE_HEADER_BYTES = DISCRIMINATOR_BYTES + 8;

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

/** A transaction as it travels: how many signatures, each of them, then the message. */
function serialized(signatures: Uint8Array[], message: Uint8Array): Uint8Array {
  return Buffer.concat([Uint8Array.of(signatures.length), ...signatures, message]);
}

/** Reads `bytes` as one of the three profile transactions, or says with a fixed word why it is not one. */
export function readProfileTransaction(bytes: Uint8Array, pins: ProfilePins): ProfileReading {
  const refuse = (reason: string): ProfileReading => ({ ok: false, reason });

  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(bytes);
  } catch {
    return refuse("not_a_transaction");
  }
  const { message, signatures } = transaction;
  // A lookup table would name accounts this check cannot see.
  if (message.version !== "legacy" || message.addressTableLookups.length > 0) {
    return refuse("not_legacy");
  }
  if (message.compiledInstructions.length !== 1) return refuse("instruction_count");

  const keys = message.staticAccountKeys;
  const [instruction] = message.compiledInstructions;
  const program = instruction.programIdIndex;
  if (!keys[program]?.equals(pins.programId)) return refuse("program");
  const action = actionOf(instruction.data);
  if (!action) return refuse("instruction");
  const length = recordLength(action, instruction.data);
  if (length === null) return refuse("instruction_data");
  if (action !== "close" && length === 0) return refuse("empty_record");
  if (length > pins.maxDataLen) return refuse("record_too_large");

  const named = instruction.accountKeyIndexes;
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
  if (message.isAccountSigner(program) || message.isAccountWritable(program)) {
    return refuse("accounts");
  }
  for (const [position, slot] of expected.entries()) {
    const index = named[position];
    if (
      !keys[index]?.equals(slot.key) ||
      message.isAccountSigner(index) !== slot.signer ||
      message.isAccountWritable(index) !== slot.writable
    ) {
      return refuse("accounts");
    }
  }

  const signed = message.serialize();
  // The owner has committed to exactly this message, or nothing is added to it and nothing is sent.
  const ownerSignature = signatures[named[OWNER_POSITION[action]]];
  if (!signedBy(owner, signed, ownerSignature)) return refuse("owner_signature");
  // What is sent on is written out again from what was checked, so the bytes
  // that came in must already be that and nothing besides.
  if (!bytesEqual(serialized(signatures, signed), bytes)) return refuse("not_canonical");

  return { ok: true, action, message: signed, signatures };
}

export type ForRollup = {
  /** The whole transaction, ready to send. */
  transaction: Uint8Array;
  /** Its id: the first signature, base58. */
  signature: string;
};

/**
 * A transaction that passed `readProfileTransaction`, as it is sent to the
 * rollup. A creation or a write gets the gate's signature in the fee
 * payer's place, over the very message that was checked. A closing is the
 * owner's alone and is sent as it came.
 */
export function forRollup(read: ProfileTransaction, signAsGate: Signer): ForRollup {
  const signatures =
    read.action === "close"
      ? read.signatures
      : [signAsGate(read.message), ...read.signatures.slice(1)];
  return {
    transaction: serialized(signatures, read.message),
    signature: base58(signatures[0]),
  };
}

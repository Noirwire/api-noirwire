import type { PublicKey } from "@solana/web3.js";
import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

/** The fixed headers of an ed25519 key in the encodings Node reads: a public key, and a private key's 32-byte seed. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Whether `signature` is `signer`'s over `message`. */
export function signedBy(signer: PublicKey, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, signer.toBytes()]),
      format: "der",
      type: "spki",
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}

export type Signer = (message: Uint8Array) => Uint8Array;

/**
 * Signs as the key whose 64-byte secret is `secretKey` (its seed, then its
 * public key, as Solana writes one). The secret is read here once and held
 * by the returned function alone.
 */
export function signerOf(secretKey: Uint8Array): Signer {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, secretKey.subarray(0, 32)]),
    format: "der",
    type: "pkcs8",
  });
  return (message) => new Uint8Array(sign(null, message, key));
}

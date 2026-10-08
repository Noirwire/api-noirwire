/** Fixed-width reads over plain bytes, for everything the transaction checks decode. */

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** A little-endian u64 at `offset`. Throws a RangeError when `data` is too short. */
export function readU64LE(data: Uint8Array, offset: number): bigint {
  return view(data).getBigUint64(offset, true);
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Bytes in base58, as Solana writes addresses and transaction ids. */
export function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let text = "";
  for (; value > 0n; value /= 58n) text = BASE58[Number(value % 58n)] + text;
  const leadingZeros = bytes.findIndex((byte) => byte !== 0);
  return "1".repeat(leadingZeros === -1 ? bytes.length : leadingZeros) + text;
}

/** The bytes `text` writes in base58, or null when it is not base58. */
export function fromBase58(text: string): Uint8Array | null {
  let value = 0n;
  for (const character of text) {
    const digit = BASE58.indexOf(character);
    if (digit === -1) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; value > 0n; value /= 256n) bytes.unshift(Number(value % 256n));
  const leadingOnes = [...text].findIndex((character) => character !== "1");
  const zeros = leadingOnes === -1 ? text.length : leadingOnes;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

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

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

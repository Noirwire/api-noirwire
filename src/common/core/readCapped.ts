import { Buffer } from "node:buffer";

/**
 * Reads a stream up to `maxBytes`, counting as it goes, and stops reading
 * the moment there is more: null. Nothing past the limit is ever held in
 * memory. Aborting `signal` stops the read and throws.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const stop = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error("aborted");
      if (done) return Buffer.concat(chunks);
      received += value.byteLength;
      if (received > maxBytes) {
        stop();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/** A request body as Node hands it over: chunks, an end, or an error. */
export type IncomingBody = AsyncIterable<Uint8Array> & { pause(): unknown };

/**
 * The same bounded read for an incoming request. The stream is left paused
 * when the limit is passed or the deadline runs out, so nothing more of it
 * is buffered; the HTTP layer closes the connection after answering.
 */
export async function readCappedIncoming(
  body: IncomingBody,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer | null> {
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  aborted.catch(() => undefined);
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([iterator.next(), aborted]);
      if (done) return Buffer.concat(chunks);
      received += value.byteLength;
      if (received > maxBytes) {
        body.pause();
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    body.pause();
    throw error;
  }
}

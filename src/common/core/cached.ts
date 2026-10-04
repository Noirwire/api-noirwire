/**
 * Public data read from its source once for everyone. However many callers
 * ask, the source is read once per `ttlMs`; a stale copy is still served at
 * once while a fresh one is fetched behind it, for `staleMs` more. A failure
 * is never kept, so the next request simply tries again, and callers that
 * arrive while a read is under way share it.
 */
export type Cached<T> = { value: T; ageSeconds: number };

export function createCache<T>(options: {
  load: () => Promise<T>;
  ttlMs: number;
  staleMs: number;
  now?: () => number;
}): () => Promise<Cached<T>> {
  const now = options.now ?? Date.now;
  let held: { at: number; value: T } | null = null;
  let loading: Promise<{ at: number; value: T }> | null = null;

  function refresh() {
    loading ??= options
      .load()
      .then((value) => (held = { at: now(), value }))
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  const serve = (entry: { at: number; value: T }): Cached<T> => ({
    value: entry.value,
    ageSeconds: Math.max(0, Math.floor((now() - entry.at) / 1000)),
  });

  return async () => {
    const age = held ? now() - held.at : Infinity;
    if (held && age < options.ttlMs) return serve(held);
    if (held && age < options.ttlMs + options.staleMs) {
      refresh().catch(() => undefined);
      return serve(held);
    }
    return serve(await refresh());
  };
}

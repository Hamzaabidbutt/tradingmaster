/**
 * Lightweight in-memory TTL cache. In a horizontally scaled deployment this
 * should be swapped for Redis — the interface is intentionally minimal so a
 * Redis adapter is a drop-in replacement.
 */

interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();
const MAX_ENTRIES = 2000;

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  if (store.size >= MAX_ENTRIES) {
    // Evict expired first, then oldest.
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expiresAt < now) store.delete(k);
    }
    if (store.size >= MAX_ENTRIES) {
      const first = store.keys().next().value;
      if (first !== undefined) store.delete(first);
    }
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function cacheDelete(key: string): void {
  store.delete(key);
}

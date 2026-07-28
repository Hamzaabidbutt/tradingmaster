/**
 * Sliding-window in-memory rate limiter. Sufficient for a single instance;
 * swap the store for Redis when scaling horizontally.
 */

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX ?? 120);

export function rateLimit(key: string, max = MAX_REQUESTS, windowMs = WINDOW_MS): {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
} {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(key, bucket);
  }
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

  if (bucket.timestamps.length >= max) {
    const oldest = bucket.timestamps[0];
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.ceil((oldest + windowMs - now) / 1000),
    };
  }
  bucket.timestamps.push(now);

  // Opportunistic cleanup.
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) {
      if (b.timestamps.length === 0 || now - b.timestamps[b.timestamps.length - 1] > windowMs) {
        buckets.delete(k);
      }
    }
  }
  return { allowed: true, remaining: max - bucket.timestamps.length, retryAfterSec: 0 };
}

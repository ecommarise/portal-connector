/**
 * A small fixed-window limiter, per key (normally the caller's address).
 *
 * In memory and per process, which is the right size for this service: it exists so that the
 * unauthenticated endpoints — /register, /authorize, /callback, /token, /setup — cannot be
 * looped to fill the token store or guess codes, not to meter real traffic.
 *
 * Bounded without forgetting everyone at once. The old version cleared the whole map when it
 * passed 10 000 keys, which handed every address a fresh window — exactly what a flood from
 * many addresses wants. Now expired windows are swept first, and only if the map is still full
 * is the NEW key refused, so existing callers keep their counts.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 20_000,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);

    if (entry && entry.resetAt > now) {
      entry.count += 1;
      return entry.count <= this.max;
    }

    if (!entry && this.hits.size >= this.maxKeys) {
      for (const [k, v] of this.hits) {
        if (v.resetAt <= now) this.hits.delete(k);
      }
      if (this.hits.size >= this.maxKeys) return false;
    }

    this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    return true;
  }
}

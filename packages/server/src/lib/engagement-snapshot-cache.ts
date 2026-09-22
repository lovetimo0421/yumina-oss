interface SnapshotCacheOptions<T> {
  freshMs: number;
  negativeMs: number;
  maxStaleMs: number;
  maxEntries: number;
  maxBytes: number;
  empty(): T;
  sizeOf(value: T): number;
  isEmpty(value: T): boolean;
  now?: () => number;
}

interface Entry<T> {
  value?: T;
  bytes: number;
  freshUntil: number;
  staleUntil: number;
  retryAfter: number;
  refreshAfter: number;
  generation: number;
  flightGeneration?: number;
  flight?: Promise<T>;
}

/** Public scoring snapshots only: never use stale values for eligibility or user
 * state. Bounds cover retained values and source slots, including active loads.
 * Oversized successful loads are returned intact to their existing waiters but
 * not retained. Caller owns value immutability and source error diagnostics. */
export class EngagementSnapshotCache<T> {
  private readonly entries = new Map<object, Entry<T>>();
  private bytes = 0;
  private readonly now: () => number;
  constructor(private readonly options: SnapshotCacheOptions<T>) {
    this.now = options.now ?? (() => Date.now());
  }

  private dropValue(entry: Entry<T>) {
    this.bytes -= entry.bytes;
    entry.bytes = 0;
    entry.value = undefined;
    entry.freshUntil = entry.staleUntil = 0;
  }

  private evict(except?: Entry<T>): boolean {
    for (const [key, entry] of this.entries) {
      if (entry !== except && !entry.flight) {
        this.dropValue(entry);
        this.entries.delete(key);
        return true;
      }
    }
    return false;
  }

  async get(source: object, load: () => Promise<T>): Promise<T> {
    let entry = this.entries.get(source);
    if (!entry) {
      if (this.entries.size >= this.options.maxEntries && !this.evict()) return this.options.empty();
      entry = { bytes: 0, freshUntil: 0, staleUntil: 0, retryAfter: 0, refreshAfter: 0, generation: 0 };
    }
    this.entries.delete(source);
    this.entries.set(source, entry);
    const current = entry;
    const now = this.now();
    if (current.value !== undefined && now < current.freshUntil) return current.value;
    const fallback = () => {
      if (current.value !== undefined && this.now() < current.staleUntil) return current.value;
      this.dropValue(current);
      return this.options.empty();
    };
    if (now < current.retryAfter) return fallback();
    if (current.flight) {
      return current.flightGeneration === current.generation ? current.flight
        : current.flight.then(() => this.get(source, load));
    }
    const generation = current.generation;
    current.flightGeneration = generation;
    const pending = Promise.resolve().then(load).then(value => {
      if (generation !== current.generation) return value;
      this.dropValue(current);
      const size = this.options.sizeOf(value);
      if (!Number.isFinite(size) || size < 0 || size > this.options.maxBytes) return value;
      while (this.bytes + size > this.options.maxBytes && this.evict(current)) { /* enforce combined budget */ }
      if (this.bytes + size > this.options.maxBytes) return value;
      current.value = value;
      current.bytes = size;
      this.bytes += size;
      const at = this.now();
      const empty = this.options.isEmpty(value);
      current.freshUntil = at + (empty ? this.options.negativeMs : this.options.freshMs);
      current.staleUntil = empty ? current.freshUntil : at + this.options.maxStaleMs;
      current.retryAfter = 0;
      return value;
    }, () => {
      if (generation === current.generation) current.retryAfter = this.now() + this.options.negativeMs;
      return fallback();
    }).finally(() => { current.flight = undefined; });
    current.flight = pending;
    return pending;
  }

  /** Refresh only the snapshot the caller observed. Concurrent/late mismatches
   * must not evict its replacement, duplicate a flight, or bypass backoff. */
  refresh(source: object, observed: T, load: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(source);
    const now = this.now();
    if (entry && entry.value === observed && !entry.flight
      && now >= entry.retryAfter && now >= entry.refreshAfter) {
      entry.freshUntil = 0;
      entry.refreshAfter = now + this.options.negativeMs;
    }
    return this.get(source, load);
  }

  invalidate(): void {
    for (const entry of this.entries.values()) {
      this.dropValue(entry);
      entry.retryAfter = 0;
      entry.refreshAfter = 0;
      entry.generation++;
    }
  }
}

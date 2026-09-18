import { validateUsersBucket, type UsersMetricBucket, type UsersMetricRow, type UsersMetricsSnapshot, USERS_METRICS_MAX_BYTES } from "./admin-users-metrics.js";

export const USERS_MANIFEST_KEY = "admin:users:metrics:v2:manifest";
export const USERS_DEFINITION_VERSION = "2026-09-13-cost-coverage-v3";
export const usersShardKey = (month: string, revision: string, kind: "daily" | "monthly" | "all" | "today") => `admin:users:metrics:v2:${month}:${revision}:${kind}`;
export interface UsersShard {
  dailyKey: string;
  monthlyKey: string;
  generatedAt: string;
  definition?: string;
  usageRevision?: string;
}
export interface UsersManifest {
  version: 2;
  publishedAt: string;
  discoveredAt: string;
  months: string[];
  shards: Record<string, UsersShard>;
  allKey: string | null;
  todayKey: string | null;
}
export function decodeUsersManifest(raw: string): UsersManifest {
  if (Buffer.byteLength(raw) > 256_000) throw new Error("Users manifest exceeds budget");
  const value = JSON.parse(raw) as UsersManifest;
  if (value.version !== 2 || !Number.isFinite(Date.parse(value.publishedAt)) || !Number.isFinite(Date.parse(value.discoveredAt)) ||
      !Array.isArray(value.months) || value.months.length > 240 || new Set(value.months).size !== value.months.length ||
      value.months.some(m => !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) || !value.shards || typeof value.shards !== "object") throw new Error("Invalid Users manifest");
  const keyIsValid = (key: string | null) => key === null || /^admin:users:metrics:v2:[\w:-]+$/.test(key);
  if (!keyIsValid(value.allKey) || !keyIsValid(value.todayKey)) throw new Error("Invalid Users aggregate key");
  for (const [month, shard] of Object.entries(value.shards)) {
    if (!value.months.includes(month) || !keyIsValid(shard.dailyKey) || !keyIsValid(shard.monthlyKey) || !Number.isFinite(Date.parse(shard.generatedAt))) throw new Error("Invalid Users shard");
  }
  return value;
}
export function encodeUsersBucket(bucket: UsersMetricBucket): string {
  validateUsersBucket(bucket);
  const body = JSON.stringify(bucket);
  if (Buffer.byteLength(body) > USERS_METRICS_MAX_BYTES) throw new Error("Users bucket exceeds budget");
  return body;
}
export function decodeUsersBucket(raw: string): UsersMetricBucket {
  if (Buffer.byteLength(raw) > USERS_METRICS_MAX_BYTES) throw new Error("Users bucket exceeds budget");
  const value = JSON.parse(raw) as UsersMetricBucket;
  validateUsersBucket(value);
  return value;
}

/** Collapse all daily/model/world contributions before serving a period.
 * Per-user maps bound repeated model/world entries to distinct dimensions. */
export function mergeUsersBuckets(buckets: UsersMetricBucket[], day: string): UsersMetricBucket {
  const values = new Map<string, { row: UsersMetricRow; models: Map<string, [number, number, number, number, number]>; costs: Map<string, [number, number, number, number, number]>; worlds: Map<string, number> }>();
  for (const bucket of buckets) for (const input of bucket.rows) {
    let value = values.get(input.userId);
    if (!value) {
      value = { row: { userId: input.userId, day, messages: 0, studioMessages: 0, byokMessages: 0, models: [], worldMessages: [], lastActiveAt: null,
        player: false, creator: false, community: false, active: false, playtimeSeconds: 0, standaloneSeconds: 0 }, models: new Map(), costs: new Map(), worlds: new Map() };
      values.set(input.userId, value);
    }
    const row = value.row;
    row.messages += input.messages; row.studioMessages += input.studioMessages; row.byokMessages += input.byokMessages;
    row.playtimeSeconds += input.playtimeSeconds;
    row.standaloneSeconds! += input.standaloneSeconds ?? 0;
    row.player ||= input.player; row.creator ||= input.creator; row.community ||= input.community; row.active ||= input.active;
    if (input.lastActiveAt && (!row.lastActiveAt || input.lastActiveAt > row.lastActiveAt)) row.lastActiveAt = input.lastActiveAt;
    for (const [model, requests, prompt, completion, platformInput, platformOutput] of input.models) {
      const m = value.models.get(model) ?? [0, 0, 0, 0, 0];
      m[0] += requests; m[1] += prompt; m[2] += completion; m[3] += platformInput; m[4] += platformOutput; value.models.set(model, m);
    }
    // During a rolling upgrade old shards retain their explicit estimate basis.
    for (const [model, observed, measured, prompt, completion, requests] of input.costs ?? input.models.map(([m,n,,,pi,po]) => [m,0,0,pi,po,pi+po>0?n:0] as const)) {
      const c = value.costs.get(model) ?? [0,0,0,0,0];
      c[0] += observed; c[1] += measured; c[2] += prompt; c[3] += completion; c[4] += requests; value.costs.set(model,c);
    }
    for (const [world, n] of input.worldMessages) value.worlds.set(world, (value.worlds.get(world) ?? 0) + n);
  }
  const dates = buckets.map(b => b.generatedAt).sort();
  const through = buckets.map(b => b.through).sort();
  const source = (name: keyof UsersMetricBucket["sources"]) => ({
    available: buckets.length > 0 && buckets.every(b => b.sources[name].available),
    through: buckets.map(b => b.sources[name].through).filter((s): s is string => !!s).sort().at(-1) ?? null,
    note: [...new Set(buckets.map(b => b.sources[name].note))].join("; "),
  });
  return { generatedAt: dates.at(-1) ?? day + "T00:00:00Z", through: through.at(-1) ?? day + "T00:00:00Z",
    sources: { usage: source("usage"), activity: source("activity"), playtime: source("playtime") },
    rows: [...values.values()].map(v => ({ ...v.row, models: [...v.models].map(([m, n]) => [m, ...n]), costs: [...v.costs].map(([m,n]) => [m,...n]), worldMessages: [...v.worlds] })) };
}

type Period = { unit: string; start: string | null; end: string | null };
interface ReaderCache { get(key: string): Promise<string | null> }
/** All-time reads ONE worker-prepared per-user aggregate. Other periods reuse
 * an immutable period aggregate by manifest revision, independent of filters.
 * Cache size is bounded, including fallback when Redis becomes unavailable. */
export class PreparedUsersReader {
  private manifest: UsersManifest | null = null;
  private manifestUntil = 0;
  private manifestPending: Promise<UsersManifest | null> | null = null;
  private readonly periods = new Map<string, { data: UsersMetricsSnapshot; bytes: number }>();
  private readonly pending = new Map<string, Promise<UsersMetricsSnapshot | null>>();
  private bytes = 0;
  constructor(private readonly cache: ReaderCache | null, private readonly timeoutMs = 1000, private readonly clock: () => number = Date.now) {}
  private async get(key: string) {
    if (!this.cache) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.cache.get(key), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Users prepared read deadline")), this.timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  private async readManifest() {
    if (this.clock() < this.manifestUntil) return this.manifest;
    if (this.manifestPending) return this.manifestPending;
    this.manifestPending = (async () => {
      try {
        const raw = await this.get(USERS_MANIFEST_KEY);
        if (raw) {
          const next = decodeUsersManifest(raw);
          if (!this.manifest || next.publishedAt >= this.manifest.publishedAt) this.manifest = next;
        }
      } catch { /* bounded last-good metadata */ }
      this.manifestUntil = this.clock() + 5_000;
      return this.manifest;
    })();
    try { return await this.manifestPending; } finally { this.manifestPending = null; }
  }
  async read(period: Period): Promise<UsersMetricsSnapshot | null> {
    const manifest = await this.readManifest();
    if (!manifest) return null;
    const periodKey = `${period.unit}:${period.start}:${period.end}`, key = `${periodKey}:${manifest.publishedAt}`;
    const cached = this.periods.get(key);
    if (cached) return cached.data;
    if (this.pending.has(key)) return this.pending.get(key)!;
    // Bound simultaneous historical period builds as well as resident cache memory.
    if (this.pending.size >= 4) return null;
    const operation = this.load(period, manifest).then(data => {
      if (data) {
        const bytes = Buffer.byteLength(JSON.stringify(data));
        if (bytes <= USERS_METRICS_MAX_BYTES) {
          while (this.periods.size >= 8 || this.bytes + bytes > 128 * 1024 * 1024) {
            const oldest = this.periods.keys().next().value;
            if (!oldest) break;
            this.bytes -= this.periods.get(oldest)!.bytes; this.periods.delete(oldest);
          }
          this.periods.set(key, { data, bytes }); this.bytes += bytes;
        }
      }
      return data;
    }).catch(() => {
      // Fall back only to this exact period, never a differently filtered range.
      return [...this.periods].reverse().find(([k]) => k.startsWith(periodKey + ":"))?.[1].data ?? null;
    });
    this.pending.set(key, operation);
    try { return await operation; } finally { this.pending.delete(key); }
  }
  private async load(period: Period, manifest: UsersManifest): Promise<UsersMetricsSnapshot> {
    const readBucket = async (key: string) => {
      const raw = await this.get(key);
      if (!raw) throw new Error("Prepared Users shard unavailable");
      return decodeUsersBucket(raw);
    };
    const today = manifest.todayKey ? await readBucket(manifest.todayKey) : undefined;
    const base: UsersMetricsSnapshot = { version: 1, discoveredAt: manifest.discoveredAt, months: manifest.months, buckets: {}, today, preparedComplete: false };
    if (period.unit === "all") {
      if (manifest.allKey) { base.aggregate = await readBucket(manifest.allKey); base.preparedComplete = true; }
      return base;
    }
    const months = manifest.months.filter(month => {
      const end = new Date(month + "-01T00:00:00Z"); end.setUTCMonth(end.getUTCMonth() + 1);
      return (!period.end || month + "-01" < period.end) && (!period.start || end.toISOString().slice(0, 10) > period.start);
    });
    if (months.some(m => !manifest.shards[m])) return base;
    const buckets: UsersMetricBucket[] = [];
    for (const month of months) {
      const b = await readBucket(manifest.shards[month]!.dailyKey);
      buckets.push({ ...b, rows: b.rows.filter(r => (!period.start || r.day >= period.start) && (!period.end || r.day < period.end)) });
    }
    // Empty historical ranges still retain truthful source availability metadata.
    if (!buckets.length && today) buckets.push({ ...today, rows: [] });
    base.aggregate = mergeUsersBuckets(buckets, period.start!); base.preparedComplete = true;
    return base;
  }
}

export interface ModelPoolEntry {
  modelId: string;
  weight: number;
  locked?: boolean;
}

export const MAX_POOL_SIZE = 5;
export const DEFAULT_WEIGHT = 1;
export const MIN_POOL_WEIGHT = 0;
export const MAX_POOL_WEIGHT = 100;

export function clampPoolWeight(weight: number): number {
  const rounded = Math.round(Number.isFinite(weight) ? weight : DEFAULT_WEIGHT);
  return Math.max(MIN_POOL_WEIGHT, Math.min(MAX_POOL_WEIGHT, rounded));
}

function assignWeightsToTotal(
  pool: ModelPoolEntry[],
  indexes: number[],
  totalWeight: number,
) {
  if (indexes.length === 0) return;

  const total = Math.max(
    0,
    Math.min(MAX_POOL_WEIGHT * indexes.length, Math.round(totalWeight)),
  );

  if (total === 0) {
    for (const index of indexes) pool[index].weight = 0;
    return;
  }

  const currentTotal = indexes.reduce((sum, index) => sum + pool[index].weight, 0);
  const assigned = indexes.map((index) => {
    const exact =
      currentTotal > 0
        ? (pool[index].weight / currentTotal) * total
        : total / indexes.length;
    const weight = Math.floor(exact);
    return { index, weight, remainder: exact - weight };
  });

  let remaining = total - assigned.reduce((sum, entry) => sum + entry.weight, 0);
  assigned.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const entry of assigned) {
    if (remaining <= 0) break;
    entry.weight += 1;
    remaining -= 1;
  }

  for (const entry of assigned) {
    pool[entry.index].weight = clampPoolWeight(entry.weight);
  }
}

function normalizePoolTotal(pool: ModelPoolEntry[]): ModelPoolEntry[] {
  if (pool.length === 0) return pool;
  const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
  if (total === MAX_POOL_WEIGHT) return pool;

  const next = pool.map((entry) => ({ ...entry }));
  assignWeightsToTotal(
    next,
    next.map((_, index) => index),
    MAX_POOL_WEIGHT,
  );
  return next;
}

export function sanitizeModelPool(pool: ModelPoolEntry[]): ModelPoolEntry[] {
  const canLock = pool.length > 2;
  let lockSeen = false;

  const next = pool.slice(0, MAX_POOL_SIZE).map((entry) => {
    const next: ModelPoolEntry = {
      modelId: entry.modelId,
      weight: clampPoolWeight(entry.weight),
    };

    if (canLock && entry.locked && !lockSeen) {
      next.locked = true;
      lockSeen = true;
    }

    return next;
  });

  return normalizePoolTotal(next);
}

export function toggleModelPoolLock(
  pool: ModelPoolEntry[],
  modelId: string,
): ModelPoolEntry[] {
  const normalized = sanitizeModelPool(pool);
  if (normalized.length <= 2 || !normalized.some((entry) => entry.modelId === modelId)) {
    return normalized.map(({ modelId, weight }) => ({ modelId, weight }));
  }

  const shouldLock = !normalized.find((entry) => entry.modelId === modelId)?.locked;
  return normalized.map(({ modelId: id, weight }) => {
    const next: ModelPoolEntry = { modelId: id, weight };
    if (shouldLock && id === modelId) next.locked = true;
    return next;
  });
}

export function setModelPoolWeight(
  pool: ModelPoolEntry[],
  modelId: string,
  weight: number,
): ModelPoolEntry[] {
  const normalized = sanitizeModelPool(pool);
  const targetIndex = normalized.findIndex((entry) => entry.modelId === modelId);
  if (targetIndex < 0) return normalized;

  const requested = clampPoolWeight(weight);
  const next = normalized.map((entry) => ({ ...entry }));

  const lockedOtherTotal = next.reduce(
    (sum, entry, index) => sum + (index !== targetIndex && entry.locked ? entry.weight : 0),
    0,
  );
  const targetWeight = Math.min(requested, MAX_POOL_WEIGHT - lockedOtherTotal);
  next[targetIndex].weight = targetWeight;

  const adjustableIndexes = next
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) => index !== targetIndex && !entry.locked)
    .map(({ index }) => index);

  assignWeightsToTotal(
    next,
    adjustableIndexes,
    MAX_POOL_WEIGHT - lockedOtherTotal - targetWeight,
  );

  return sanitizeModelPool(next);
}

export function pickModelFromPool(pool: ModelPoolEntry[]): string {
  if (pool.length === 0) return "";
  if (pool.length === 1) return pool[0].modelId;

  const totalWeight = pool.reduce((sum, e) => sum + e.weight, 0);
  if (totalWeight <= 0) return pool[0].modelId;

  let r = Math.random() * totalWeight;
  for (const entry of pool) {
    r -= entry.weight;
    if (r <= 0) return entry.modelId;
  }
  return pool[pool.length - 1].modelId;
}

export function pickModelExcluding(
  pool: ModelPoolEntry[],
  exclude: Set<string>,
): string | null {
  const remaining = pool.filter((e) => !exclude.has(e.modelId));
  if (remaining.length === 0) return null;
  return pickModelFromPool(remaining);
}

export function getPoolPercentage(
  pool: ModelPoolEntry[],
  modelId: string,
): number {
  const total = pool.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) return 0;
  const entry = pool.find((e) => e.modelId === modelId);
  if (!entry) return 0;
  return Math.round((entry.weight / total) * 100);
}

export function getPoolPercentages(
  pool: ModelPoolEntry[],
): Array<{ modelId: string; pct: number }> {
  const total = pool.reduce((sum, e) => sum + e.weight, 0);
  if (total <= 0) return [];

  const raw = pool.map((e) => ({
    modelId: e.modelId,
    pct: (e.weight / total) * 100,
  }));

  const rounded = raw.map((e) => ({
    ...e,
    pct: Math.round(e.pct),
  }));

  const diff = 100 - rounded.reduce((s, e) => s + e.pct, 0);
  if (diff !== 0 && rounded.length > 0) {
    const diffIndex = Math.max(0, pool.findIndex((entry) => !entry.locked));
    rounded[diffIndex].pct += diff;
  }

  return rounded;
}

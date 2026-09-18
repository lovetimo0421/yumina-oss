export type ReviewDiffToken = {
  type: "added" | "removed" | "unchanged";
  text: string;
};

const TOKEN_PATTERN = /(\s+|[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]|[A-Za-z0-9_]+|.)/gu;
const MAX_TOKEN_MATRIX_CELLS = 1_500_000;
const MAX_CHUNK_MATRIX_CELLS = 250_000;
const CHUNK_SIMILARITY_THRESHOLD = 0.28;

function tokenizeReviewText(content: string) {
  return content.replace(/\r\n/g, "\n").match(TOKEN_PATTERN) ?? [];
}

function pushToken(tokens: ReviewDiffToken[], type: ReviewDiffToken["type"], text: string) {
  if (!text) return;
  if (type !== "unchanged" && text.trim().length === 0) return;
  const previous = tokens[tokens.length - 1];
  if (previous?.type === type) {
    previous.text += text;
    return;
  }
  tokens.push({ type, text });
}

function buildPrefixSuffixDiff(original: string, changed: string): ReviewDiffToken[] {
  let prefix = 0;
  while (
    prefix < original.length &&
    prefix < changed.length &&
    original[prefix] === changed[prefix]
  ) {
    prefix++;
  }

  let oldEnd = original.length - 1;
  let newEnd = changed.length - 1;
  while (
    oldEnd >= prefix &&
    newEnd >= prefix &&
    original[oldEnd] === changed[newEnd]
  ) {
    oldEnd--;
    newEnd--;
  }

  const tokens: ReviewDiffToken[] = [];
  pushToken(tokens, "unchanged", original.slice(0, prefix));
  pushToken(tokens, "removed", original.slice(prefix, oldEnd + 1));
  pushToken(tokens, "added", changed.slice(prefix, newEnd + 1));
  pushToken(tokens, "unchanged", original.slice(oldEnd + 1));
  return tokens;
}

export function buildReviewDiffTokens(original: string, changed: string): ReviewDiffToken[] {
  return buildTokenDiff(original, changed, true);
}

function buildTokenDiff(original: string, changed: string, useChunkFallback: boolean): ReviewDiffToken[] {
  if (original === changed) return [{ type: "unchanged", text: changed }];

  const oldTokens = tokenizeReviewText(original);
  const newTokens = tokenizeReviewText(changed);
  const result: ReviewDiffToken[] = [];
  let prefix = 0;

  while (
    prefix < oldTokens.length &&
    prefix < newTokens.length &&
    oldTokens[prefix] === newTokens[prefix]
  ) {
    pushToken(result, "unchanged", oldTokens[prefix]!);
    prefix++;
  }

  let oldEnd = oldTokens.length - 1;
  let newEnd = newTokens.length - 1;
  const suffix: string[] = [];
  while (
    oldEnd >= prefix &&
    newEnd >= prefix &&
    oldTokens[oldEnd] === newTokens[newEnd]
  ) {
    suffix.unshift(oldTokens[oldEnd]!);
    oldEnd--;
    newEnd--;
  }

  const removed = oldTokens.slice(prefix, oldEnd + 1);
  const added = newTokens.slice(prefix, newEnd + 1);
  if (removed.length * added.length > MAX_TOKEN_MATRIX_CELLS) {
    return useChunkFallback ? buildChunkAnchoredDiff(original, changed) : buildPrefixSuffixDiff(original, changed);
  }

  const dp: number[][] = Array.from({ length: removed.length + 1 }, () => Array(added.length + 1).fill(0));
  for (let i = removed.length - 1; i >= 0; i--) {
    for (let j = added.length - 1; j >= 0; j--) {
      dp[i]![j] = removed[i] === added[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  let i = 0;
  let j = 0;
  while (i < removed.length || j < added.length) {
    if (i < removed.length && j < added.length && removed[i] === added[j]) {
      pushToken(result, "unchanged", removed[i]!);
      i++;
      j++;
    } else if (j < added.length && (i >= removed.length || dp[i]![j + 1]! > dp[i + 1]![j]!)) {
      pushToken(result, "added", added[j]!);
      j++;
    } else if (i < removed.length) {
      pushToken(result, "removed", removed[i]!);
      i++;
    }
  }

  pushToken(result, "unchanged", suffix.join(""));
  return result;
}

function splitReviewChunks(content: string) {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized) return [];

  const chunks: string[] = [];
  const boundary = /[。！？!?；;\n]+/gu;
  let start = 0;

  while (boundary.exec(normalized) !== null) {
    const end = boundary.lastIndex;
    if (end > start) chunks.push(normalized.slice(start, end));
    start = end;
  }

  if (start < normalized.length) chunks.push(normalized.slice(start));
  return chunks.length > 0 ? chunks : [normalized];
}

function normalizeChunkKey(content: string) {
  return content
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(content: string) {
  return tokenizeReviewText(normalizeChunkKey(content)).filter((token) => token.trim().length > 0);
}

function chunkSimilarity(left: string, right: string) {
  const leftTokens = significantTokens(left);
  const rightTokens = significantTokens(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const rightCounts = new Map<string, number>();
  for (const token of rightTokens) {
    rightCounts.set(token, (rightCounts.get(token) ?? 0) + 1);
  }

  let shared = 0;
  for (const token of leftTokens) {
    const count = rightCounts.get(token) ?? 0;
    if (count <= 0) continue;
    shared++;
    if (count === 1) rightCounts.delete(token);
    else rightCounts.set(token, count - 1);
  }

  return (2 * shared) / (leftTokens.length + rightTokens.length);
}

function pushRawChunks(tokens: ReviewDiffToken[], type: ReviewDiffToken["type"], chunks: string[]) {
  for (const text of chunks) {
    pushToken(tokens, type, text);
  }
}

function flushChangedChunks(
  tokens: ReviewDiffToken[],
  removedChunks: string[],
  addedChunks: string[],
) {
  if (removedChunks.length === 0) {
    pushRawChunks(tokens, "added", addedChunks);
    return;
  }
  if (addedChunks.length === 0) {
    pushRawChunks(tokens, "removed", removedChunks);
    return;
  }

  for (const token of buildSimilarityAlignedChunkDiff(removedChunks, addedChunks)) {
    pushToken(tokens, token.type, token.text);
  }
}

function buildSimilarityAlignedChunkDiff(removedChunks: string[], addedChunks: string[]) {
  const dp: number[][] = Array.from({ length: removedChunks.length + 1 }, () => Array(addedChunks.length + 1).fill(0));
  const similarities: number[][] = Array.from({ length: removedChunks.length }, () => Array(addedChunks.length).fill(0));

  for (let i = removedChunks.length - 1; i >= 0; i--) {
    for (let j = addedChunks.length - 1; j >= 0; j--) {
      const similarity = chunkSimilarity(removedChunks[i]!, addedChunks[j]!);
      similarities[i]![j] = similarity;
      const matchScore = similarity >= CHUNK_SIMILARITY_THRESHOLD
        ? similarity + dp[i + 1]![j + 1]!
        : Number.NEGATIVE_INFINITY;
      dp[i]![j] = Math.max(matchScore, dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const tokens: ReviewDiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < removedChunks.length || j < addedChunks.length) {
    const similarity = i < removedChunks.length && j < addedChunks.length ? similarities[i]![j]! : 0;
    const matchScore = similarity >= CHUNK_SIMILARITY_THRESHOLD ? similarity + dp[i + 1]![j + 1]! : Number.NEGATIVE_INFINITY;

    if (
      i < removedChunks.length &&
      j < addedChunks.length &&
      matchScore >= dp[i + 1]![j]! &&
      matchScore >= dp[i]![j + 1]!
    ) {
      for (const token of buildTokenDiff(removedChunks[i]!, addedChunks[j]!, false)) {
        pushToken(tokens, token.type, token.text);
      }
      i++;
      j++;
    } else if (i < removedChunks.length && (j >= addedChunks.length || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      pushToken(tokens, "removed", removedChunks[i]!);
      i++;
    } else if (j < addedChunks.length) {
      pushToken(tokens, "added", addedChunks[j]!);
      j++;
    }
  }

  return tokens;
}

function buildChunkAnchoredDiff(original: string, changed: string): ReviewDiffToken[] {
  const oldChunks = splitReviewChunks(original);
  const newChunks = splitReviewChunks(changed);
  const oldKeys = oldChunks.map(normalizeChunkKey);
  const newKeys = newChunks.map(normalizeChunkKey);

  if (oldChunks.length * newChunks.length > MAX_CHUNK_MATRIX_CELLS) {
    const tokens: ReviewDiffToken[] = [];
    flushChangedChunks(tokens, oldChunks, newChunks);
    return tokens.length > 0 ? tokens : buildPrefixSuffixDiff(original, changed);
  }

  const dp: number[][] = Array.from({ length: oldChunks.length + 1 }, () => Array(newChunks.length + 1).fill(0));
  for (let i = oldChunks.length - 1; i >= 0; i--) {
    for (let j = newChunks.length - 1; j >= 0; j--) {
      dp[i]![j] = oldKeys[i] === newKeys[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const tokens: ReviewDiffToken[] = [];
  let removedRun: string[] = [];
  let addedRun: string[] = [];
  const flushRun = () => {
    flushChangedChunks(tokens, removedRun, addedRun);
    removedRun = [];
    addedRun = [];
  };

  let i = 0;
  let j = 0;
  while (i < oldChunks.length || j < newChunks.length) {
    if (i < oldChunks.length && j < newChunks.length && oldKeys[i] === newKeys[j]) {
      flushRun();
      pushToken(tokens, "unchanged", oldChunks[i]!);
      i++;
      j++;
    } else if (j < newChunks.length && (i >= oldChunks.length || dp[i]![j + 1]! > dp[i + 1]![j]!)) {
      addedRun.push(newChunks[j]!);
      j++;
    } else if (i < oldChunks.length) {
      removedRun.push(oldChunks[i]!);
      i++;
    }
  }

  flushRun();
  return tokens;
}

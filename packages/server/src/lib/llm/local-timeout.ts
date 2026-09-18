export function localGenerationTimeoutMs(): number {
  const raw = process.env.LOCAL_AI_TIMEOUT_MS?.trim();
  const value = raw ? Number(raw) : 600_000;
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647
    ? value
    : 600_000;
}

export async function readLocalStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const timeoutMs = localGenerationTimeoutMs();
  if (timeoutMs === 0) return { ...await reader.read(), timedOut: false as const };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read().then(result => ({ ...result, timedOut: false as const })),
      new Promise<{ done: true; value: undefined; timedOut: true }>(resolve => {
        timer = setTimeout(() => resolve({ done: true, value: undefined, timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

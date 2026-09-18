export class StorySummaryTruncatedError extends Error {
  constructor() {
    super("Summary model reached its output limit before completing the story summary; no summary was saved");
    this.name = "StorySummaryTruncatedError";
  }
}

export interface EpisodeCheckpoint {
  text: string;
  refusalFallbackUsed: boolean;
  split?: true;
}

/** Split a truncated episode once. Checkpoints reuse successful siblings and
 * halves on later attempts; incomplete output is never a checkpoint. */
export async function recoverSummaryEpisode(args: {
  transcript: string;
  generate: (text: string, recovery: boolean) => Promise<EpisodeCheckpoint>;
  load: (text: string, recovery: boolean) => Promise<EpisodeCheckpoint | null>;
  save: (text: string, result: EpisodeCheckpoint, recovery: boolean) => Promise<void>;
}): Promise<EpisodeCheckpoint[]> {
  const attempt = async (text: string, recovery = false) => {
    const cached = await args.load(text, recovery);
    if (cached?.split) throw new StorySummaryTruncatedError();
    if (cached) return cached;
    const result = await args.generate(text, recovery);
    await args.save(text, result, recovery);
    return result;
  };
  try {
    return [await attempt(args.transcript)];
  } catch (error) {
    if (!(error instanceof StorySummaryTruncatedError)) throw error;
    const chars = Array.from(args.transcript);
    if (chars.length < 2) throw error;
    const midpoint = Math.floor(chars.length / 2);
    // Remember the decision even if a half fails, so retries never resubmit
    // a parent already known to exceed the output budget.
    await args.save(args.transcript, { text: "", refusalFallbackUsed: false, split: true }, false);
    // Deliberately no recursion: a failure of either half is final.
    const first = await attempt(chars.slice(0, midpoint).join(""), true);
    const second = await attempt(chars.slice(midpoint).join(""), true);
    return [first, second];
  }
}

/** Fresh microphone evidence only; semantic VAD duration is not acoustic activity. */
export class VoiceActivityWindow {
  private samples: Array<{ at: number; active: boolean }> = [];
  constructor(private readonly onset: number) {}
  sample(at: number, level: number): boolean {
    const last = this.samples.at(-1);
    if (!Number.isFinite(at) || at < this.onset || last && at <= last.at) return false;
    this.samples.push({ at, active: Number.isFinite(level) && level >= 0.06 });
    const start = at - 600;
    while (this.samples.length > 1 && this.samples[1].at <= start) this.samples.shift();
    if (at - this.onset < 600) return false;
    let coverage = 0, lastActiveEnd = start, maxGap = 0, latestActive = -Infinity;
    for (let i = 0; i < this.samples.length; i++) {
      const sample = this.samples[i];
      if (!sample.active) continue;
      latestActive = sample.at;
      const from = Math.max(start, sample.at);
      const to = Math.min(at, sample.at + 75, this.samples[i + 1]?.at ?? at);
      if (to <= from) continue;
      maxGap = Math.max(maxGap, from - lastActiveEnd);
      coverage += to - from; lastActiveEnd = to;
    }
    maxGap = Math.max(maxGap, at - lastActiveEnd);
    return coverage >= 450 && at - latestActive <= 100 && maxGap <= 150;
  }
}
export const INPUT_SETTLEMENT_TIMEOUT_MS = 8_000;
export const meaningfulVoiceText = (text: string) => /[\p{L}\p{N}]/u.test(text);

// Policy bounds, not acoustic calibration or proof of speaker provenance.
export const OUTPUT_ECHO_TAIL_MS = 750;
export const INPUT_REFERENCE_WAIT_MS = 1_500;
export class VoiceQuietWindow {
  private start?: number;
  private last?: number;
  sample(at: number, level: number): boolean {
    if (!Number.isFinite(level) || level >= 0.06 || !Number.isFinite(at)) {
      this.start = this.last = undefined; return false;
    }
    if (this.last === undefined || at <= this.last || at - this.last > 150) this.start = at;
    this.last = at;
    // Destructive recovery must leave time for semantic endpointing to commit speech.
    return at - this.start! >= INPUT_SETTLEMENT_TIMEOUT_MS;
  }
}

/** Conservative lexical ambiguity check. A nonmatch is NOT acoustic attribution.
 * Keep mixed phrases intact and ask again instead of inventing cleaned speech. */
export function overlapsVoiceReference(text: string, reference: string): boolean {
  const normalize = (value: string): string[] => value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const words = normalize(text), official = normalize(reference);
  if (!words.length || !official.length) return true;
  // Padding keeps containment and phrase matching on whole token boundaries.
  const input = ` ${words.join(" ")} `, output = ` ${official.join(" ")} `;
  if (output.includes(input) || input.includes(output)) return true;
  // Ordinary shared vocabulary is expected in replies; a mixed phrase needs
  // at least three consecutive matching tokens to remain lexically ambiguous.
  return words.some((word, index) => index >= 2
    && output.includes(` ${words[index - 2]} ${words[index - 1]} ${word} `));
}

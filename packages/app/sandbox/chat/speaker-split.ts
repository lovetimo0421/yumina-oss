/**
 * One AI reply, several people talking: split it into a bubble per speaker.
 *
 * The busiest cards on the platform (idol simulators, group scenes) wrote
 * this by hand in a custom renderer. A line that opens with a character's
 * name — `沈霏：`, `沈霏:`, `【沈霏】`, `**沈霏**：` — starts that character's
 * bubble; text before the first one is narration. Only when at least two
 * named bubbles come out, or one plus narration, does the reply split.
 */
export interface SpeakerSegment {
  /** The character's name as written in the card, or null for narration. */
  speaker: string | null;
  text: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function splitBySpeaker(text: string, names: readonly string[]): SpeakerSegment[] | null {
  const clean = names.map((n) => n.trim()).filter((n) => n.length > 0 && n.length <= 30);
  if (clean.length === 0 || !text.trim()) return null;
  const alt = clean.sort((a, b) => b.length - a.length).map(esc).join("|");
  const opener = new RegExp(`^\\s*(?:\\*\\*|【|\\[)?(${alt})(?:\\*\\*|】|\\])?\\s*(?:[:：]|(?<=】|\\]))\\s*`);
  const segments: SpeakerSegment[] = [];
  for (const line of text.split("\n")) {
    const m = opener.exec(line);
    if (m) {
      segments.push({ speaker: m[1]!, text: line.slice(m[0].length) });
    } else if (segments.length === 0) {
      segments.push({ speaker: null, text: line });
    } else {
      segments[segments.length - 1]!.text += `\n${line}`;
    }
  }
  const out = segments.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text.length > 0);
  const named = out.filter((s) => s.speaker).length;
  if (named === 0 || out.length < 2) return null;
  return out;
}

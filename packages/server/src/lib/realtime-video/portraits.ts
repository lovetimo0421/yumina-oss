// Which of a card's portraits a film picture should use, and under which name; and who the player
// is, so no picture draws them.

export type CastMember = { name: string; look: string; entry?: string };
export type PortraitEntry = { name: string; portrait: string };
/** Character label -> the names an English shot calls them by (full name, given name). */
export type CharacterNames = Record<string, string[]>;
/** The player is filmed first-person and never shown, so their own portrait joins no picture. */
const PLAYER_ENTRY_RE = /[（(]\s*(?:you|你|您|tú|tu|vous|toi|du|あなた|당신)\s*[)）]/i;

type SchemaEntry = { name?: string; enabled?: boolean; portrait?: string; role?: string; content?: string };
const entriesOf = (schema: unknown): SchemaEntry[] => ((schema as { entries?: SchemaEntry[] }).entries ?? []).filter((e) => e.enabled !== false && !!e.name);

/** The card's characters that have a portrait. */
export function portraitEntries(schema: unknown): PortraitEntry[] {
  return entriesOf(schema)
    .filter((e) => e.portrait && !PLAYER_ENTRY_RE.test(e.name!))
    .map((e) => ({ name: e.name!, portrait: e.portrait! }));
}

/** The card's entries for the player ("哈利·波特（你）", "Harry Potter (you)"). */
export function playerEntries(schema: unknown): { name: string; content: string }[] {
  return entriesOf(schema).filter((e) => PLAYER_ENTRY_RE.test(e.name!)).map((e) => ({ name: e.name!, content: e.content ?? "" }));
}

/** The characters whose English names a film needs: who has a portrait, and the player. */
export function namedCharacters(schema: unknown): { name: string; content: string }[] {
  return entriesOf(schema)
    .filter((e) => e.portrait || PLAYER_ENTRY_RE.test(e.name!))
    .map((e) => ({ name: e.name!, content: e.content ?? "" }));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordAt = (text: string, name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, "u").exec(text)?.index ?? -1;

/** Who with a portrait a prompt shows, in order of first mention (max 3), under the name the
 *  prompt uses: the entry's own name, one of its English names (`names`), or the name the director
 *  gave them in the cast. Shots are English, so a Chinese card's 「德拉科妮娅·马尔福」 only appears as
 *  "Draconia Malfoy": on prod her portrait was never used, and the director's own tagging of who is
 *  who missed her in one film of two (2026-10-19). */
export function matchPortraits(entries: PortraitEntry[], prompt: string, cast: CastMember[] = [], names: CharacterNames = {}): { entry: PortraitEntry; name: string }[] {
  const found = entries.map((entry) => {
    let at = prompt.indexOf(entry.name);
    let name = entry.name;
    const called = [...(names[entry.name] ?? [])];
    for (const p of cast) {
      if (p.entry !== entry.name || !p.name) continue;
      // The full name, else the given name alone (a family name is shared: Lucius is a Malfoy too).
      const given = p.name.split(/\s+/)[0] ?? "";
      called.push(p.name, ...(given.length >= 3 && given !== p.name ? [given] : []));
    }
    for (const n of called) {
      const i = n.length >= 3 ? wordAt(prompt, n) : -1;
      // Named by her given name alone, she is still called by her full name in the prompt's picture list.
      if (i >= 0 && (at < 0 || i < at)) { at = i; name = called.filter((c) => c.includes(n)).sort((a, b) => b.length - a.length)[0] ?? n; }
    }
    return { entry, name, at };
  });
  return found.filter((x) => x.at >= 0).sort((a, b) => a.at - b.at).slice(0, 3).map(({ entry, name }) => ({ entry, name }));
}

/** The cast that a picture prompt names, with their looks: those without a portrait (the picture
 *  has no other way to know them), or with `all` everyone (who is who in a plate). Named in full or by a part of the name nobody else in the cast has
 *  ("Myrtle" for Moaning Myrtle; not "Malfoy", which Lucius shares). Up to `max`, by first mention. */
export function describedCast(cast: CastMember[], prompt: string, max = 3, all = false): { name: string; look: string }[] {
  const partsOf = (name: string) => name.split(/\s+/).filter((w) => w.length >= 3);
  return cast
    .filter((p) => (all || !p.entry) && p.name && p.look)
    .map((p) => {
      const shared = new Set(cast.filter((o) => o !== p).flatMap((o) => partsOf(o.name)));
      const ats = [p.name, ...partsOf(p.name).filter((w) => !shared.has(w))].map((n) => wordAt(prompt, n)).filter((i) => i >= 0);
      return { name: p.name, look: p.look, at: ats.length ? Math.min(...ats) : -1 };
    })
    .filter((x) => x.at >= 0)
    .sort((a, b) => a.at - b.at)
    .slice(0, max)
    .map(({ name, look }) => ({ name, look }));
}

/** A shot or scene state with the player named as a person ("sits down opposite Harry") turned
 *  into the camera ("opposite you"): pictures drew the named player into the frame, in every plate
 *  of a scene state that named him (2026-10-19). Longest names first, possessives too. */
export function asCamera(text: string, playerNames: string[]): string {
  let out = text;
  for (const n of [...new Set(playerNames)].filter((n) => n.length >= 3).sort((a, b) => b.length - a.length)) {
    out = out
      .replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(n)}['’]s(?![\\p{L}\\p{N}])`, "gu"), "your")
      .replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(n)}(?![\\p{L}\\p{N}])`, "gu"), "you");
  }
  return out;
}

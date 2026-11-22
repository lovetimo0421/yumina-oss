/**
 * A new card that has no name of its own yet is called after the untitled
 * default, numbered so a creator's drafts tell apart in their library:
 * "Untitled World", then "Untitled World 1", "Untitled World 2", …
 */
export function nextUntitledName(base: string, taken: Iterable<string>): string {
  const stem = base.trim();
  let baseTaken = false;
  let highest = 0;
  for (const name of taken) {
    const text = name.trim();
    if (text === stem) { baseTaken = true; continue; }
    if (!text.startsWith(`${stem} `)) continue;
    const tail = text.slice(stem.length + 1);
    if (/^\d{1,6}$/.test(tail)) highest = Math.max(highest, Number(tail));
  }
  if (!baseTaken && highest === 0) return stem;
  return `${stem} ${highest + 1}`;
}

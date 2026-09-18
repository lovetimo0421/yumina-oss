export interface LoreSlotDescriptor {
  slotId: string;
  file: string;
  line: number;
}

/**
 * Scan rootComponent TSX sources for the frontend lore controls and return the
 * slot ids they bind to. Detects both the low-level `<LoreSlot id="…" />` and
 * the high-level helpers creators actually write — `<LoreButton slotId="…">`,
 * `<LoreSwitch slotId="…">` and `<LoreGroup slots={[{ id: "…" }]}>` — which
 * render LoreSlots internally. The editor's bindings view relies on this, so it
 * must see the helpers too.
 */
export function extractLoreSlotsFromFiles(
  files: Record<string, string>,
): LoreSlotDescriptor[] {
  const seen = new Set<string>();
  const results: LoreSlotDescriptor[] = [];

  const lineAt = (source: string, index: number): number =>
    source.slice(0, Math.max(0, index)).split("\n").length;

  const push = (file: string, rawId: string, line: number) => {
    const slotId = rawId.trim();
    if (!slotId || seen.has(`${file}:${slotId}`)) return;
    seen.add(`${file}:${slotId}`);
    results.push({ slotId, file, line });
  };

  for (const [file, source] of Object.entries(files)) {
    if (typeof source !== "string") continue;
    if (!source.includes("Lore")) continue;

    // <LoreSlot id="x" />, <LoreButton slotId="x" />, <LoreSwitch slotId="x" />
    const tagRe = /<Lore(?:Slot|Button|Switch)\b[^>]*?\b(?:slotId|id)=(?:\{\s*)?["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(source)) !== null) {
      push(file, m[1]!, lineAt(source, m.index));
    }

    // <LoreGroup slots={[{ id: "a" }, { id: "b" }]}> — pull ids out of the array
    const groupRe = /<LoreGroup\b[\s\S]*?\bslots=\{(\[[\s\S]*?\])\}/g;
    while ((m = groupRe.exec(source)) !== null) {
      const arrText = m[1]!;
      const arrStart = m.index;
      const idRe = /\bid:\s*["']([^"']+)["']/g;
      let im: RegExpExecArray | null;
      while ((im = idRe.exec(arrText)) !== null) {
        push(file, im[1]!, lineAt(source, arrStart + im.index));
      }
    }
  }

  return results.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
}

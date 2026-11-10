import type { WorldVersion } from "@yumina/shared";

export type VersionListItem =
  | { kind: "version"; version: WorldVersion }
  | { kind: "autosaves"; versions: WorldVersion[] };

/**
 * Autosave checkpoints arrive every quarter hour of editing. Like Figma, a run of
 * them next to each other folds into one row; anything else (a publish, a
 * backup before a restore) stands on its own and ends the run.
 */
export function foldAutosaves(versions: WorldVersion[]): VersionListItem[] {
  const out: VersionListItem[] = [];
  let run: WorldVersion[] = [];
  const close = () => {
    if (run.length === 1) out.push({ kind: "version", version: run[0]! });
    else if (run.length > 1) out.push({ kind: "autosaves", versions: run });
    run = [];
  };
  for (const v of versions) {
    if (v.source === "autosave") { run.push(v); continue; }
    close();
    out.push({ kind: "version", version: v });
  }
  close();
  return out;
}

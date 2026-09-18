import type { WorldChange } from "@yumina/engine";

export type ChangeTone = "added" | "removed" | "modified";

export interface ChangeLabel {
  i18nKey: string;     // studio.changeLog.opAdded | opRemoved | opModified
  kindKey: string;     // studio.changeLog.kind.<kind>
  name: string;
  tone: ChangeTone;
}

const OP_KEY: Record<WorldChange["op"], string> = {
  added: "studio.changeLog.opAdded",
  removed: "studio.changeLog.opRemoved",
  modified: "studio.changeLog.opModified",
};

export function changeLabel(change: WorldChange): ChangeLabel {
  return {
    i18nKey: OP_KEY[change.op],
    kindKey: `studio.changeLog.kind.${change.kind}`,
    name: change.name ?? change.id ?? "",
    tone: change.op,
  };
}

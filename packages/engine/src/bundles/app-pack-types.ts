/** Shared shape of one App pack definition. One file per pack under
 *  `app-pack-defs/`, UI source under `packages/engine/app-packs/<id>.tsx`. */
export type AppPackLanguage = "zh" | "en" | "es";

export interface AppPackWords {
  /** Name in the dock and the editor picker. */
  name: string;
  /** What the player gets, one or two sentences, for the picker. */
  description: string;
  /** Name of the variable it installs (shown in the Variables list). */
  variableName: string;
  /** The variable's behaviorRules: data shape + when the AI changes it. */
  rules: string;
}

export interface AppPackDef {
  icon: string;
  /** `app_<id>` — the UI source must use the same id in `const VAR`. */
  variableId: string;
  defaultValue: Record<string, unknown>;
  /** Sample data the editor's live preview renders, per language. */
  sample: Record<AppPackLanguage, Record<string, unknown>>;
  words: Record<AppPackLanguage, AppPackWords>;
}

/**
 * Installed resource packs (资源包), as the Studio assistant and outside agents
 * see them. A pack's settings are not stored anywhere of their own: each field
 * writes its value into one of the card's variables (that variable's default,
 * at an optional dot path inside a json variable). So "change the pack's
 * voice" means "write that variable", and the assistant needs to know which
 * variable, which path, and what is there now.
 *
 * Shapes mirror the app's InstalledBundle record (schema.installedBundles[])
 * and BundleSettingField; read loosely so older records and fields this
 * server does not know yet never break the summary.
 */

export interface BundleSettingField {
  id: string;
  label: string;
  hint?: string;
  type: "text" | "textarea" | "number" | "toggle" | "select" | "asset" | "voice" | "liveCharacter";
  variableId: string;
  path?: string;
  options?: { value: string; label: string }[];
  accept?: string;
  extensionRules?: { ext: string; path?: string; also?: { path: string; value: unknown }[] }[];
  also?: { path: string; value: unknown }[];
}

export interface InstalledPackSetting {
  id: string;
  label: string;
  type: string;
  variableId: string;
  path?: string;
  /** The value now in that variable's default at that path (undefined = unset). */
  value: unknown;
  hint?: string;
  options?: { value: string; label: string }[];
  accept?: string;
  extensionRules?: BundleSettingField["extensionRules"];
  also?: BundleSettingField["also"];
  /** The variable the field writes is gone from the card. */
  missingVariable?: true;
}

export interface InstalledPack {
  name: string;
  sourceBundleId: string | null;
  version: number | null;
  kind: string | null;
  /** Where the pack's interface files sit (`_bundles/<slug>/`); null when it brought none. */
  interfaceFolder: string | null;
  settings: InstalledPackSetting[];
}

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose => !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** Read `a.b[0].c` out of a value; undefined when any step is missing. */
export function readPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const part of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else if (isObject(current)) current = current[part];
    else return undefined;
  }
  return current;
}

function readSetting(raw: unknown, variables: Map<string, unknown>): InstalledPackSetting | null {
  if (!isObject(raw)) return null;
  const variableId = str(raw.variableId);
  if (!variableId) return null;
  const path = str(raw.path);
  const known = variables.has(variableId);
  const setting: InstalledPackSetting = {
    id: str(raw.id) ?? variableId,
    label: str(raw.label) ?? str(raw.id) ?? variableId,
    type: str(raw.type) ?? "text",
    variableId,
    ...(path ? { path } : {}),
    value: known ? readPath(variables.get(variableId), path) : undefined,
  };
  const hint = str(raw.hint);
  if (hint) setting.hint = hint;
  if (Array.isArray(raw.options)) {
    setting.options = raw.options
      .filter(isObject)
      .map((o) => ({ value: String(o.value ?? ""), label: String(o.label ?? o.value ?? "") }));
  }
  const accept = str(raw.accept);
  if (accept) setting.accept = accept;
  if (Array.isArray(raw.extensionRules)) setting.extensionRules = raw.extensionRules.filter(isObject) as InstalledPackSetting["extensionRules"];
  if (Array.isArray(raw.also)) setting.also = raw.also.filter(isObject) as InstalledPackSetting["also"];
  if (!known) setting.missingVariable = true;
  return setting;
}

/** The card's installed packs with their settings and current values; [] when none. */
export function installedPacks(world: unknown): InstalledPack[] {
  if (!isObject(world) || !Array.isArray(world.installedBundles) || world.installedBundles.length === 0) return [];
  const variables = new Map<string, unknown>();
  for (const v of Array.isArray(world.variables) ? world.variables : []) {
    if (isObject(v) && typeof v.id === "string") variables.set(v.id, v.defaultValue);
  }
  return world.installedBundles.filter(isObject).map((record) => ({
    name: str(record.name) ?? "(unnamed pack)",
    sourceBundleId: str(record.sourceBundleId) ?? null,
    version: typeof record.version === "number" ? record.version : null,
    kind: str(record.kind) ?? null,
    interfaceFolder: str(record.slug) ? `_bundles/${str(record.slug)}/` : null,
    settings: (Array.isArray(record.settings) ? record.settings : [])
      .map((field) => readSetting(field, variables))
      .filter((field): field is InstalledPackSetting => field !== null),
  }));
}

/** How the assistant changes a pack's settings (said once, only when a pack is installed). */
export const INSTALLED_PACKS_INSTRUCTION =
  "A pack's settings live in the card's variables: to change one, write that variable with write_variable, " +
  "setting its defaultValue so the value sits at the field's path (for a json variable, send the whole object with only that path changed). " +
  "An asset field's value is \"@asset:<id>\" of a file in the creator's library, placed by the field's extensionRules for the file's extension " +
  "(the rule's path instead of the field's, plus each `also` path/value); a select takes one of its option values; " +
  "a voice field takes the voiceId of one of the creator's own voices (list_voices); a liveCharacter field takes \"@rig:<id>\" of one of their live characters " +
  "(make_live_character with the picture it was made from returns it, at no charge when it exists), and with either, also write the field's `also` path/values. " +
  "Do not edit a pack's own entries, behaviors or interface files to change a setting. " +
  "The one exception is fitting an installed interface to this card, when the creator asks for it: then edit only that pack's interface files " +
  "(its folder is listed below), keep its layout, panels and features, and replace hard-coded numbers, names, places and text with this card's own variables and lore. " +
  "When the interface needs something the card lacks, ask the creator whether to add a variable or remove that panel; never guess. " +
  "To find an interface to use, the creator opens + → 套用界面模板 on the canvas (the 资源包 drawer filtered to 界面); you cannot install packs yourself.";

function show(value: unknown): string {
  if (value === undefined) return "(unset)";
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/** Compact text block for the assistant's inventory; "" when no pack is installed. */
export function installedPacksInventory(world: unknown): string {
  const packs = installedPacks(world);
  if (packs.length === 0) return "";
  const lines = [`\nINSTALLED PACKS (${packs.length}) — resource packs from the hub. ${INSTALLED_PACKS_INSTRUCTION}`];
  for (const pack of packs) {
    const meta = [
      pack.sourceBundleId ? `bundle ${pack.sourceBundleId}` : "local",
      pack.version !== null ? `v${pack.version}` : "",
      pack.kind ?? "",
      pack.interfaceFolder ? `interface files in ${pack.interfaceFolder}` : "",
    ].filter(Boolean).join(", ");
    lines.push(`  "${pack.name}" (${meta})${pack.settings.length ? "" : " — no settings"}`);
    for (const s of pack.settings) {
      const target = `${s.variableId}${s.path ? `.${s.path}` : ""}`;
      const extra: string[] = [];
      if (s.options?.length) extra.push(`options: ${s.options.map((o) => o.value).join(" | ")}`);
      if (s.accept) extra.push(`accept: ${s.accept}`);
      if (s.also?.length) extra.push(`also: ${s.also.map((a) => `${a.path}=${JSON.stringify(a.value)}`).join(",")}`);
      if (s.extensionRules?.length) {
        extra.push(`by extension: ${s.extensionRules.map((r) => `${r.ext}→${r.path ?? "(field path)"}${r.also?.length ? ` +${r.also.map((a) => `${a.path}=${JSON.stringify(a.value)}`).join(",")}` : ""}`).join("; ")}`);
      }
      if (s.missingVariable) extra.push("VARIABLE MISSING");
      lines.push(`    - ${s.label} [${s.type}] → ${target} = ${show(s.value)}${extra.length ? ` (${extra.join("; ")})` : ""}`);
    }
  }
  return lines.join("\n");
}

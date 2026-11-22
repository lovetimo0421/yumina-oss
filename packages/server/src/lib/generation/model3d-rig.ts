/**
 * "Picture to moving 3D character" (the to-3d-character tool): one job, two fal runs.
 *
 * 1. Rodin 2.5 makes the model from the picture, asked for a T/A pose (`TAPose`), which is what an auto-rigger
 *    needs: arms away from the body, legs apart, facing +Z.
 * 2. Hyper3D's rigger puts a 52-bone human skeleton in it (Hips … Head, fingers; the names three.js examples and
 *    Mixamo use) and bakes up to ten motions from its library onto it. It is handed Rodin's own file by its fal
 *    link: the rigger refuses data URIs, files already rigged, and meshopt-compressed files (which is what lands
 *    in a creator's assets), so the raw file never passes through us between the two runs.
 *
 * The rigger answers one .glb with the skin and every motion as an animation named by its library id
 * (human_000090); the clips are renamed to words a card can ask for ("idle", "walk", "sit") before the file is
 * brought to a card's budget with the other 3D models (model3d-optimize.ts).
 *
 * Request bodies as run on 2026-11-14 (fal OpenAPI for fal-ai/hyper3d/rigging and the animations list).
 */

export const RIG_ENDPOINT = "fal-ai/hyper3d/rigging";
export const RIG_MAX_MOTIONS = 10;

/**
 * Hyper3D's human motion library (fal-ai/hyper3d/rigging/animations, 2026-11-14), id suffix → the name the clip
 * gets in the file. Library names repeat ("idle" four times); repeats are numbered. A few common ones are given
 * the short word a card would ask for: idle, walk, sit, jog.
 */
export const RIG_MOTIONS: ReadonlyArray<readonly [string, string]> = [
  ["000000", "arm stretching"], ["000001", "batter on deck"], ["000002", "big jump"], ["000003", "big stomach hit"],
  ["000004", "boxing"], ["000005", "brutal assassination"], ["000006", "crawl backwards"], ["000007", "cross jumps rotation"],
  ["000008", "rifle stealth walk"], ["000009", "dancing maraschino step"], ["000010", "dancing twerk"], ["000011", "death from right"],
  ["000012", "drunk idle"], ["000013", "dwarf idle"], ["000014", "dying"], ["000015", "entry"], ["000016", "fishing cast"],
  ["000017", "flare"], ["000018", "flying kick"], ["000019", "forward jump"], ["000020", "frisbee throw"], ["000021", "goalie throw"],
  ["000022", "goalkeeper overhand throw"], ["000023", "golf drive"], ["000024", "goofy running"], ["000025", "happy idle"],
  ["000026", "head hit"], ["000027", "hip hop dancing"], ["000028", "injured run"], ["000029", "jog"], ["000030", "joyful jump"],
  ["000031", "jumping"], ["000032", "kicking"], ["000033", "kidney hit"], ["000034", "kip up"], ["000035", "leg sweep"],
  ["000036", "low crawl"], ["000037", "moonwalk"], ["000038", "mutant jump attack"], ["000039", "northern soul spin"],
  ["000040", "offensive idle"], ["000041", "pointing forward"], ["000042", "quick roll to run"], ["000043", "receiving an uppercut"],
  ["000044", "run backward"], ["000045", "run look back"], ["000046", "naruto run"], ["000047", "running jump"],
  ["000048", "running slide"], ["000049", "carry run"], ["000050", "sad idle"], ["000051", "salsa dancing"], ["000052", "salute"],
  ["000053", "scary clown walk"], ["000054", "shoulder hit and fall"], ["000055", "singing"], ["000056", "sit fidget"],
  ["000057", "sit ups"], ["000058", "snake hip hop dance"], ["000059", "standing melee kick"], ["000060", "standing react death left"],
  ["000061", "swimming"], ["000062", "swing dancing"], ["000063", "taunt"], ["000064", "throw"], ["000065", "throwing"],
  ["000066", "twist dance"], ["000067", "two cycle sprint"], ["000068", "two handed sword death"], ["000069", "limping walk"],
  ["000070", "zombie crawl"], ["000071", "zombie scratch idle"], ["000072", "zombie stumbling"], ["000073", "crouched walking"],
  ["000074", "dying 2"], ["000075", "hip hop dancing 2"], ["000076", "kicking 2"], ["000077", "sideways run"], ["000078", "turn run"],
  ["000079", "salsa dancing 2"], ["000080", "sit shake foot"], ["000081", "standing death backward"], ["000082", "staggering walk"],
  ["000084", "martelo"], ["000085", "sit"], ["000086", "tiptoe walk"], ["000087", "staggering walk 2"], ["000088", "elegant walk"],
  ["000089", "walk"], ["000090", "idle"], ["000091", "idle 2"], ["000092", "idle 3"], ["000093", "idle 4"], ["000094", "aiming gun"],
  ["000095", "drawing gun"], ["000096", "female peek and aim"], ["000097", "femme peek around corner"], ["000098", "gunplay"],
  ["000099", "pistol idle"], ["000100", "pistol jump"], ["000101", "pistol kneeling idle"], ["000102", "gun prone left"],
  ["000103", "reloading"], ["000104", "rifle crouch backward walk"], ["000105", "rifle run to dying"], ["000106", "rifle run to stop"],
  ["000107", "rifle idle"], ["000108", "shooting"], ["000109", "gun turn left"], ["000110", "gun turn right"],
  ["000111", "walk with rifle"], ["000112", "gunplay 2"], ["000113", "gunplay 3"],
];

/** What a character gets when nothing is asked for: standing, moods, getting about, a few gestures. */
export const RIG_DEFAULT_MOTIONS = ["idle", "happy idle", "sad idle", "walk", "jog", "sit", "pointing forward", "salute", "joyful jump", "taunt"] as const;

const byName = new Map(RIG_MOTIONS.map(([id, name]) => [name, id]));
const byId = new Map(RIG_MOTIONS.map(([id, name]) => [id, name]));
const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

/** The motions a run asks for, as library ids: the creator's list (names or human_000xxx ids, comma or newline
 *  separated; unknown ones are reported), always with "idle" first, at most ten. Empty: the default set. */
export function resolveRigMotions(text: unknown): { ids: string[]; unknown: string[] } {
  const asked = typeof text === "string" ? text.split(/[,\n;，、]/).map(norm).filter(Boolean) : [];
  const names = asked.length ? asked : [...RIG_DEFAULT_MOTIONS];
  const ids: string[] = [];
  const unknown: string[] = [];
  const add = (id: string) => { if (!ids.includes(id) && ids.length < RIG_MAX_MOTIONS) ids.push(id); };
  add(byName.get("idle")!);
  for (const n of names) {
    const id = byName.get(n) ?? (/^(human )?\d{6}$/.test(n) ? n.slice(-6) : undefined);
    if (id && byId.has(id)) add(id);
    else unknown.push(n);
  }
  return { ids: ids.map((id) => `human_${id}`), unknown };
}

/** The clip names a rigged file's animations get: human_000090 → "idle". */
export function rigClipNames(): Record<string, string> {
  return Object.fromEntries(RIG_MOTIONS.map(([id, name]) => [`human_${id}`, name]));
}

/** Rodin, asked for a model a rigger can work with. 50k triangles is what the rigger handles quickly; the
 *  textures stay 2K for a face seen up close. */
export function characterFalInput(imageUrl: string | undefined): Record<string, unknown> {
  return { image_urls: [imageUrl], TAPose: true, material: "PBR", geometry_file_format: "glb", quality_mesh_option: "50K Triangle" };
}

/**
 * The rigger's request. Skin weights are always "core": the default pulls a chibi's long hair into spikes when
 * the head turns, and on a regular figure core looks the same in every motion tried (2026-11-14, both run).
 */
export function rigFalInput(modelUrl: string, motionIds: string[]): Record<string, unknown> {
  return {
    model_url: modelUrl, bone_template: "human", animation_presets: motionIds, in_place: true, geometry_file_format: "glb",
    skinning_method: "core",
  };
}

/** The file to land from the rigger's answer: `model_mesh` carries the skin and every motion; the separate
 *  rigged_character_glb has the skin alone. */
export function riggedFile(result: Record<string, unknown>): unknown {
  return result.model_mesh ?? result.rigged_character_glb;
}

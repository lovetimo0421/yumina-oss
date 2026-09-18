import type { GameState } from "../types/index.js";

/** Explicitly opted-in card rules; no framework, network, or generated code. */
export const POISON_SYSTEM = "kochuu-survival-v1";
export const POISON_ROSTER = "佐倉井君華,鳳惠介,沢村進,椎葉梨花,有沢悠平,,館林颯太,加須一輝,佐野琉,栗園穂花,前田蓮,斎藤晃,浅井凌,小野寺隼,永瀬桐人,三宅結衣,岸本朔,宮下芹奈,田村壮馬,上原千尋,黒木蒼,中島遥,松本雄哉,綾瀬美月,藤原颯,河野晴香,桐島拓海,西村柚希,大沢律,長谷川凪,木村蛍,石井湊,荒木紗良,坂本亘,野口陽菜,土屋柊,八木沼凛,丸山透,福田伊吹,鏑木阳一".split(",");
export const POISON_BAGS: Record<string, string[]> = {
  "沉重帆布包": ["手斧", "绳索", "手电筒", "压缩干粮×6", "水×3"],
  "医疗急救箱": ["医用剪刀", "绷带×3", "消毒液", "止痛药×2", "压缩干粮×6", "水×3"],
  "学生会公文包": ["信号枪", "照明弹×2", "手绘区域地图", "压缩干粮×6", "水×3"],
};
export function poisonName(value: unknown): string {
  const variants: Record<string,string> = { "恵":"惠","蔵":"仓","倉":"仓","華":"华","鳳":"凤","澤":"泽","沢":"泽","進":"进","葉":"叶","館":"馆","颯":"飒","須":"须","輝":"辉","園":"园","穂":"穗","蓮":"莲","斎":"斋","齋":"斋","淺":"浅","瀬":"濑","瀨":"濑","結":"结","宮":"宫","壯":"壮","馬":"马","尋":"寻","黒":"黑","蒼":"苍","島":"岛","嶋":"岛","遙":"遥","綾":"绫","長":"长","蛍":"萤","螢":"萤","湊":"凑","紗":"纱","亙":"亘","陽":"阳","凜":"凛","鏑":"镝" };
  return String(value ?? "").trim().replace(/[（(].*?[）)]/g, "").replace(/\s/g, "").split("").map(c => variants[c] || c).join("");
}
/** The card's clock is a three-phase cycle, but saves written before this
 *  system existed hold whatever the model wrote — "深夜", "傍晚", "morning",
 *  "推进至 下午(后期)". Mapping those back onto the cycle is what keeps such a
 *  save from freezing: an unmatched period makes every later change illegal,
 *  so the clock, the day counter and the ending all stop for good. */
const POISON_PERIOD_ALIASES: Array<[string, string]> = [
  ["上午", "上午"], ["早上", "上午"], ["早晨", "上午"], ["清晨", "上午"], ["黎明", "上午"],
  ["拂晓", "上午"], ["破晓", "上午"], ["白天", "上午"], ["中午", "上午"], ["正午", "上午"],
  ["morning", "上午"], ["dawn", "上午"], ["noon", "上午"], ["daytime", "上午"],
  ["下午", "下午"], ["午后", "下午"], ["傍晚", "下午"], ["黄昏", "下午"],
  ["afternoon", "下午"], ["evening", "下午"], ["dusk", "下午"],
  ["夜晚", "夜晚"], ["晚上", "夜晚"], ["深夜", "夜晚"], ["半夜", "夜晚"], ["凌晨", "夜晚"],
  ["夜间", "夜晚"], ["夜", "夜晚"], ["night", "夜晚"], ["midnight", "夜晚"],
];
const POISON_NEXT_PERIOD: Record<string, string> = { "上午": "下午", "下午": "夜晚", "夜晚": "上午" };

/** Canonical phase for any free-text period, or null when nothing matches. */
export function poisonPeriod(value: unknown): string | null {
  const text = String(value ?? "").toLowerCase();
  let best: { end: number; length: number; period: string } | null = null;
  for (const [alias, period] of POISON_PERIOD_ALIASES) {
    const index = text.lastIndexOf(alias.toLowerCase());
    if (index < 0) continue;
    // "上午→下午" and "夜晚 → 深夜" name their target last, so the match that
    // ends furthest right wins; the longest one breaks ties so "afternoon"
    // never reads as the "noon" inside it.
    const end = index + alias.length;
    if (!best || end > best.end || (end === best.end && alias.length > best.length)) {
      best = { end, length: alias.length, period };
    }
  }
  return best ? best.period : null;
}

/** The value to store for a period change, or null when it must be ignored. */
export function poisonPeriodAdvance(oldValue: unknown, newValue: unknown): string | null {
  const to = poisonPeriod(newValue);
  if (to === null) return null;
  const from = poisonPeriod(oldValue);
  // A clock already sitting on an unreadable value re-syncs on the next legible
  // write rather than staying stuck for the rest of the run.
  if (from === null) return to;
  return POISON_NEXT_PERIOD[from] === to ? to : null;
}

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function array(value: unknown): unknown[] {
  try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function points(value: unknown): number { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0; }

/** Return a new snapshot. Historical points are preserved once, then only new victims award KP. */
export function settlePoisonState(input: GameState): GameState {
  const state = { ...input, variables: { ...input.variables }, metadata: { ...input.metadata } };
  const v = state.variables;
  const prior = record(state.metadata.poison);
  const setup = record(v["player-setup"]);
  let initialized = prior.initialized === true;
  if (!v["player-name"] && state.turnCount > 0) v["player-name"] = "無名の生徒";
  if (!initialized && !v["player-name"] && state.turnCount === 0 && typeof setup.name === "string" && setup.name.trim()) {
    const name = setup.name.trim().slice(0, 80);
    if (POISON_ROSTER.some(n => n && poisonName(n) === poisonName(name)) || /権藤|权藤/.test(name)) return input;
    const bag = typeof setup.bag === "string" && Object.hasOwn(POISON_BAGS, setup.bag) ? setup.bag : "沉重帆布包";
    v["player-name"] = name;
    for (const field of ["gender", "class", "personality", "relation", "weakness", "desc"]) v["player-" + field] = String(setup[field] ?? "").slice(0, 2000);
    v["player-weapon-pref"] = bag;
    v.inventory = POISON_BAGS[bag]!.slice(1);
    v["user-weapon"] = POISON_BAGS[bag]![0]!;
    v["day-count"] = 1; v["time-period"] = "上午"; v.health = 100; v.hunger = 100;
    initialized = true;
  }
  const player = String(v["player-name"] || "");
  const roster = POISON_ROSTER.map(n => n || player);
  const names = new Map(roster.filter(Boolean).map(n => [poisonName(n), n]));
  // The card's own lorebook titles several students by surname alone ("馆林",
  // "佐野", "加須"), so broadcasts name them that way too. Exact-only matching
  // dropped every such kill out of the ledger; a prefix or suffix counts as
  // long as it points at exactly one student.
  const canonical = (value: unknown): string | undefined => {
    const key = poisonName(value);
    if (!key) return undefined;
    const exact = names.get(key);
    if (exact) return exact;
    if (key.length < 2) return undefined;
    const partial = [...names.keys()].filter(n => n.startsWith(key) || n.endsWith(key));
    return partial.length === 1 ? names.get(partial[0]!) : undefined;
  };
  const ledger: Record<string, any>[] = array(prior.ledger).map(record).filter(e => canonical(e.victim));
  const seen = new Set(ledger.map(e => poisonName(e.victim)));
  const kp: Record<string, number> = Object.fromEntries(Object.entries(record(prior.kp)).map(([n, p]) => [n, points(p)]));
  const migrating = prior.version !== 1;
  const unresolved = new Map<string, unknown>(array(prior.unresolved).map(item => [JSON.stringify(item), item]));
  if (migrating) {
    for (const item of String(v["npc-kp"] || "").split("|")) { const [n, p] = item.split(/[:：]/); const who = canonical(n); if (who) kp[who] = Math.max(kp[who] || 0, points(p)); }
    if (player) kp[player] = points(v["user-kp"]);
  }
  const add = (raw: Record<string, any>, award: boolean) => {
    const victim = canonical(raw.victim);
    if (!victim) {
      if (String(raw.victim || "").trim() && !/権藤|权藤/.test(String(raw.victim))) unresolved.set(JSON.stringify(raw), raw);
      return;
    }
    if (seen.has(poisonName(victim))) return;
    const killer = canonical(raw.killer);
    const gain = award && killer && killer !== victim && !seen.has(poisonName(killer)) ? 1 + (kp[victim] || 0) : 0;
    if (killer && gain) kp[killer] = (kp[killer] || 0) + gain;
    seen.add(poisonName(victim));
    ledger.push({ victim, killer: killer || "不明", method: String(raw.method || "死亡记录").slice(0, 300), day: Math.min(7, Math.max(1, points(raw.day || v["day-count"]))), kp: gain, survivors: 40 - seen.size });
  };
  for (const item of array(v["kill-log"])) add(record(item), !migrating);
  // Old free-text deaths remain evidence; unknown names/teacher never consume a roster slot.
  for (const victim of String(v["dead-names"] || "").split(/[,，、;；\n]/)) add({ victim }, false);
  let status = prior.status === "dead" || prior.status === "won" ? prior.status : "active";
  const started = initialized || !!player || state.turnCount > 0;
  // Saves that predate this system may already sit at zero hunger or health:
  // the old rules only nudged the prompt, so players carried on for dozens of
  // turns past that line. Ending those runs on first reload would close a game
  // the player never lost, so vitals only kill a run this system has seen
  // alive — a grandfathered save re-arms the rule as soon as it recovers.
  const vitalsDown = Number(v.health) <= 0 || Number(v.hunger) <= 0;
  let vitalsGrace = prior.vitalsGrace === true;
  if (migrating && started && vitalsDown) vitalsGrace = true;
  if (!vitalsDown) vitalsGrace = false;
  if (started && status === "active") {
    if (player && seen.has(poisonName(player))) status = "dead";
    else if (vitalsDown && !vitalsGrace) status = "dead";
    else if (Number(v["day-count"]) >= 8) status = "won";
  }
  if (status === "dead") { v.health = 0; if (player) add({ victim: player, method: Number(v.hunger) <= 0 ? "饥饿" : "体力耗尽" }, false); }
  if (started && Number(v["day-count"]) < 1) v["day-count"] = 1;
  // Rewrite a legible free-text clock onto the cycle so the day-advance rule,
  // which matches the literal "夜晚", starts firing again on old saves.
  const period = poisonPeriod(v["time-period"]);
  if (period !== null && v["time-period"] !== period) v["time-period"] = period;
  v["game-status"] = status;
  v["dead-names"] = ledger.map(e => e.victim).join(",");
  v["survivors"] = 40 - seen.size;
  v["kill-log"] = ledger;
  v["user-kp"] = kp[player] || 0;
  v["npc-kp"] = Object.entries(kp).filter(([n]) => n !== player).map(([n,p]) => n + ":" + p).join("|");
  v["unresolved-deaths"] = [...unresolved.values()];
  state.metadata.poison = { version: 1, initialized: started, status, ledger, kp, vitalsGrace, unresolved: [...unresolved.values()] };
  // Superseded prompt flags never resurrect or retroactively kill a save.
  if (state.ruleState) state.ruleState = { ...state.ruleState, activeDirectives: state.ruleState.activeDirectives.filter(d => d.id !== "force_death") };
  return state;
}

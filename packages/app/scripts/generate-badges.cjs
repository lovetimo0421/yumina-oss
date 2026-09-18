/* Generates the achievement badge SVGs:
 *   public/badges/frames/{bronze,silver,gold,diamond,locked}.svg   (120x120)
 *   public/badges/emblems/<key>.svg                                (120x120)
 * A badge = a frame with the matching emblem layered on top (same size).
 * Emblems are authored in 64x64 space and centered into the 120 frame.
 * Run:  node packages/app/scripts/generate-badges.cjs
 */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "public", "badges");
const W = '#fff';

// ── Tier frames (escalating ornateness: bronze plain → diamond ornate) ───────
// 132×132 canvas, centered at 66,66, so the diamond's outer spikes have room.
const GRAD = {
  bronze: ["#f7d4a3", "#bf7c40", "#5a3815", "#8a5526"],
  silver: ["#ffffff", "#b9c2cf", "#586069", "#8c95a2"],
  gold:   ["#fff6cf", "#f0c14a", "#8a6210", "#caa028"],
  diamond:["#f2ffff", "#9fe3f5", "#2c6c90", "#5fb4d4"],
  locked: ["#3a4250", "#2a313c", "#171c24", "#2a313c"],
};
const CORE = { bronze: "#2e1d0e", silver: "#232b38", gold: "#3d2d09", diamond: "#0d3a47", locked: "#14181f" };
const ORDER = ["bronze", "silver", "gold", "diamond"];
const CC = 66;
const PT = (a, r) => [CC + r * Math.cos(a), CC + r * Math.sin(a)];
const f2 = (n) => n.toFixed(1);
function beaded(r, n, fill) { let s = ""; for (let i = 0; i < n; i++) { const [x, y] = PT(-Math.PI / 2 + i * 2 * Math.PI / n, r); s += `<circle cx="${f2(x)}" cy="${f2(y)}" r="1.4" fill="${fill}" stroke="rgba(0,0,0,.35)" stroke-width="0.4"/>`; } return s; }
function studs(r, n, fill) { let s = ""; for (let i = 0; i < n; i++) { const [x, y] = PT(-Math.PI / 2 + i * 2 * Math.PI / n, r); s += `<circle cx="${f2(x)}" cy="${f2(y)}" r="2.6" fill="${fill}" stroke="rgba(0,0,0,.4)" stroke-width="0.6"/><circle cx="${f2(x - 0.7)}" cy="${f2(y - 0.8)}" r="0.9" fill="rgba(255,255,255,.75)"/>`; } return s; }
function spikes(rIn, rOut, n, fill) { let s = "", w = Math.PI / n * 0.82; for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / n; const [b0x, b0y] = PT(a - w, rIn), [b1x, b1y] = PT(a + w, rIn), [tx, ty] = PT(a, rOut); s += `<path d="M${f2(b0x)} ${f2(b0y)} L${f2(tx)} ${f2(ty)} L${f2(b1x)} ${f2(b1y)} Z" fill="${fill}" stroke="rgba(0,0,0,.25)" stroke-width="0.4" stroke-linejoin="round"/>`; } return s; }
function gemRing(r, n, fill) { let s = ""; for (let i = 0; i < n; i++) { const [x, y] = PT(-Math.PI / 2 + i * 2 * Math.PI / n, r); const g = 4; s += `<path d="M${f2(x)} ${f2(y - g)} L${f2(x + g)} ${f2(y)} L${f2(x)} ${f2(y + g)} L${f2(x - g)} ${f2(y)} Z" fill="${fill}" stroke="rgba(255,255,255,.6)" stroke-width="0.5"/>`; } return s; }
function bevelRing(r) { return `<circle cx="66" cy="66" r="${r}" fill="none" stroke="rgba(255,255,255,.45)" stroke-width="1.2"/><circle cx="66" cy="66" r="${r - 2}" fill="none" stroke="rgba(0,0,0,.4)" stroke-width="1.3"/>`; }
function crown(fill) { return `<path d="M55 13 l3 -8 8 5 8 -5 3 8 z" fill="${fill}" stroke="rgba(0,0,0,.3)" stroke-width="0.5" stroke-linejoin="round"/><circle cx="58" cy="6" r="1.9" fill="${fill}"/><circle cx="66" cy="3" r="2.2" fill="${fill}"/><circle cx="74" cy="6" r="1.9" fill="${fill}"/>`; }
function spk(x, y, r) { return `<path d="M${x} ${y - r} l${r * .3} ${r * .7} ${r * .7} ${r * .3} -${r * .7} ${r * .3} -${r * .3} ${r * .7} -${r * .3} -${r * .7} -${r * .7} -${r * .3} ${r * .7} -${r * .3} z" fill="#fff"/>`; }
function buildFrame(tier) {
  const c = GRAD[tier], cr = CORE[tier], idx = ORDER.indexOf(tier);
  const defs = `<defs><radialGradient id="rad" cx="38%" cy="28%" r="82%"><stop offset="0%" stop-color="${c[0]}"/><stop offset="46%" stop-color="${c[1]}"/><stop offset="100%" stop-color="${c[2]}"/></radialGradient><radialGradient id="core" cx="50%" cy="40%" r="68%"><stop offset="0%" stop-color="${cr}"/><stop offset="68%" stop-color="${cr}"/><stop offset="100%" stop-color="#090c11"/></radialGradient><filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3.4"/></filter></defs>`;
  let s = "";
  if (tier === "gold") s += `<circle cx="66" cy="66" r="56" fill="${c[1]}" opacity=".2" filter="url(#glow)"/>`;
  if (tier === "diamond") s += `<circle cx="66" cy="66" r="64" fill="${c[1]}" opacity=".42" filter="url(#glow)"/>`;
  if (tier === "diamond") s += spikes(52, 64, 18, "url(#rad)") + spikes(52, 58, 18, "url(#rad)");
  const ringR = tier === "diamond" ? 53 : 56;
  s += `<circle cx="66" cy="66" r="${ringR}" fill="url(#rad)"/>` + bevelRing(ringR);
  if (tier === "silver") s += beaded(53, 40, c[0]);
  if (tier === "gold") s += studs(52, 12, c[0]);
  if (tier === "diamond") s += beaded(49, 50, c[0]);
  if (idx >= 1) s += `<circle cx="66" cy="66" r="45" fill="none" stroke="${c[0]}" stroke-width="1.4" opacity=".75"/>`;
  s += `<circle cx="66" cy="66" r="43" fill="url(#core)"/>`;
  s += `<circle cx="66" cy="66" r="28" fill="${c[1]}" opacity=".2" filter="url(#glow)"/>`;
  s += `<circle cx="66" cy="66" r="43" fill="none" stroke="rgba(0,0,0,.5)" stroke-width="1.5"/>`;
  if (tier === "gold") s += gemRing(50, 4, c[0]);
  if (tier === "diamond") s += gemRing(47, 8, c[0]);
  if (tier === "diamond") s += crown(c[0]) + spk(104, 36, 3) + spk(30, 44, 2.4) + spk(42, 106, 2.6) + spk(102, 98, 2.2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 132 132" width="132" height="132">${defs}${s}</svg>`;
}
const FRAMES = {
  bronze: buildFrame("bronze"),
  silver: buildFrame("silver"),
  gold: buildFrame("gold"),
  diamond: buildFrame("diamond"),
  locked: buildFrame("locked"),
};

// ── Emblems (64x64 space, white) ─────────────────────────────────────────────
const L = 'fill="none" stroke="#fff" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"';
const star4 = (cx, cy, r) => `<path d="M${cx} ${cy - r} l${r * 0.28} ${r * 0.72} ${r * 0.72} ${r * 0.28} -${r * 0.72} ${r * 0.28} -${r * 0.28} ${r * 0.72} -${r * 0.28} -${r * 0.72} -${r * 0.72} -${r * 0.28} ${r * 0.72} -${r * 0.28} z" fill="#fff"/>`;

const EMB = {
  // ── creator ──
  first_publish: `<path d="M10 41 L32 35 L54 41 L32 47 Z" ${L}/><line x1="32" y1="35" x2="32" y2="30" ${L}/><path d="M32 30 q-9 -1 -9 -9 q9 -1 9 9z" fill="#fff"/><path d="M32 30 q9 -1 9 -9 q-9 -1 -9 9z" fill="#fff"/>`,
  acclaimed: `${star4(32, 22, 12)}${star4(17, 42, 7)}${star4(47, 42, 7)}`,
  beloved: `<path d="M32 47 C 17 37 16 24 24 20 C 29 17 32 22 32 25 C 32 22 35 17 40 20 C 48 24 47 37 32 47 Z" fill="#fff"/><circle cx="13" cy="16" r="2.6" fill="#fff"/><circle cx="51" cy="13" r="2.6" fill="#fff"/><circle cx="53" cy="40" r="2.4" fill="#fff"/>`,
  evergreen: `<path d="M32 8 L23 25 H41 Z" fill="#fff"/><path d="M32 19 L19 38 H45 Z" fill="#fff"/><path d="M32 30 L15 51 H49 Z" fill="#fff"/><rect x="29" y="50" width="6" height="8" fill="#fff"/>`,
  breakout: `<circle cx="32" cy="34" r="19" fill="none" stroke="#fff" stroke-width="3.2" stroke-dasharray="58 22"/><path d="M32 46 V18 M24 27 l8 -10 8 10" ${L}/>`,
  master_craftsman: `<path d="M22 18 h20 l10 12 -20 24 -20 -24 z" ${L}/><path d="M12 30 h40 M22 18 l10 12 10 -12 M32 30 v24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/>`,
  polyglot: `<circle cx="32" cy="32" r="20" fill="none" stroke="#fff" stroke-width="3.2"/><path d="M12 32 H52 M32 12 q13 20 0 40 M32 12 q-13 20 0 40" fill="none" stroke="#fff" stroke-width="2.4"/>`,
  last_touch: `<path d="M16 50 L40 24 L46 30 L22 56 Z" ${L}/><line x1="40" y1="24" x2="46" y2="30" ${L}/><circle cx="50" cy="14" r="3.6" fill="#fff"/>`,
  patch_alchemist: `<path d="M27 10 v15 L16 46 a4 4 0 0 0 4 6 h24 a4 4 0 0 0 4 -6 L37 25 V10" ${L}/><line x1="23" y1="10" x2="41" y2="10" ${L}/><line x1="20" y1="41" x2="44" y2="41" ${L}/><circle cx="28" cy="45" r="2.6" fill="#fff"/><circle cx="36" cy="47" r="2" fill="#fff"/>`,
  long_forged: `<g ${L}><line x1="28" y1="8" x2="28" y2="42"/><line x1="21" y1="42" x2="35" y2="42"/><rect x="25" y="46" width="6" height="10"/></g><path d="M42 12 h12 l-6 8 6 8 h-12 l6 -8 z" fill="#fff"/>`,
  cap_creator: `<circle cx="32" cy="38" r="15" fill="none" stroke="#fff" stroke-width="3.2"/><polygon points="32,27 36,38 32,49 28,38" fill="#fff"/><path d="M18 18 l4 -9 10 7 10 -7 4 9 z" fill="#fff"/>`,

  // ── player ──
  first_steps: `<g fill="#fff"><ellipse cx="30" cy="40" rx="11" ry="15"/><ellipse cx="33" cy="20" rx="7" ry="6"/><circle cx="23" cy="15" r="2.4"/><circle cx="31" cy="11" r="2.6"/><circle cx="38" cy="12" r="2.6"/><circle cx="45" cy="17" r="2.4"/></g>`,
  traveler: `<circle cx="32" cy="33" r="20" fill="none" stroke="#fff" stroke-width="3.5"/><line x1="32" y1="7" x2="32" y2="12" ${L}/><polygon points="32,17 38,33 32,49 26,33" fill="#fff"/>`,
  deep_diver: `<g ${L}><rect x="20" y="18" width="24" height="26" rx="11"/><circle cx="32" cy="31" r="7"/><rect x="18" y="44" width="28" height="6" rx="2"/></g><circle cx="49" cy="15" r="2.6" fill="#fff"/><circle cx="53" cy="23" r="1.8" fill="#fff"/>`,
  avid_reader: `<path d="M32 18 V50 M10 22 q11 -5 22 0 v28 q-11 -5 -22 0 z M54 22 q-11 -5 -22 0 v28 q11 -5 22 0 z" ${L}/>${star4(32, 9, 6)}`,
  collector: `${star4(32, 7, 6)}<g ${L}><rect x="14" y="32" width="36" height="22" rx="3"/><path d="M14 32 a18 12 0 0 1 36 0"/><line x1="14" y1="40" x2="50" y2="40"/></g><rect x="29" y="36" width="6" height="8" rx="1.5" fill="#fff"/>`,
  pioneer: `<path d="M6 53 q14 -9 28 -5 q12 4 24 -2 V58 H6 Z" fill="#fff" opacity=".3"/><line x1="38" y1="50" x2="38" y2="13" ${L}/><path d="M38 13 h17 l-5 6 5 6 h-17 z" fill="#fff"/>`,
  old_friend: `<g fill="none" stroke="#fff" stroke-width="3.2"><circle cx="26" cy="32" r="13"/><circle cx="40" cy="32" r="13"/></g>`,
  cap_player: `<path d="M12 53 Q28 41 40 29" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/>${star4(44, 18, 12)}<path d="M20 14 l3 -7 7 5 7 -5 3 7 z" fill="#fff"/>`,

  // ── community ──
  regular: `<path d="M10 14 h44 a4 4 0 0 1 4 4 v20 a4 4 0 0 1 -4 4 H28 l-10 8 v-8 h-8 a4 4 0 0 1 -4 -4 z" ${L}/><circle cx="24" cy="28" r="2.6" fill="#fff"/><circle cx="32" cy="28" r="2.6" fill="#fff"/><circle cx="40" cy="28" r="2.6" fill="#fff"/>`,
  crowd_puller: `<circle cx="32" cy="32" r="12" fill="none" stroke="#fff" stroke-width="3.2"/><circle cx="11" cy="14" r="4.5" fill="#fff"/><circle cx="53" cy="14" r="4.5" fill="#fff"/><circle cx="12" cy="50" r="4.5" fill="#fff"/><circle cx="52" cy="50" r="4.5" fill="#fff"/>`,
  cheer_captain: `<path d="M14 26 L40 18 V46 L14 38 Z" ${L}/><path d="M40 22 V42 L48 44 V20 Z" fill="#fff"/><path d="M22 38 V49 H30 V41" ${L}/><path d="M51 24 h6 M51 32 h8 M51 40 h6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>`,
  footstool: `<path d="M14 38 q0 -15 15 -15 q7 0 10 5 l10 -3 -5 8 q3 5 0 10 q-5 8 -15 8 q-15 0 -15 -16 z" fill="#fff"/><circle cx="40" cy="33" r="1.8" fill="#0e131b"/><path d="M52 32 l9 2 -9 4 z" fill="#fff"/>`,
  world_curator: `<rect x="13" y="14" width="38" height="28" rx="2" fill="none" stroke="#fff" stroke-width="3.2"/><path d="M13 37 l11 -11 7 6 8 -8 12 9" fill="none" stroke="#fff" stroke-width="2.6"/><circle cx="41" cy="22" r="3" fill="#fff"/><path d="M32 44 a5 5 0 1 1 0.1 0 z M32 54 l-4 -7 h8 z" fill="#fff"/>`,
  cap_community: `<path d="M26 8 V28 a6 6 0 0 0 12 0 V8" fill="none" stroke="#fff" stroke-width="3.2"/><line x1="32" y1="34" x2="32" y2="52" ${L}/><path d="M43 28 a11 11 0 0 1 0 16 M47 23 a17 17 0 0 1 0 26" fill="none" stroke="#fff" stroke-width="2.4"/>`,

  // ── referrals & scouting (pathfinder→community, talent_scout→player) ──
  pathfinder: `<path d="M26 9 q6 -4 12 0" ${L}/><rect x="22" y="16" width="20" height="30" rx="5" ${L}/><line x1="22" y1="24" x2="42" y2="24" ${L}/><line x1="22" y1="40" x2="42" y2="40" ${L}/><rect x="29" y="28" width="6" height="9" rx="2" fill="#fff"/>`,
  talent_scout: `<circle cx="28" cy="28" r="14" fill="none" stroke="#fff" stroke-width="3.2"/><line x1="38" y1="38" x2="52" y2="52" fill="none" stroke="#fff" stroke-width="4.2" stroke-linecap="round"/>${star4(28, 22, 6.5)}`,

  // ── ai-model ──
  gemini_loyalist: `${star4(22, 18, 10)}${star4(44, 30, 10)}<line x1="27" y1="27" x2="40" y2="38" fill="none" stroke="#fff" stroke-width="2.4"/>`,
  claude_patron: `<path d="M16 50 Q34 42 48 12 Q42 34 22 46 Z" fill="#fff"/><ellipse cx="44" cy="50" rx="9" ry="3" fill="none" stroke="#fff" stroke-width="2.4"/><ellipse cx="44" cy="45" rx="9" ry="3" fill="none" stroke="#fff" stroke-width="2.4"/>`,
  grok_believer: `<path d="M16 16 L48 48 M48 16 L16 48" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round"/>${star4(54, 11, 6)}`,
  deepseek_loyalist: `<path d="M11 37 C11 25 22 21 32 22 C43 23 48 30 50 35 C45 33 41 34 39 37 C33 45 18 46 13 41 C11 40 11 39 11 37 Z" fill="#fff"/><path d="M49 35 q6 -3 10 -8 q-1 7 1 10 q-5 -3 -11 1 z" fill="#fff"/><path d="M30 41 q2 7 10 7 q-5 -5 -4 -10 z" fill="#fff"/><path d="M23 20 q-3 -8 1 -12 M23 20 q4 -6 9 -7 M23 20 q-2 -9 -5 -11" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="19" cy="33" r="1.9" fill="#0e131b"/>`,
  own_models: `<path d="M14 41 q-6 9 1 16 q3 -5 8 -4 M50 41 q6 9 -1 16 q-3 -5 -8 -4" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><g fill="#fff"><circle cx="13" cy="22" r="6.5"/><circle cx="51" cy="22" r="6.5"/><circle cx="32" cy="30" r="14"/></g><g fill="#0e131b"><circle cx="26" cy="31" r="2"/><circle cx="38" cy="31" r="2"/><path d="M32 16 q3 5 0 9 q-3 -4 0 -9z"/></g><path d="M22 26 l7 2 M42 26 l-7 2" fill="none" stroke="#0e131b" stroke-width="2.2" stroke-linecap="round"/><path d="M28 38 q4 3 8 0" fill="none" stroke="#0e131b" stroke-width="2" stroke-linecap="round"/>`,
  model_collector: `<path d="M32 54 V20 M19 24 V12 M19 24 q0 9 13 9 q13 0 13 -9 V12 M45 24 V12" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><circle cx="19" cy="9" r="2.6" fill="#fff"/><circle cx="32" cy="9" r="2.6" fill="#fff"/><circle cx="45" cy="9" r="2.6" fill="#fff"/>`,
  impatient_king: `<circle cx="32" cy="37" r="15" fill="none" stroke="#fff" stroke-width="3.2"/><path d="M32 37 V27 M32 37 l7 4" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><rect x="28" y="6" width="8" height="5" rx="1.5" fill="#fff"/><path d="M22 12 l3 -4 7 4 7 -4 3 4 z" fill="#fff"/>`,
  one_more_try: `<path d="M46 24 a17 17 0 1 0 3 13" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><path d="M46 12 v12 h-12" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="33" r="7" fill="#fff"/><circle cx="30" cy="31" r="1.4" fill="#0e131b"/><circle cx="35" cy="35" r="1.4" fill="#0e131b"/>`,
  never_satisfied: `<path d="M14 32 a11 11 0 0 1 18 -3 a11 11 0 1 0 0 6 a11 11 0 0 1 -18 -3 z" fill="none" stroke="#fff" stroke-width="3.4"/>`,
  cap_ai: `<circle cx="32" cy="36" r="9" fill="#fff"/><circle cx="14" cy="22" r="3.6" fill="#fff"/><circle cx="50" cy="20" r="3.2" fill="#fff"/><circle cx="49" cy="46" r="3.6" fill="#fff"/><path d="M19 16 q-5 7 -1 14 M48 28 q4 7 -1 13" fill="none" stroke="#fff" stroke-width="2.2"/>`,

  // ── commemorative ──
  founding_resident: `<rect x="13" y="26" width="38" height="25" rx="2" fill="none" stroke="#fff" stroke-width="3.2"/><path d="M13 38 h38 M32 26 v12 M22 38 v13 M42 38 v13" fill="none" stroke="#fff" stroke-width="2.4"/>${star4(32, 16, 6)}`,
  first_dreamers: `<path d="M28 22 l7 -5 V49" fill="none" stroke="#fff" stroke-width="3.4" stroke-linejoin="round" stroke-linecap="round"/><path d="M16 50 q-5 -17 9 -23 M48 50 q5 -17 -9 -23" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>`,
  bug_hunter: `<circle cx="32" cy="32" r="22" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="6 6"/><ellipse cx="32" cy="35" rx="8" ry="11" fill="#fff"/><circle cx="32" cy="23" r="5" fill="#fff"/><g stroke="#fff" stroke-width="2.4" stroke-linecap="round"><line x1="24" y1="29" x2="16" y2="24"/><line x1="40" y1="29" x2="48" y2="24"/><line x1="24" y1="40" x2="16" y2="45"/><line x1="40" y1="40" x2="48" y2="45"/></g>`,
  night_watch: `<path d="M46 10 a13 13 0 1 0 7 22 a15 15 0 0 1 -7 -22 z" fill="#fff"/><g ${L}><path d="M22 54 v-21 l8 -8 8 8 v21"/><line x1="18" y1="54" x2="42" y2="54"/><line x1="30" y1="37" x2="30" y2="46"/></g>`,
  cap_commemorative: `<path d="M9 25 L32 11 L55 25 Z" fill="#fff"/><circle cx="32" cy="20" r="2.6" fill="#0e131b"/><rect x="13" y="27" width="38" height="4" fill="#fff"/><g fill="#fff"><rect x="16" y="32" width="4.5" height="18"/><rect x="25" y="32" width="4.5" height="18"/><rect x="34" y="32" width="4.5" height="18"/><rect x="43" y="32" width="4.5" height="18"/></g><rect x="11" y="51" width="42" height="4" fill="#fff"/>`,
  star_collector: `<polyline points="14,40 26,15 44,22 50,44 30,53 14,40" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/><g fill="#fff"><circle cx="14" cy="40" r="3"/><circle cx="26" cy="15" r="3.6"/><circle cx="44" cy="22" r="3"/><circle cx="50" cy="44" r="3"/><circle cx="30" cy="53" r="3"/></g>`,
};

function emblemFile(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 132 132" width="132" height="132"><g transform="translate(34,34)">${inner}</g></svg>`;
}

// ── Write ────────────────────────────────────────────────────────────────────
fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });
fs.mkdirSync(path.join(OUT, "emblems"), { recursive: true });
for (const [k, svg] of Object.entries(FRAMES)) fs.writeFileSync(path.join(OUT, "frames", `${k}.svg`), svg);
let n = 0;
for (const [k, inner] of Object.entries(EMB)) { fs.writeFileSync(path.join(OUT, "emblems", `${k}.svg`), emblemFile(inner)); n++; }
console.log(`Wrote ${Object.keys(FRAMES).length} frames + ${n} emblems to ${OUT}`);
module.exports = { EMBLEM_KEYS: Object.keys(EMB), FRAME_KEYS: Object.keys(FRAMES) };

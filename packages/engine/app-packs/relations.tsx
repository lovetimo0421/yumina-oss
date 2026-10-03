// @ts-nocheck
// Card UI source: React and useYumina are injected globals at runtime.
//
// App pack: Relationships — how every important character feels about the player.
//
// How an App pack works (the same for every file in this folder):
//   - `const VAR` names the ONE json variable this app reads. The AI writes it
//     (its rules live on the variable); this file only draws it.
//   - `export const app` puts the app in the dock: icon, name, colours, and an
//     optional badge(data) count.
//   - `export default` is the panel body. It may write the variable itself
//     with api.patchVariables for things the player does that cost no turn.
//   - LANG is replaced with the card's language when the pack is installed.

const LANG = "__YUMINA_APP_LANG__";
const VAR = "app_relations";

const TABLE = {
  zh: {
    name: "角色关系", labelW: "2.6em", affection: "好感", trust: "信任", note: "TA 现在怎么看你", talk: "对 TA 说…",
    draft: "（对{name}说）", empty: "故事里的人一出场，他们的卡片就会出现在这里。", people: "{n} 个人",
  },
  en: {
    name: "Relationships", labelW: "4.9em", affection: "Affection", trust: "Trust", note: "What they think of you", talk: "Say something…",
    draft: "(to {name}) ", empty: "Cards appear here as characters enter the story.", people: "{n} people",
  },
  es: {
    name: "Relaciones", labelW: "5.6em", affection: "Afecto", trust: "Confianza", note: "Lo que piensa de ti", talk: "Decirle algo…",
    draft: "(a {name}) ", empty: "Las tarjetas aparecen aquí cuando los personajes entran en la historia.", people: "{n} personas",
  },
};
const T = TABLE[LANG] || TABLE.en;

export const app = { id: "relations", icon: "💞", name: T.name, variable: VAR, accent: "#ff5f8f", accent2: "#ff9a6b", lang: LANG };

const INK = "#1b1e2b";
const MUTED = "#737891";
const PALETTE = [["#ff5f8f", "#ffe3ec"], ["#5b7cff", "#e3e9ff"], ["#19b394", "#dcf5ee"], ["#f29a1f", "#fdefd9"], ["#9a5bff", "#efe4ff"], ["#1aa3e0", "#ddf1fb"], ["#ef6a3a", "#fde6dc"]];
function colorFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function clamp(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
}

// What the player saw last time the panel was open: a change shows as +3 / −2
// until they have looked once.
const SEEN = (typeof window !== "undefined" && (window.__yumina_app_seen = window.__yumina_app_seen || {})) || {};

function Meter({ label, value, prev, from, to }) {
  const v = clamp(value);
  if (v === null) return null;
  const p = clamp(prev);
  const d = p === null ? 0 : v - p;
  return (
    <div style={{ display: "grid", gridTemplateColumns: T.labelW + " 1fr auto", alignItems: "center", gap: 10, fontSize: 12.5 }}>
      <span style={{ color: MUTED }}>{label}</span>
      <span style={{ height: 8, borderRadius: 5, background: "#eef0f5", overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: v + "%", borderRadius: 5, background: "linear-gradient(90deg, " + from + ", " + to + ")", transition: "width .5s" }} />
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 34, justifyContent: "flex-end" }}>
        {d !== 0 ? (
          <span style={{ fontSize: 11, fontWeight: 800, padding: "0 5px", borderRadius: 6, background: d > 0 ? "#dcf5e8" : "#fde2e2", color: d > 0 ? "#12925a" : "#d23b3b" }}>
            {d > 0 ? "+" + d : "−" + Math.abs(d)}
          </span>
        ) : null}
        <b style={{ fontVariantNumeric: "tabular-nums", color: INK }}>{v}</b>
      </span>
    </div>
  );
}

export default function Relations({ close }) {
  const api = useYumina();
  const data = api.variables[VAR] || {};
  const chars = data.chars && typeof data.chars === "object" ? data.chars : {};
  const ids = Object.keys(chars);
  const [openId, setOpenId] = React.useState(null);
  const prevRef = React.useRef(SEEN[VAR] || {});

  React.useEffect(() => { SEEN[VAR] = JSON.parse(JSON.stringify(chars)); });

  if (ids.length === 0) {
    return (
      <div style={{ padding: "40px 28px", textAlign: "center", color: MUTED, fontSize: 14, lineHeight: 1.7 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>💞</div>{T.empty}
      </div>
    );
  }

  return (
    <div style={{ padding: 14, display: "grid", gap: 10 }}>
      <div style={{ fontSize: 12, color: MUTED, padding: "0 2px" }}>{T.people.replace("{n}", String(ids.length))}</div>
      {ids.map((id) => {
        const c = chars[id] || {};
        const prev = prevRef.current[id] || {};
        const name = String(c.name || id);
        const [strong, soft] = colorFor(id);
        const open = openId === id;
        return (
          <div key={id} style={{ borderRadius: 18, background: "#fff", border: "1px solid #eceef4", boxShadow: "0 1px 2px rgba(20,24,40,0.05)", overflow: "hidden" }}>
            <button type="button" onClick={() => setOpenId(open ? null : id)} aria-expanded={open}
              style={{ all: "unset", cursor: "pointer", display: "grid", gap: 10, padding: 14, width: "100%", boxSizing: "border-box" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ width: 46, height: 46, borderRadius: 23, background: "linear-gradient(145deg, " + soft + ", #fff)", color: strong, border: "2px solid " + soft, display: "grid", placeItems: "center", fontWeight: 800, fontSize: 19, flexShrink: 0 }}>
                  {name.slice(0, 1)}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                    <b style={{ fontSize: 16, color: INK }}>{name}</b>
                    {c.tag ? <span style={{ fontSize: 11.5, fontWeight: 600, padding: "2px 8px", borderRadius: 99, background: soft, color: strong }}>{String(c.tag)}</span> : null}
                  </span>
                  {c.mood ? <span style={{ display: "block", fontSize: 13, color: MUTED, marginTop: 3 }}>{String(c.mood)}</span> : null}
                </span>
                <span aria-hidden="true" style={{ color: "#b3b7c7", fontSize: 18, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>›</span>
              </span>
              <Meter label={T.affection} value={c.affection} prev={prev.affection} from="#ff7aa2" to="#ff5f8f" />
              <Meter label={T.trust} value={c.trust} prev={prev.trust} from="#7da2ff" to="#5b7cff" />
            </button>
            {open ? (
              <div style={{ padding: "0 14px 14px", display: "grid", gap: 10 }}>
                {c.note ? (
                  <div style={{ fontSize: 13.5, lineHeight: 1.65, color: INK, background: "#f7f8fb", borderLeft: "3px solid " + strong, borderRadius: "4px 12px 12px 4px", padding: "9px 12px" }}>
                    <span style={{ display: "block", fontSize: 11.5, color: MUTED, marginBottom: 2 }}>{T.note}</span>
                    {String(c.note)}
                  </div>
                ) : null}
                <button type="button"
                  onClick={() => { api.setComposerDraft(T.draft.replace("{name}", name)); if (close) close(); }}
                  style={{ justifySelf: "start", border: "none", cursor: "pointer", borderRadius: 11, padding: "8px 14px", fontSize: 13, fontWeight: 700, background: strong, color: "#fff" }}>
                  {T.talk}
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

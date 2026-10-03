// @ts-nocheck
// Card UI source: React and useYumina are injected globals at runtime.
//
// App pack: Places — where the player is, what places they know, and who is where.
// The AI keeps `app_places` current. "Go" sends a turn so the story can move
// the player there; the AI updates `here` when they arrive.

const LANG = "__YUMINA_APP_LANG__";
const VAR = "app_places";

const TABLE = {
  zh: {
    name: "地点", here: "你在这里", known: "去过和听说过的地方", go: "去这里", action: "（前往{name}）",
    visited: "去过", unvisited: "没去过", danger: "危险", nobody: "这里没有别人",
    empty: "故事里一出现地方，就会记在这里。",
  },
  en: {
    name: "Places", here: "You are here", known: "Places you know", go: "Go", action: "(goes to {name})",
    visited: "Visited", unvisited: "Not visited", danger: "Danger", nobody: "Nobody else is here",
    empty: "Places show up here as the story mentions them.",
  },
  es: {
    name: "Lugares", here: "Estás aquí", known: "Lugares que conoces", go: "Ir", action: "(va a {name})",
    visited: "Visitado", unvisited: "Sin visitar", danger: "Peligro", nobody: "No hay nadie más aquí",
    empty: "Los lugares aparecen aquí cuando la historia los menciona.",
  },
};
const T = TABLE[LANG] || TABLE.en;

export const app = { id: "places", icon: "🗺️", name: T.name, variable: VAR, accent: "#3b82f6", accent2: "#06b6d4", lang: LANG };

const INK = "#1b1e2b";
const MUTED = "#737891";
const PALETTE = [["#ff5f8f", "#ffe3ec"], ["#5b7cff", "#e3e9ff"], ["#19b394", "#dcf5ee"], ["#f29a1f", "#fdefd9"], ["#9a5bff", "#efe4ff"], ["#1aa3e0", "#ddf1fb"], ["#ef6a3a", "#fde6dc"]];
function colorFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function Who({ names, dark }) {
  const list = Array.isArray(names) ? names : [];
  if (list.length === 0) return null;
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
      {list.map((n, i) => {
        const name = String(n);
        const [strong, soft] = colorFor(name);
        return (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px 2px 2px", borderRadius: 99, fontSize: 12, fontWeight: 600, background: dark ? "rgba(255,255,255,0.18)" : soft, color: dark ? "#fff" : strong }}>
            <span style={{ width: 18, height: 18, borderRadius: 9, background: dark ? "rgba(255,255,255,0.9)" : "#fff", color: strong, display: "grid", placeItems: "center", fontSize: 10.5, fontWeight: 800 }}>{name.slice(0, 1)}</span>
            {name}
          </span>
        );
      })}
    </span>
  );
}

function Danger({ level }) {
  const n = Math.max(0, Math.min(3, Number(level) || 0));
  if (n === 0) return null;
  return (
    <span title={T.danger} style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
      {[1, 2, 3].map((i) => (
        <span key={i} style={{ width: 7, height: 7, borderRadius: 4, background: i <= n ? (n >= 3 ? "#e5484d" : n === 2 ? "#f29a1f" : "#f5c542") : "#e3e5ec" }} />
      ))}
    </span>
  );
}

export default function Places({ close }) {
  const api = useYumina();
  const data = api.variables[VAR] || {};
  const places = data.places && typeof data.places === "object" ? data.places : {};
  const ids = Object.keys(places);
  const hereId = typeof data.here === "string" && places[data.here] ? data.here : null;
  const here = hereId ? places[hereId] : null;

  if (ids.length === 0) {
    return (
      <div style={{ padding: "40px 28px", textAlign: "center", color: MUTED, fontSize: 14, lineHeight: 1.7 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🗺️</div>{T.empty}
      </div>
    );
  }

  const others = ids.filter((id) => id !== hereId);
  const go = (p, id) => {
    api.sendMessage(T.action.replace("{name}", String(p.name || id)));
    if (close) close();
  };

  return (
    <div style={{ padding: 14, display: "grid", gap: 12 }}>
      {here ? (
        <div style={{ borderRadius: 18, padding: 16, color: "#fff", background: "linear-gradient(135deg, #3b82f6, #06b6d4)", boxShadow: "0 8px 22px rgba(59,130,246,0.28)", display: "grid", gap: 8 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: ".06em", opacity: 0.85 }}>📍 {T.here}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 54, height: 54, borderRadius: 16, background: "rgba(255,255,255,0.2)", display: "grid", placeItems: "center", fontSize: 30, flexShrink: 0 }}>{here.icon || "📍"}</span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <b style={{ display: "block", fontSize: 19 }}>{String(here.name || hereId)}</b>
              {here.desc ? <span style={{ display: "block", fontSize: 13, lineHeight: 1.55, opacity: 0.92, marginTop: 2 }}>{String(here.desc)}</span> : null}
            </span>
          </span>
          {Array.isArray(here.who) && here.who.length > 0
            ? <Who names={here.who} dark />
            : <span style={{ fontSize: 12.5, opacity: 0.8 }}>{T.nobody}</span>}
        </div>
      ) : null}

      {others.length > 0 ? <div style={{ fontSize: 12, color: MUTED, padding: "2px 2px 0" }}>{T.known}</div> : null}
      {others.map((id) => {
        const p = places[id] || {};
        return (
          <div key={id} style={{ borderRadius: 16, background: "#fff", border: "1px solid #eceef4", boxShadow: "0 1px 2px rgba(20,24,40,0.05)", padding: 12, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <span style={{ width: 42, height: 42, borderRadius: 13, background: p.visited ? "#e6efff" : "#f1f2f6", display: "grid", placeItems: "center", fontSize: 22, flexShrink: 0, filter: p.visited ? "none" : "grayscale(0.4)" }}>{p.icon || "📍"}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 15, color: INK }}>{String(p.name || id)}</b>
                  <Danger level={p.danger} />
                  <span style={{ fontSize: 11, color: p.visited ? "#2f6fd1" : MUTED }}>{p.visited ? T.visited : T.unvisited}</span>
                </span>
                {p.desc ? <span style={{ display: "block", fontSize: 12.5, color: MUTED, marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{String(p.desc)}</span> : null}
              </span>
              <button type="button" onClick={() => go(p, id)}
                style={{ border: "none", cursor: "pointer", borderRadius: 10, padding: "7px 13px", fontSize: 12.5, fontWeight: 700, background: "#3b82f6", color: "#fff", flexShrink: 0 }}>
                {T.go}
              </button>
            </div>
            <Who names={p.who} />
          </div>
        );
      })}
    </div>
  );
}

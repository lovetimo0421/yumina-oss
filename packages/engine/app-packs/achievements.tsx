// @ts-nocheck
// Card UI source: React and useYumina are injected globals at runtime.
//
// App pack: Achievements — medals the story awards for memorable moments,
// plus a few locked hints of what the player could still earn.
// The AI writes `app_achievements`; this file only draws it.

const LANG = "__YUMINA_APP_LANG__";
const VAR = "app_achievements";

const TABLE = {
  zh: {
    name: "成就", unlocked: "已解锁 {n} 个", locked: "还没解锁", rare: "稀有", fresh: "新",
    empty: "还没有成就。做出让人记住的事，这里就会亮起来。",
  },
  en: {
    name: "Achievements", unlocked: "{n} unlocked", locked: "Still locked", rare: "Rare", fresh: "NEW",
    empty: "No achievements yet. Do something memorable and one lights up here.",
  },
  es: {
    name: "Logros", unlocked: "{n} desbloqueados", locked: "Por desbloquear", rare: "Raro", fresh: "NUEVO",
    empty: "Aún no hay logros. Haz algo memorable y aparecerá aquí.",
  },
};
const T = TABLE[LANG] || TABLE.en;

export const app = { id: "achievements", icon: "🏆", name: T.name, variable: VAR, accent: "#eab308", accent2: "#f97316", lang: LANG };

const INK = "#1b1e2b";
const MUTED = "#737891";

// Ids the player had already seen when the panel was last open: anything newer
// is marked NEW until they have looked once.
const SEEN = (typeof window !== "undefined" && (window.__yumina_app_seen = window.__yumina_app_seen || {})) || {};

export default function Achievements() {
  const api = useYumina();
  const data = api.variables[VAR] || {};
  const unlocked = Array.isArray(data.unlocked) ? data.unlocked : [];
  const hints = Array.isArray(data.hints) ? data.hints : [];
  const seenRef = React.useRef(SEEN[VAR]);

  React.useEffect(() => { SEEN[VAR] = unlocked.map((a, i) => String(a.id || i)); });

  if (unlocked.length === 0 && hints.length === 0) {
    return (
      <div style={{ padding: "40px 28px", textAlign: "center", color: MUTED, fontSize: 14, lineHeight: 1.7 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>🏆</div>{T.empty}
      </div>
    );
  }

  const total = unlocked.length + hints.length;
  const pct = total ? Math.round((unlocked.length / total) * 100) : 0;
  const seen = seenRef.current;
  const isNew = (a, i) => Array.isArray(seen) && !seen.includes(String(a.id || i));

  return (
    <div style={{ padding: 14, display: "grid", gap: 12 }}>
      <div style={{ borderRadius: 18, padding: 16, background: "linear-gradient(135deg, #fff7db, #ffe9d2)", border: "1px solid #f6e2b3", display: "flex", alignItems: "center", gap: 14 }}>
        <span style={{ width: 58, height: 58, borderRadius: 29, flexShrink: 0, display: "grid", placeItems: "center",
          background: "conic-gradient(#f59e0b " + pct * 3.6 + "deg, #f3e6c8 0deg)" }}>
          <span style={{ width: 46, height: 46, borderRadius: 23, background: "#fffaf0", display: "grid", placeItems: "center", fontSize: 14, fontWeight: 800, color: "#b45309" }}>{pct}%</span>
        </span>
        <span>
          <b style={{ display: "block", fontSize: 17, color: INK }}>{T.unlocked.replace("{n}", String(unlocked.length))}</b>
          <span style={{ fontSize: 12.5, color: "#9a6a1c" }}>{unlocked.length} / {total}</span>
        </span>
      </div>

      {unlocked.length > 0 ? (
        <div style={{ display: "grid", gap: 8 }}>
          {unlocked.slice().reverse().map((a, ri) => {
            const i = unlocked.length - 1 - ri;
            const fresh = isNew(a, i);
            return (
              <div key={a.id || i} style={{ borderRadius: 16, padding: a.rare ? 2 : 0,
                background: a.rare ? "linear-gradient(120deg, #f59e0b, #f472b6, #8b5cf6, #22d3ee, #f59e0b)" : "transparent" }}>
                <div style={{ borderRadius: a.rare ? 14 : 16, background: "#fff", border: a.rare ? "none" : "1px solid " + (fresh ? "#f6c453" : "#eceef4"), boxShadow: fresh ? "0 0 0 3px rgba(246,196,83,0.25)" : "0 1px 2px rgba(20,24,40,0.05)", padding: 12, display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ width: 48, height: 48, borderRadius: 24, flexShrink: 0, display: "grid", placeItems: "center", fontSize: 24,
                    background: "radial-gradient(circle at 35% 30%, #fff3b0, #f5c542 55%, #d99a0b)", boxShadow: "inset 0 -2px 4px rgba(150,90,0,0.35), 0 2px 6px rgba(217,154,11,0.35)" }}>
                    {a.icon || "🏅"}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <b style={{ fontSize: 15, color: INK }}>{String(a.title || "")}</b>
                      {fresh ? <span style={{ fontSize: 10.5, fontWeight: 800, padding: "1px 7px", borderRadius: 99, background: "#ff3b4e", color: "#fff" }}>{T.fresh}</span> : null}
                      {a.rare ? <span style={{ fontSize: 10.5, fontWeight: 800, padding: "1px 7px", borderRadius: 99, background: "#f3e8ff", color: "#7c3aed" }}>✦ {T.rare}</span> : null}
                    </span>
                    {a.desc ? <span style={{ display: "block", fontSize: 12.5, color: MUTED, marginTop: 2, lineHeight: 1.5 }}>{String(a.desc)}</span> : null}
                  </span>
                  {a.time ? <span style={{ fontSize: 11, color: "#9aa0b4", alignSelf: "flex-start", flexShrink: 0 }}>{String(a.time)}</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {hints.length > 0 ? (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 12, color: MUTED, padding: "4px 2px 0" }}>{T.locked}</div>
          {hints.map((h, i) => (
            <div key={h.id || i} style={{ borderRadius: 16, background: "#f7f8fb", border: "1px dashed #d9dce6", padding: 12, display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ width: 48, height: 48, borderRadius: 24, flexShrink: 0, display: "grid", placeItems: "center", fontSize: 20, background: "#e9ebf1", color: "#9aa0b4" }}>🔒</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b style={{ display: "block", fontSize: 14.5, color: "#9aa0b4", letterSpacing: ".08em" }}>???</b>
                <span style={{ display: "block", fontSize: 12.5, color: MUTED, marginTop: 2, lineHeight: 1.5 }}>{String(h.hint || "")}</span>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

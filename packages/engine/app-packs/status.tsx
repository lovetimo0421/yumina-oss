// @ts-nocheck
// Card UI source: React and useYumina are injected globals at runtime.
//
// App pack: Status — the numbers this story runs on. Bars for anything that
// fills and drains (health, stamina, reputation, danger…) and a grid of short
// labels (level, title, condition…). The AI chooses bars that fit the story at
// the opening and moves them; this file draws them with +n / −n since last look.

const LANG = "__YUMINA_APP_LANG__";
const VAR = "app_status";

const TABLE = {
  zh: { name: "状态", empty: "故事开始后，这里会出现和这个故事有关的数值。", details: "详情" },
  en: { name: "Status", empty: "Once the story starts, the numbers that matter in it show up here.", details: "Details" },
  es: { name: "Estado", empty: "Cuando empiece la historia, aquí aparecerán los valores que importan en ella.", details: "Detalles" },
};
const T = TABLE[LANG] || TABLE.en;

export const app = { id: "status", icon: "📊", name: T.name, variable: VAR, accent: "#10b981", accent2: "#0ea5e9", lang: LANG };

const INK = "#1b1e2b";
const MUTED = "#737891";
const FALLBACK = ["#10b981", "#3d8bff", "#ff5f8f", "#f5a524", "#9a5bff", "#0ea5e9", "#ef6a3a"];
const card = { borderRadius: 18, background: "#fff", border: "1px solid #eceef4", boxShadow: "0 1px 2px rgba(20,24,40,0.05)" };

const SEEN = (typeof window !== "undefined" && (window.__yumina_app_seen = window.__yumina_app_seen || {})) || {};

function num(n, d) {
  const v = Number(n);
  return Number.isFinite(v) ? v : d;
}
function lighten(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const mix = (c) => Math.round(c + (255 - c) * 0.35);
  return "rgb(" + mix((n >> 16) & 255) + "," + mix((n >> 8) & 255) + "," + mix(n & 255) + ")";
}

export default function Status() {
  const api = useYumina();
  const data = api.variables[VAR] || {};
  const bars = Array.isArray(data.bars) ? data.bars : [];
  const tags = Array.isArray(data.tags) ? data.tags : [];
  const prevRef = React.useRef(SEEN[VAR] || {});

  React.useEffect(() => {
    const snap = {};
    bars.forEach((b, i) => { snap[b.id || b.label || i] = num(b.value, 0); });
    SEEN[VAR] = snap;
  });

  if (bars.length === 0 && tags.length === 0) {
    return (
      <div style={{ padding: "40px 28px", textAlign: "center", color: MUTED, fontSize: 14, lineHeight: 1.7 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>📊</div>{T.empty}
      </div>
    );
  }

  return (
    <div style={{ padding: 14, display: "grid", gap: 10 }}>
      {bars.length > 0 ? (
        <div style={{ ...card, padding: "6px 16px" }}>
          {bars.map((b, i) => {
            const key = b.id || b.label || i;
            const max = Math.max(1, num(b.max, 100));
            const value = Math.max(0, Math.min(max, num(b.value, 0)));
            const prev = prevRef.current[key];
            const d = prev === undefined ? 0 : Math.round((value - prev) * 10) / 10;
            const color = /^#[0-9a-f]{6}$/i.test(String(b.color || "")) ? b.color : FALLBACK[i % FALLBACK.length];
            return (
              <div key={key} style={{ padding: "12px 0", borderTop: i ? "1px solid #f0f1f5" : "none", display: "grid", gap: 7 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <b style={{ fontSize: 14.5, color: INK, flex: 1 }}>{String(b.label || b.id || "")}</b>
                  {d !== 0 ? (
                    <span style={{ fontSize: 11, fontWeight: 800, padding: "1px 6px", borderRadius: 6, background: d > 0 ? "#dcf5e8" : "#fde2e2", color: d > 0 ? "#12925a" : "#d23b3b" }}>
                      {d > 0 ? "+" + d : "−" + Math.abs(d)}
                    </span>
                  ) : null}
                  <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 13, color: MUTED }}>
                    <b style={{ fontSize: 18, color: INK }}>{value}</b> / {max}
                  </span>
                </div>
                <span style={{ height: 12, borderRadius: 7, background: "#eef0f5", overflow: "hidden" }}>
                  <span style={{ display: "block", height: "100%", width: (value / max) * 100 + "%", borderRadius: 7, background: "linear-gradient(90deg, " + lighten(color) + ", " + color + ")", transition: "width .5s" }} />
                </span>
                {b.note ? <span style={{ fontSize: 12.5, color: MUTED, lineHeight: 1.5 }}>{String(b.note)}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {tags.length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
          {tags.map((t, i) => (
            <div key={i} style={{ ...card, borderRadius: 14, padding: "10px 12px", display: "grid", gap: 2 }}>
              <span style={{ fontSize: 11.5, color: MUTED }}>{String(t.label || "")}</span>
              <b style={{ fontSize: 14, color: INK, lineHeight: 1.4, wordBreak: "break-word" }}>{String(t.value ?? "")}</b>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

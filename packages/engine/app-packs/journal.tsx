// @ts-nocheck
// Card UI source: React and useYumina are injected globals at runtime.
//
// App pack: Journal — the clues, secrets and goals the player has picked up.
// The AI writes entries as the player learns things. The player can pin an
// entry or add a note of their own here; neither costs a turn, and the AI
// reads player notes (by "player") in the variable on the next one.

const LANG = "__YUMINA_APP_LANG__";
const VAR = "app_journal";

const TABLE = {
  zh: {
    name: "线索笔记", all: "全部", kinds: { clue: "线索", secret: "秘密", goal: "目标", note: "笔记" },
    pin: "置顶", unpin: "取消置顶", add: "写一条自己的笔记…", addBtn: "记下", mine: "我写的",
    empty: "还没有记下什么。发现线索、知道秘密、接下目标时，会自动记在这里。", none: "这一类还没有内容。",
  },
  en: {
    name: "Journal", all: "All", kinds: { clue: "Clue", secret: "Secret", goal: "Goal", note: "Note" },
    pin: "Pin", unpin: "Unpin", add: "Write a note of your own…", addBtn: "Save", mine: "Mine",
    empty: "Nothing written yet. Clues, secrets and goals are noted here as you come across them.", none: "Nothing of this kind yet.",
  },
  es: {
    name: "Diario", all: "Todo", kinds: { clue: "Pista", secret: "Secreto", goal: "Objetivo", note: "Nota" },
    pin: "Fijar", unpin: "Quitar", add: "Escribe una nota propia…", addBtn: "Guardar", mine: "Mía",
    empty: "Aún no hay nada. Las pistas, secretos y objetivos se anotan aquí cuando los descubres.", none: "Todavía no hay nada de este tipo.",
  },
};
const T = TABLE[LANG] || TABLE.en;

export const app = { id: "journal", icon: "📝", name: T.name, variable: VAR, accent: "#6366f1", accent2: "#a855f7", lang: LANG };

const INK = "#1b1e2b";
const MUTED = "#737891";
const KIND = {
  clue: { icon: "🔎", strong: "#2f6fd1", soft: "#e3ecff" },
  secret: { icon: "🤫", strong: "#b4368a", soft: "#fbe3f2" },
  goal: { icon: "🎯", strong: "#d9661f", soft: "#fdeadb" },
  note: { icon: "📌", strong: "#5b5f73", soft: "#eceef4" },
};

export default function Journal() {
  const api = useYumina();
  const data = api.variables[VAR] || {};
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const [filter, setFilter] = React.useState("all");
  const [draft, setDraft] = React.useState("");

  const save = (next) => api.patchVariables({ [VAR]: { ...data, entries: next } }).catch(() => {});
  const togglePin = (i) => save(entries.map((e, j) => (j === i ? { ...e, pinned: !e.pinned } : e)));
  const remove = (i) => save(entries.filter((_, j) => j !== i));
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    save([...entries, { id: "p" + Date.now().toString(36), kind: "note", title: "", text, time: "", pinned: false, by: "player" }]);
    setDraft("");
  };

  // Pinned first, then newest first (the AI appends, so later = newer).
  const shown = entries
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => filter === "all" || (e.kind || "note") === filter)
    .sort((a, b) => (b.e.pinned ? 1 : 0) - (a.e.pinned ? 1 : 0) || b.i - a.i);

  const chip = (key, label, icon) => {
    const on = filter === key;
    return (
      <button key={key} type="button" onClick={() => setFilter(key)} aria-pressed={on}
        style={{ border: "none", cursor: "pointer", borderRadius: 99, padding: "6px 11px", fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", background: on ? "#6366f1" : "#fff", color: on ? "#fff" : MUTED, boxShadow: on ? "none" : "inset 0 0 0 1px #e3e5ec" }}>
        {icon ? icon + " " : ""}{label}
      </button>
    );
  };

  return (
    <div style={{ padding: 14, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
        {chip("all", T.all)}
        {Object.keys(KIND).map((k) => chip(k, T.kinds[k], KIND[k].icon))}
      </div>

      {entries.length === 0 ? (
        <div style={{ padding: "32px 22px", textAlign: "center", color: MUTED, fontSize: 14, lineHeight: 1.7 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>📝</div>{T.empty}
        </div>
      ) : shown.length === 0 ? (
        <p style={{ margin: "8px 2px", fontSize: 13, color: MUTED }}>{T.none}</p>
      ) : null}

      {shown.map(({ e, i }) => {
        const k = KIND[e.kind] ? e.kind : "note";
        const s = KIND[k];
        const mine = e.by === "player";
        return (
          <div key={e.id || i} style={{ borderRadius: 16, background: "#fff", border: "1px solid " + (e.pinned ? "#c7c9f7" : "#eceef4"), boxShadow: "0 1px 2px rgba(20,24,40,0.05)", padding: "12px 14px", display: "grid", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, padding: "2px 8px", borderRadius: 99, background: s.soft, color: s.strong }}>{s.icon} {T.kinds[k]}</span>
              {mine ? <span style={{ fontSize: 11, color: "#6366f1", fontWeight: 600 }}>{T.mine}</span> : null}
              <span style={{ flex: 1 }} />
              {e.time ? <span style={{ fontSize: 11, color: "#9aa0b4" }}>{String(e.time)}</span> : null}
              <button type="button" onClick={() => togglePin(i)} aria-pressed={!!e.pinned} title={e.pinned ? T.unpin : T.pin} aria-label={e.pinned ? T.unpin : T.pin}
                style={{ border: "none", background: e.pinned ? "#eef0ff" : "transparent", borderRadius: 8, cursor: "pointer", fontSize: 14, padding: "2px 6px", opacity: e.pinned ? 1 : 0.45 }}>📌</button>
              {mine ? (
                <button type="button" onClick={() => remove(i)} aria-label="×"
                  style={{ border: "none", background: "transparent", color: "#9aa0b4", cursor: "pointer", fontSize: 16, padding: "0 2px" }}>×</button>
              ) : null}
            </div>
            {e.title ? <b style={{ fontSize: 15, color: INK }}>{String(e.title)}</b> : null}
            {e.text ? <div style={{ fontSize: 13.5, lineHeight: 1.65, color: e.title ? "#444a5e" : INK, whiteSpace: "pre-wrap" }}>{String(e.text)}</div> : null}
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <input value={draft} onChange={(ev) => setDraft(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter") add(); }}
          placeholder={T.add}
          style={{ flex: 1, minWidth: 0, borderRadius: 12, border: "1px solid #e3e5ec", background: "#fff", color: INK, padding: "10px 12px", fontSize: 13.5, outline: "none" }} />
        <button type="button" onClick={add}
          style={{ border: "none", borderRadius: 12, padding: "0 16px", fontWeight: 700, fontSize: 13, cursor: "pointer", background: "#6366f1", color: "#fff" }}>{T.addBtn}</button>
      </div>
    </div>
  );
}

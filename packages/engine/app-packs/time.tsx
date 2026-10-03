// @ts-nocheck
// Card UI source: React and useYumina are injected globals at runtime.
//
// App pack: Time & Plans — the story's clock and the player's appointments.
// The AI keeps `app_time` current. The player can add a plan or tick one off
// without spending a turn; the AI sees it in the variable next turn (items the
// player added carry by:"player").

const LANG = "__YUMINA_APP_LANG__";
const VAR = "app_time";

const TABLE = {
  zh: {
    name: "时间与日程", day: "第 {n} 天", plans: "日程", empty: "还没有安排。约好的事、要赴的会，会自动记在这里。",
    add: "加一条自己的安排…", addBtn: "添加", done: "完成", mine: "我加的", noClock: "故事的时间还没开始走", doneTitle: "已完成",
    periods: { dawn: "黎明", morning: "上午", noon: "中午", afternoon: "下午", evening: "傍晚", night: "夜晚", late: "深夜" },
  },
  en: {
    name: "Time & Plans", day: "Day {n}", plans: "Plans", empty: "Nothing planned yet. Appointments and promises show up here on their own.",
    add: "Add a plan of your own…", addBtn: "Add", done: "Done", mine: "Mine", noClock: "Story time hasn't started yet", doneTitle: "Done",
    periods: { dawn: "Dawn", morning: "Morning", noon: "Noon", afternoon: "Afternoon", evening: "Evening", night: "Night", late: "Late night" },
  },
  es: {
    name: "Tiempo y agenda", day: "Día {n}", plans: "Agenda", empty: "Nada en la agenda. Las citas y promesas aparecen aquí solas.",
    add: "Añadir un plan propio…", addBtn: "Añadir", done: "Hecho", mine: "Mío", noClock: "El tiempo de la historia aún no empieza", doneTitle: "Hecho",
    periods: { dawn: "Amanecer", morning: "Mañana", noon: "Mediodía", afternoon: "Tarde", evening: "Atardecer", night: "Noche", late: "Madrugada" },
  },
};
const T = TABLE[LANG] || TABLE.en;

export const app = { id: "time", icon: "🕐", name: T.name, variable: VAR, accent: "#ffb020", accent2: "#ff7a3d", lang: LANG };

const INK = "#1b1e2b";
const MUTED = "#737891";
const SKY = {
  dawn: ["#ffb088", "#8b6fd6", "🌅"], morning: ["#6cc4ff", "#3f7fe0", "☀️"], noon: ["#4fb3ff", "#2a6ad6", "☀️"],
  afternoon: ["#ffc46b", "#e5774a", "🌤️"], evening: ["#ff8a66", "#7a3f98", "🌇"], night: ["#34479a", "#141b3d", "🌙"],
  late: ["#252c63", "#0b0f26", "🌌"],
};

export default function TimeApp() {
  const api = useYumina();
  const data = api.variables[VAR] || {};
  const agenda = Array.isArray(data.agenda) ? data.agenda : [];
  const period = typeof data.period === "string" && SKY[data.period] ? data.period : null;
  const sky = SKY[period || "morning"];
  const [draft, setDraft] = React.useState("");
  const hasClock = data.day || data.clock || data.date || period;
  const open = agenda.map((it, i) => [it, i]).filter(([it]) => !it.done);
  const done = agenda.map((it, i) => [it, i]).filter(([it]) => it.done);

  const save = (nextAgenda) => { api.patchVariables({ [VAR]: { ...data, agenda: nextAgenda } }).catch(() => {}); };
  const toggle = (i) => save(agenda.map((it, j) => (j === i ? { ...it, done: !it.done } : it)));
  const remove = (i) => save(agenda.filter((_, j) => j !== i));
  const add = () => {
    const what = draft.trim();
    if (!what) return;
    save([...agenda, { id: "p" + Date.now().toString(36), when: "", what, done: false, by: "player" }]);
    setDraft("");
  };

  const Row = ({ it, i }) => (
    <div style={{ display: "grid", gridTemplateColumns: "26px 1fr auto", gap: 11, alignItems: "start", padding: "12px 14px", borderRadius: 16, background: "#fff", border: "1px solid #eceef4", boxShadow: "0 1px 2px rgba(20,24,40,0.05)" }}>
      <button type="button" onClick={() => toggle(i)} aria-label={T.done} aria-pressed={!!it.done}
        style={{ width: 24, height: 24, borderRadius: 12, border: "2px solid " + (it.done ? "#19b36b" : "#c9cdda"), background: it.done ? "#19b36b" : "#fff", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 900, padding: 0 }}>
        {it.done ? "✓" : ""}
      </button>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14.5, lineHeight: 1.5, color: it.done ? MUTED : INK, textDecoration: it.done ? "line-through" : "none" }}>{String(it.what || "")}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
          {it.when ? <span style={{ fontSize: 11.5, fontWeight: 600, padding: "1px 8px", borderRadius: 99, background: "#fff1dc", color: "#b86b00" }}>{String(it.when)}</span> : null}
          {it.with ? <span style={{ fontSize: 11.5, padding: "1px 8px", borderRadius: 99, background: "#eef0f5", color: "#5b6075" }}>{String(it.with)}</span> : null}
          {it.by === "player" ? <span style={{ fontSize: 11.5, padding: "1px 8px", borderRadius: 99, background: "#e8ebff", color: "#4f5bd5" }}>{T.mine}</span> : null}
        </div>
      </div>
      {it.by === "player" ? (
        <button type="button" onClick={() => remove(i)} aria-label="×"
          style={{ border: "none", background: "transparent", color: "#a3a8ba", cursor: "pointer", fontSize: 18, padding: 0, lineHeight: 1 }}>×</button>
      ) : <span />}
    </div>
  );

  return (
    <div style={{ padding: 14, display: "grid", gap: 12 }}>
      <div style={{ borderRadius: 20, padding: "18px 18px 16px", color: "#fff", background: "linear-gradient(135deg, " + sky[0] + ", " + sky[1] + ")", boxShadow: "0 8px 20px rgba(30,40,80,0.18)" }}>
        {hasClock ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div>
                <div style={{ fontSize: 13, opacity: 0.9, fontWeight: 600 }}>{data.day ? T.day.replace("{n}", String(data.day)) : ""}</div>
                <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1.1, letterSpacing: "-.01em", fontVariantNumeric: "tabular-nums" }}>{data.clock || (period ? T.periods[period] : "")}</div>
              </div>
              <span style={{ fontSize: 40 }} aria-hidden="true">{sky[2]}</span>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10, fontSize: 12.5 }}>
              {period && data.clock ? <span style={{ padding: "3px 10px", borderRadius: 99, background: "rgba(255,255,255,0.22)" }}>{T.periods[period]}</span> : null}
              {data.date ? <span style={{ padding: "3px 10px", borderRadius: 99, background: "rgba(255,255,255,0.22)" }}>{String(data.date)}</span> : null}
              {data.weather ? <span style={{ padding: "3px 10px", borderRadius: 99, background: "rgba(255,255,255,0.22)" }}>{String(data.weather)}</span> : null}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 14, opacity: 0.95 }}>{T.noClock}</div>
        )}
      </div>

      <b style={{ fontSize: 13, color: MUTED, padding: "4px 2px 0" }}>{T.plans}</b>
      {agenda.length === 0 ? <p style={{ margin: "0 2px", fontSize: 13.5, color: MUTED, lineHeight: 1.7 }}>{T.empty}</p> : null}
      {open.map(([it, i]) => <Row key={it.id || i} it={it} i={i} />)}
      {done.length > 0 ? <span style={{ fontSize: 12, color: MUTED, padding: "2px 2px 0" }}>{T.doneTitle}</span> : null}
      {done.map(([it, i]) => <Row key={it.id || i} it={it} i={i} />)}

      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder={T.add}
          style={{ flex: 1, minWidth: 0, borderRadius: 12, border: "1px solid #dfe2ea", background: "#fff", color: INK, padding: "10px 12px", fontSize: 14, outline: "none" }} />
        <button type="button" onClick={add}
          style={{ border: "none", borderRadius: 12, padding: "0 16px", fontWeight: 700, fontSize: 13.5, cursor: "pointer", background: "linear-gradient(145deg,#ffb020,#ff7a3d)", color: "#fff" }}>{T.addBtn}</button>
      </div>
    </div>
  );
}

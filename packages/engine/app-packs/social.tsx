// @ts-nocheck
// Card UI source: React and useYumina are injected globals at runtime.
//
// App pack: Feed — the public square. NPCs and strangers post about what
// happens; a trending list shows what the world is talking about (including
// rumours about the player). Likes, reposts and comments cost no turn: they
// are written to the variable and the AI notices them next turn. A post the
// player writes is also sent as a turn so the world can react to it.

const LANG = "__YUMINA_APP_LANG__";
const VAR = "app_social";

const TABLE = {
  zh: {
    name: "广场", forYou: "推荐", trending: "热搜", compose: "分享新鲜事…", post: "发布",
    action: "（发了一条动态）{text}", comment: "写评论…", me: "我", look: "去看看 #{title}",
    empty: "还没有人发帖。故事里发生的事，大家会在这里议论。", noTrend: "热搜榜还是空的。",
    tags: { hot: "爆", new: "新", rising: "升" },
  },
  en: {
    name: "Feed", forYou: "For you", trending: "Trending", compose: "What's happening?", post: "Post",
    action: "(posts) {text}", comment: "Reply…", me: "Me", look: "Look into #{title}",
    empty: "No posts yet. When something happens in the story, people talk about it here.", noTrend: "Nothing is trending yet.",
    tags: { hot: "HOT", new: "NEW", rising: "UP" },
  },
  es: {
    name: "Tendencias", forYou: "Para ti", trending: "Tendencias", compose: "¿Qué está pasando?", post: "Publicar",
    action: "(publica) {text}", comment: "Responder…", me: "Yo", look: "Ver #{title}",
    empty: "Aún no hay publicaciones. Cuando pase algo en la historia, la gente lo comentará aquí.", noTrend: "Todavía no hay tendencias.",
    tags: { hot: "HOT", new: "NUEVO", rising: "SUBE" },
  },
};
const T = TABLE[LANG] || TABLE.en;

export const app = { id: "social", icon: "🔥", name: T.name, variable: VAR, accent: "#ff7a3d", accent2: "#ff3d6e", lang: LANG };

const INK = "#1b1e2b";
const MUTED = "#737891";
const ACCENT = "#ff4d5e";
const PALETTE = [["#ff5f8f", "#ffe3ec"], ["#5b7cff", "#e3e9ff"], ["#19b394", "#dcf5ee"], ["#f29a1f", "#fdefd9"], ["#9a5bff", "#efe4ff"], ["#1aa3e0", "#ddf1fb"], ["#ef6a3a", "#fde6dc"]];
function colorFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const TAG_COLOR = { hot: "#ff3b4e", new: "#ff8a1f", rising: "#3d8bff" };
const card = { borderRadius: 18, background: "#fff", border: "1px solid #eceef4", boxShadow: "0 1px 2px rgba(20,24,40,0.05)" };
const inputStyle = { flex: 1, minWidth: 0, borderRadius: 12, border: "1px solid #e3e6ee", background: "#f7f8fb", color: INK, padding: "9px 12px", fontSize: 13.5, outline: "none", fontFamily: "inherit" };

function Avatar({ name, size }) {
  const [strong, soft] = colorFor(String(name || "?"));
  const s = size || 40;
  return (
    <span style={{ width: s, height: s, borderRadius: s / 2, background: "linear-gradient(145deg, " + soft + ", #fff)", color: strong, border: "2px solid " + soft, display: "grid", placeItems: "center", fontWeight: 800, fontSize: s * 0.42, flexShrink: 0 }}>
      {String(name || "?").slice(0, 1)}
    </span>
  );
}

function count(n) {
  const v = Number(n) || 0;
  if (LANG === "zh" && v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, "") + "万";
  if (LANG !== "zh" && v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(v);
}

export default function Feed({ close }) {
  const api = useYumina();
  const data = api.variables[VAR] || {};
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const trending = Array.isArray(data.trending) ? data.trending : [];
  const [tab, setTab] = React.useState("feed");
  const [draft, setDraft] = React.useState("");
  const [replies, setReplies] = React.useState({});

  const save = (next) => api.patchVariables({ [VAR]: { ...data, ...next } }).catch(() => {});

  const publish = () => {
    const text = draft.trim();
    if (!text) return;
    save({ posts: [...posts, { id: "me" + Date.now().toString(36), author: "me", text, likes: 0, reposts: 0, comments: [] }] });
    api.sendMessage(T.action.replace("{text}", text));
    setDraft("");
  };
  const toggle = (i, key) => save({ posts: posts.map((p, j) => (j === i ? { ...p, [key]: !p[key] } : p)) });
  const reply = (i) => {
    const text = String(replies[i] || "").trim();
    if (!text) return;
    save({ posts: posts.map((p, j) => (j === i ? { ...p, comments: [...(Array.isArray(p.comments) ? p.comments : []), { author: "me", text }] } : p)) });
    setReplies({ ...replies, [i]: "" });
  };

  const tabBtn = (key, label) => (
    <button type="button" onClick={() => setTab(key)} aria-pressed={tab === key}
      style={{ flex: 1, border: "none", cursor: "pointer", padding: "10px 0 9px", fontSize: 14.5, fontWeight: tab === key ? 800 : 600, background: "transparent", color: tab === key ? INK : MUTED, borderBottom: "3px solid " + (tab === key ? ACCENT : "transparent") }}>
      {label}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", background: "#fff", borderBottom: "1px solid #eceef4", position: "sticky", top: 0, zIndex: 1 }}>
        {tabBtn("feed", T.forYou)}
        {tabBtn("trending", T.trending)}
      </div>

      {tab === "feed" ? (
        <div style={{ padding: 14, display: "grid", gap: 10 }}>
          <div style={{ ...card, padding: 12, display: "flex", gap: 10, alignItems: "flex-start" }}>
            <Avatar name={T.me} size={36} />
            <div style={{ flex: 1, display: "grid", gap: 8 }}>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={T.compose} rows={2}
                style={{ ...inputStyle, resize: "none", lineHeight: 1.5 }} />
              <button type="button" onClick={publish} disabled={!draft.trim()}
                style={{ justifySelf: "end", border: "none", cursor: draft.trim() ? "pointer" : "default", borderRadius: 99, padding: "7px 18px", fontSize: 13, fontWeight: 800, color: "#fff", background: "linear-gradient(135deg, #ff7a3d, #ff3d6e)", opacity: draft.trim() ? 1 : 0.45 }}>
                {T.post}
              </button>
            </div>
          </div>

          {posts.length === 0 ? (
            <div style={{ padding: "30px 24px", textAlign: "center", color: MUTED, fontSize: 14, lineHeight: 1.7 }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>🔥</div>{T.empty}
            </div>
          ) : null}

          {posts.slice().reverse().map((p, ri) => {
            const i = posts.length - 1 - ri;
            const mine = p.author === "me";
            const author = mine ? T.me : String(p.author || "?");
            const cs = Array.isArray(p.comments) ? p.comments : [];
            return (
              <div key={p.id || i} style={{ ...card, padding: 14, display: "grid", gap: 9 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <Avatar name={author} size={38} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <b style={{ fontSize: 14.5, color: INK }}>{author}</b>
                    <div style={{ fontSize: 12, color: MUTED }}>
                      {p.handle ? "@" + String(p.handle).replace(/^@/, "") : ""}{p.handle && p.time ? " · " : ""}{p.time ? String(p.time) : ""}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 14.5, lineHeight: 1.65, color: INK, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{String(p.text || "")}</div>
                <div style={{ display: "flex", gap: 20, fontSize: 13, color: MUTED }}>
                  <button type="button" onClick={() => toggle(i, "reposted")} aria-pressed={!!p.reposted}
                    style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, fontSize: 13, color: p.reposted ? "#12a36b" : MUTED, fontWeight: p.reposted ? 700 : 500 }}>
                    ⇄ {count((Number(p.reposts) || 0) + (p.reposted ? 1 : 0))}
                  </button>
                  <span>💬 {count(cs.length)}</span>
                  <button type="button" onClick={() => toggle(i, "liked")} aria-pressed={!!p.liked}
                    style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, fontSize: 13, color: p.liked ? ACCENT : MUTED, fontWeight: p.liked ? 700 : 500 }}>
                    {p.liked ? "♥" : "♡"} {count((Number(p.likes) || 0) + (p.liked ? 1 : 0))}
                  </button>
                </div>
                {cs.length > 0 ? (
                  <div style={{ display: "grid", gap: 5, padding: "9px 11px", borderRadius: 12, background: "#f7f8fb" }}>
                    {cs.map((c, k) => (
                      <div key={k} style={{ fontSize: 13, lineHeight: 1.55, color: INK }}>
                        <b style={{ color: c.author === "me" ? ACCENT : "#3d63d9" }}>{c.author === "me" ? T.me : String(c.author || "")}</b>：{String(c.text || "")}
                      </div>
                    ))}
                  </div>
                ) : null}
                <input value={replies[i] || ""} onChange={(e) => setReplies({ ...replies, [i]: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") reply(i); }} placeholder={T.comment}
                  style={{ ...inputStyle, padding: "7px 11px", fontSize: 12.5 }} />
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ padding: 14 }}>
          {trending.length === 0 ? (
            <div style={{ padding: "30px 24px", textAlign: "center", color: MUTED, fontSize: 14 }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>📈</div>{T.noTrend}
            </div>
          ) : (
            <div style={{ ...card, overflow: "hidden" }}>
              {trending.slice(0, 10).map((t, i) => {
                const tag = String(t.tag || "");
                const rankColor = i === 0 ? "#ff3b4e" : i === 1 ? "#ff6a2b" : i === 2 ? "#f5a524" : "#a3a8ba";
                return (
                  <button key={t.id || i} type="button"
                    onClick={() => { api.setComposerDraft(T.look.replace("{title}", String(t.title || ""))); if (close) close(); }}
                    style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", width: "100%", boxSizing: "border-box", borderTop: i ? "1px solid #f0f1f5" : "none" }}>
                    <b style={{ width: 20, textAlign: "center", fontSize: 16, fontStyle: "italic", color: rankColor, fontVariantNumeric: "tabular-nums" }}>{i + 1}</b>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 14.5, fontWeight: 600, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>#{String(t.title || "")}</span>
                        {TAG_COLOR[tag] ? <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 800, color: "#fff", background: TAG_COLOR[tag], borderRadius: 5, padding: "1px 5px" }}>{T.tags[tag]}</span> : null}
                      </span>
                      {t.heat ? <span style={{ display: "block", fontSize: 12, color: MUTED, marginTop: 2 }}>{String(t.heat)}</span> : null}
                    </span>
                    <span aria-hidden="true" style={{ color: "#b3b7c7", fontSize: 18 }}>›</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

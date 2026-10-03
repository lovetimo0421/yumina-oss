// @ts-nocheck
// Card UI source: React and useYumina are injected globals at runtime.
//
// App pack: Phone — texting the characters, plus the posts they share.
// The AI writes incoming texts and posts into `app_phone`. A text the player
// sends is saved to the thread at once AND sent as a turn, so it shows in the
// main chat and the character can answer. Likes and comments only touch the
// variable: no turn, and the AI sees them next time.
// The look follows the messenger people already use in each language:
// green-on-grey for Chinese, blue bubbles for English, WhatsApp-style for Spanish.

const LANG = "__YUMINA_APP_LANG__";
const VAR = "app_phone";

const TABLE = {
  zh: {
    name: "手机", chats: "消息", moments: "朋友圈", noChats: "还没有人发消息来。有人联系你时，对话会出现在这里。",
    noMoments: "朋友圈还没有动态。", say: "发消息…", send: "发送", me: "我",
    action: "（用手机发消息给{name}）{text}", comment: "评论…", newChat: "给谁发消息？输入名字", start: "开始", likes: "{n} 人觉得很赞",
  },
  en: {
    name: "Phone", chats: "Messages", moments: "Moments", noChats: "No messages yet. When someone texts you, the conversation shows up here.",
    noMoments: "Nothing posted yet.", say: "iMessage", send: "Send", me: "Me",
    action: "(texts {name}) {text}", comment: "Add a comment…", newChat: "Text someone new — type a name", start: "Open", likes: "{n} likes",
  },
  es: {
    name: "Teléfono", chats: "Chats", moments: "Momentos", noChats: "Aún no hay mensajes. Cuando alguien te escriba, la conversación aparecerá aquí.",
    noMoments: "Nadie ha publicado todavía.", say: "Mensaje", send: "Enviar", me: "Yo",
    action: "(le escribe a {name} por el móvil) {text}", comment: "Comentar…", newChat: "Escribir a alguien — pon un nombre", start: "Abrir", likes: "{n} me gusta",
  },
};
const T = TABLE[LANG] || TABLE.en;

const SKINS = {
  zh: { chatBg: "#ededed", mine: "#95ec69", mineText: "#111", theirs: "#ffffff", theirsText: "#111", avatarRadius: 6, accent: "#07c160", tick: false, bubbleRadius: 6 },
  en: { chatBg: "#ffffff", mine: "#0a84ff", mineText: "#fff", theirs: "#e9e9eb", theirsText: "#111", avatarRadius: 99, accent: "#0a84ff", tick: false, bubbleRadius: 18 },
  es: { chatBg: "#efeae2", mine: "#d9fdd3", mineText: "#111", theirs: "#ffffff", theirsText: "#111", avatarRadius: 99, accent: "#00a884", tick: true, bubbleRadius: 10 },
};
const S = SKINS[LANG] || SKINS.en;

export const app = {
  id: "phone", icon: "💬", name: T.name, variable: VAR, accent: "#34d17a", accent2: "#12a867", lang: LANG,
  badge: (d) => {
    const th = d && d.threads && typeof d.threads === "object" ? d.threads : {};
    return Object.keys(th).reduce((n, k) => n + (Number(th[k] && th[k].unread) || 0), 0);
  },
};

const INK = "#1b1e2b";
const MUTED = "#8a8fa3";
const PALETTE = ["#f29a1f", "#5b7cff", "#19b394", "#ff5f8f", "#9a5bff", "#1aa3e0", "#ef6a3a"];
function colorFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function Avatar({ name, id, size }) {
  const c = colorFor(id || name || "?");
  const s = size || 44;
  return (
    <span style={{ width: s, height: s, borderRadius: S.avatarRadius === 99 ? s / 2 : S.avatarRadius, background: c, color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: s * 0.42, flexShrink: 0 }}>
      {String(name || "?").slice(0, 1)}
    </span>
  );
}
function slug(name) {
  const s = String(name).trim().toLowerCase().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_]/gu, "");
  return s || "c" + Date.now().toString(36);
}
const field = { flex: 1, minWidth: 0, borderRadius: 20, border: "1px solid #dfe2ea", background: "#fff", color: INK, padding: "9px 14px", fontSize: 14, outline: "none" };
const sendBtn = { border: "none", borderRadius: 20, padding: "0 16px", fontWeight: 700, fontSize: 13.5, cursor: "pointer", background: S.accent, color: "#fff" };

export default function Phone() {
  const api = useYumina();
  const data = api.variables[VAR] || {};
  const threads = data.threads && typeof data.threads === "object" ? data.threads : {};
  const moments = Array.isArray(data.moments) ? data.moments : [];
  const [tab, setTab] = React.useState("chats");
  const [openId, setOpenId] = React.useState(null);
  const [draft, setDraft] = React.useState("");
  const [newName, setNewName] = React.useState("");
  const [comments, setComments] = React.useState({});
  const bottomRef = React.useRef(null);

  const save = (next) => api.patchVariables({ [VAR]: { ...data, ...next } }).catch(() => {});
  const thread = openId ? threads[openId] : null;
  const messages = thread && Array.isArray(thread.messages) ? thread.messages : [];

  React.useEffect(() => {
    if (openId && thread && thread.unread) save({ threads: { ...threads, [openId]: { ...thread, unread: 0 } } });
    if (bottomRef.current) bottomRef.current.scrollIntoView({ block: "end" });
  }, [openId, messages.length]);

  const send = () => {
    const text = draft.trim();
    if (!text || !openId) return;
    const t = threads[openId] || { name: openId, messages: [] };
    const nextThread = { ...t, unread: 0, messages: [...(Array.isArray(t.messages) ? t.messages : []), { from: "me", text }] };
    save({ threads: { ...threads, [openId]: nextThread } });
    api.sendMessage(T.action.replace("{name}", String(t.name || openId)).replace("{text}", text));
    setDraft("");
  };
  const startChat = () => {
    const name = newName.trim();
    if (!name) return;
    const existing = Object.keys(threads).find((k) => String(threads[k].name || k) === name);
    const id = existing || slug(name);
    if (!existing) save({ threads: { ...threads, [id]: { name, messages: [], unread: 0 } } });
    setNewName("");
    setOpenId(id);
  };
  const toggleLike = (i) => save({ moments: moments.map((m, j) => (j === i ? { ...m, liked: !m.liked } : m)) });
  const addComment = (i) => {
    const text = String(comments[i] || "").trim();
    if (!text) return;
    save({ moments: moments.map((m, j) => (j === i ? { ...m, comments: [...(Array.isArray(m.comments) ? m.comments : []), { author: "me", text }] } : m)) });
    setComments({ ...comments, [i]: "" });
  };

  // ── One conversation ──
  if (openId) {
    const name = String((thread && thread.name) || openId);
    return (
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, background: S.chatBg }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: LANG === "es" ? "#f0f2f5" : "rgba(255,255,255,0.92)", borderBottom: "1px solid #e3e5eb" }}>
          <button type="button" onClick={() => setOpenId(null)} aria-label="Back"
            style={{ border: "none", background: "transparent", color: S.accent, cursor: "pointer", fontSize: 26, lineHeight: 1, padding: "0 4px" }}>‹</button>
          <Avatar name={name} id={openId} size={32} />
          <b style={{ fontSize: 15, color: INK }}>{name}</b>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "14px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
          {messages.map((m, i) => {
            const mine = m.from === "me";
            return (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexDirection: mine ? "row-reverse" : "row" }}>
                {LANG === "zh" ? (mine ? <Avatar name={T.me} id="me" size={34} /> : <Avatar name={name} id={openId} size={34} />) : null}
                <div style={{ maxWidth: "74%", padding: "8px 12px", borderRadius: S.bubbleRadius, fontSize: 14.5, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
                  background: mine ? S.mine : S.theirs, color: mine ? S.mineText : S.theirsText, boxShadow: LANG === "en" ? "none" : "0 1px 1px rgba(0,0,0,0.06)" }}>
                  {String(m.text || "")}
                  {m.time || (S.tick && mine) ? (
                    <span style={{ display: "block", textAlign: "right", fontSize: 10.5, marginTop: 2, color: mine && LANG === "en" ? "rgba(255,255,255,0.75)" : "#8a8f99" }}>
                      {m.time ? String(m.time) : ""}{S.tick && mine ? " ✓✓" : ""}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
        <div style={{ display: "flex", gap: 8, padding: 10, background: LANG === "es" ? "#f0f2f5" : "#f7f7f7", borderTop: "1px solid #e3e5eb" }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) send(); }} placeholder={T.say} style={field} />
          <button type="button" onClick={send} style={sendBtn}>{T.send}</button>
        </div>
      </div>
    );
  }

  const ids = Object.keys(threads);
  const unreadTotal = app.badge(data);
  const tabBtn = (key, label, badge) => (
    <button type="button" onClick={() => setTab(key)} aria-pressed={tab === key}
      style={{ flex: 1, border: "none", cursor: "pointer", padding: "8px 0", fontSize: 14, fontWeight: 700, borderRadius: 10, background: tab === key ? "#fff" : "transparent", color: tab === key ? INK : MUTED, boxShadow: tab === key ? "0 1px 3px rgba(20,24,40,0.12)" : "none" }}>
      {label}{badge ? <span style={{ marginLeft: 6, fontSize: 11, padding: "0 6px", borderRadius: 99, background: "#ff3b4e", color: "#fff" }}>{badge}</span> : null}
    </button>
  );

  return (
    <div style={{ padding: 14, display: "grid", gap: 12, alignContent: "start" }}>
      <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: 12, background: "#e6e8ee" }}>
        {tabBtn("chats", T.chats, unreadTotal)}
        {tabBtn("moments", T.moments, 0)}
      </div>

      {tab === "chats" ? (
        <>
          <div style={{ borderRadius: 16, background: "#fff", border: "1px solid #eceef4", overflow: "hidden" }}>
            {ids.length === 0 ? <p style={{ margin: 0, padding: "22px 18px", fontSize: 13.5, color: MUTED, lineHeight: 1.7, textAlign: "center" }}>{T.noChats}</p> : null}
            {ids.map((id, n) => {
              const t = threads[id] || {};
              const msgs = Array.isArray(t.messages) ? t.messages : [];
              const last = msgs[msgs.length - 1];
              const name = String(t.name || id);
              const unread = Number(t.unread) || 0;
              return (
                <button key={id} type="button" onClick={() => setOpenId(id)}
                  style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", width: "100%", boxSizing: "border-box", borderTop: n ? "1px solid #f0f1f5" : "none" }}>
                  <span style={{ position: "relative" }}>
                    <Avatar name={name} id={id} />
                    {unread > 0 && LANG === "zh" ? <span style={{ position: "absolute", top: -4, right: -4, minWidth: 16, height: 16, borderRadius: 8, background: "#fa5151", color: "#fff", fontSize: 10.5, fontWeight: 700, display: "grid", placeItems: "center", padding: "0 4px" }}>{unread}</span> : null}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <b style={{ fontSize: 15, color: INK }}>{name}</b>
                      {last && last.time ? <span style={{ fontSize: 11.5, color: unread && LANG === "es" ? S.accent : MUTED }}>{String(last.time)}</span> : null}
                    </span>
                    <span style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
                      <span style={{ fontSize: 13, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {last ? (last.from === "me" ? T.me + ": " : "") + String(last.text || "") : ""}
                      </span>
                      {unread > 0 && LANG !== "zh" ? <span style={{ minWidth: 18, height: 18, borderRadius: 9, background: S.accent, color: "#fff", fontSize: 11, fontWeight: 700, display: "grid", placeItems: "center", padding: "0 5px", flexShrink: 0 }}>{unread}</span> : null}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") startChat(); }} placeholder={T.newChat} style={field} />
            <button type="button" onClick={startChat} style={sendBtn}>{T.start}</button>
          </div>
        </>
      ) : (
        <>
          {moments.length === 0 ? <p style={{ margin: "8px 2px", fontSize: 13.5, color: MUTED, textAlign: "center" }}>{T.noMoments}</p> : null}
          {moments.slice().reverse().map((m, ri) => {
            const i = moments.length - 1 - ri;
            const author = String(m.author || "?");
            const cs = Array.isArray(m.comments) ? m.comments : [];
            const likes = (Number(m.likes) || 0) + (m.liked ? 1 : 0);
            return (
              <div key={m.id || i} style={{ padding: 14, borderRadius: 16, background: "#fff", border: "1px solid #eceef4", display: "grid", gridTemplateColumns: "auto 1fr", gap: "0 11px" }}>
                <Avatar name={author} id={author} size={40} />
                <div style={{ minWidth: 0, display: "grid", gap: 6 }}>
                  <b style={{ fontSize: 14.5, color: LANG === "zh" ? "#576b95" : INK }}>{author}</b>
                  <div style={{ fontSize: 14.5, lineHeight: 1.6, color: INK, whiteSpace: "pre-wrap" }}>{String(m.text || "")}</div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 11.5, color: MUTED }}>{m.time ? String(m.time) : ""}</span>
                    <button type="button" onClick={() => toggleLike(i)} aria-pressed={!!m.liked}
                      style={{ border: "none", borderRadius: 8, cursor: "pointer", padding: "3px 9px", fontSize: 13, background: m.liked ? "#ffe3ec" : "#f1f2f6", color: m.liked ? "#e23c6b" : "#5b6075" }}>
                      {m.liked ? "♥" : "♡"}
                    </button>
                  </div>
                  {likes > 0 || cs.length > 0 ? (
                    <div style={{ display: "grid", gap: 3, padding: "7px 10px", borderRadius: 8, background: "#f5f6f8", fontSize: 13, lineHeight: 1.5 }}>
                      {likes > 0 ? <span style={{ color: "#576b95" }}>♥ {T.likes.replace("{n}", String(likes))}</span> : null}
                      {cs.map((c, k) => (
                        <span key={k}><b style={{ color: "#576b95", fontWeight: 600 }}>{c.author === "me" ? T.me : String(c.author || "")}</b>: {String(c.text || "")}</span>
                      ))}
                    </div>
                  ) : null}
                  <input value={comments[i] || ""} onChange={(e) => setComments({ ...comments, [i]: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") addComment(i); }} placeholder={T.comment} style={{ ...field, padding: "7px 12px", fontSize: 13 }} />
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

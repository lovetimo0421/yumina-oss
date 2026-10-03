// @ts-nocheck
// Card UI source: React and useYumina are injected globals at runtime.
//
// App pack: Bag — wallet and belongings. The AI keeps the balance, a short
// ledger of every money change, and the items the player carries. Tapping an
// item shows what it is and offers "Use", which fills the chat box.

const LANG = "__YUMINA_APP_LANG__";
const VAR = "app_bag";

const TABLE = {
  zh: {
    name: "背包", balance: "余额", ledger: "最近收支", items: "物品", use: "使用", back: "返回",
    draft: "（使用{name}）", empty: "包里还是空的。得到的东西会自动放进来。", noLedger: "还没有收支记录。",
    rarity: { common: "普通", rare: "稀有", epic: "史诗", legendary: "传说" },
  },
  en: {
    name: "Bag", balance: "Balance", ledger: "Recent", items: "Items", use: "Use", back: "Back",
    draft: "(uses {name}) ", empty: "Nothing here yet. Things you get land here on their own.", noLedger: "No transactions yet.",
    rarity: { common: "Common", rare: "Rare", epic: "Epic", legendary: "Legendary" },
  },
  es: {
    name: "Mochila", balance: "Saldo", ledger: "Movimientos", items: "Objetos", use: "Usar", back: "Atrás",
    draft: "(usa {name}) ", empty: "Aún no hay nada. Lo que consigas aparecerá aquí solo.", noLedger: "Sin movimientos todavía.",
    rarity: { common: "Común", rare: "Raro", epic: "Épico", legendary: "Legendario" },
  },
};
const T = TABLE[LANG] || TABLE.en;

export const app = { id: "bag", icon: "🎒", name: T.name, variable: VAR, accent: "#f5a524", accent2: "#f97316", lang: LANG };

const INK = "#1b1e2b";
const MUTED = "#737891";
const RARITY = { common: "#c9cdd9", rare: "#3d8bff", epic: "#9a5bff", legendary: "#f5a524" };
const card = { borderRadius: 18, background: "#fff", border: "1px solid #eceef4", boxShadow: "0 1px 2px rgba(20,24,40,0.05)" };

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? "");
  return v.toLocaleString(LANG === "zh" ? "zh-CN" : LANG === "es" ? "es-ES" : "en-US");
}

export default function Bag({ close }) {
  const api = useYumina();
  const data = api.variables[VAR] || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const ledger = Array.isArray(data.ledger) ? data.ledger : [];
  const [openIdx, setOpenIdx] = React.useState(null);
  const hasWallet = data.balance !== undefined && data.balance !== null && data.balance !== "";

  const item = openIdx !== null ? items[openIdx] : null;
  if (item) {
    const rc = RARITY[item.rarity] || RARITY.common;
    const name = String(item.name || "");
    return (
      <div style={{ padding: 14, display: "grid", gap: 12 }}>
        <button type="button" onClick={() => setOpenIdx(null)}
          style={{ justifySelf: "start", border: "none", cursor: "pointer", background: "#eef0f5", color: "#5b6075", borderRadius: 10, padding: "6px 12px", fontSize: 13, fontWeight: 600 }}>
          ‹ {T.back}
        </button>
        <div style={{ ...card, padding: 20, display: "grid", justifyItems: "center", gap: 10, textAlign: "center" }}>
          <span style={{ width: 88, height: 88, borderRadius: 24, display: "grid", placeItems: "center", fontSize: 46, background: "#f7f8fb", border: "3px solid " + rc }}>{item.icon || "📦"}</span>
          <b style={{ fontSize: 18, color: INK }}>{name}{Number(item.qty) > 1 ? " ×" + item.qty : ""}</b>
          <span style={{ fontSize: 12, fontWeight: 700, color: rc === RARITY.common ? MUTED : rc }}>{T.rarity[item.rarity] || T.rarity.common}</span>
          {item.note ? <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: INK }}>{String(item.note)}</p> : null}
          <button type="button" onClick={() => { api.setComposerDraft(T.draft.replace("{name}", name)); if (close) close(); }}
            style={{ marginTop: 4, border: "none", cursor: "pointer", borderRadius: 12, padding: "10px 28px", fontSize: 14, fontWeight: 800, color: "#fff", background: "linear-gradient(135deg, #f5a524, #f97316)" }}>
            {T.use}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 14, display: "grid", gap: 12 }}>
      {hasWallet ? (
        <div style={{ borderRadius: 20, padding: "16px 18px", color: "#fff", background: "linear-gradient(135deg, #f5a524, #f97316 60%, #ea580c)", boxShadow: "0 8px 20px rgba(249,115,22,0.28)" }}>
          <div style={{ fontSize: 12.5, opacity: 0.9, fontWeight: 600 }}>{T.balance}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2 }}>
            <b style={{ fontSize: 32, fontVariantNumeric: "tabular-nums", lineHeight: 1.15 }}>{money(data.balance)}</b>
            {data.currency ? <span style={{ fontSize: 14, fontWeight: 700, opacity: 0.95 }}>{String(data.currency)}</span> : null}
          </div>
          <div style={{ marginTop: 12, background: "rgba(255,255,255,0.95)", borderRadius: 14, padding: "4px 12px" }}>
            <div style={{ fontSize: 11.5, color: MUTED, padding: "6px 0 2px" }}>{T.ledger}</div>
            {ledger.length === 0 ? <div style={{ fontSize: 12.5, color: MUTED, padding: "4px 0 8px" }}>{T.noLedger}</div> : null}
            {ledger.slice(-5).reverse().map((l, i) => {
              const amt = Number(l.amount) || 0;
              return (
                <div key={l.id || i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: i ? "1px solid #f0f1f5" : "none" }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: INK, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(l.what || "")}</span>
                  {l.time ? <span style={{ fontSize: 11, color: MUTED }}>{String(l.time)}</span> : null}
                  <b style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", color: amt >= 0 ? "#12925a" : "#d23b3b" }}>{amt >= 0 ? "+" + money(amt) : "−" + money(Math.abs(amt))}</b>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <b style={{ fontSize: 13, color: MUTED, padding: "0 2px" }}>{T.items}{items.length ? " · " + items.length : ""}</b>
      {items.length === 0 ? (
        <div style={{ padding: "24px 24px", textAlign: "center", color: MUTED, fontSize: 14, lineHeight: 1.7 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🎒</div>{T.empty}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: 10 }}>
          {items.map((it, i) => {
            const rc = RARITY[it.rarity] || RARITY.common;
            return (
              <button key={it.id || i} type="button" onClick={() => setOpenIdx(i)} title={String(it.name || "")}
                style={{ position: "relative", cursor: "pointer", border: "2px solid " + rc, borderRadius: 16, background: "#fff", padding: "12px 6px 9px", display: "grid", justifyItems: "center", gap: 5, boxShadow: "0 1px 2px rgba(20,24,40,0.05)" }}>
                <span style={{ fontSize: 30, lineHeight: 1 }}>{it.icon || "📦"}</span>
                <span style={{ fontSize: 12, color: INK, fontWeight: 600, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(it.name || "")}</span>
                {Number(it.qty) > 1 ? (
                  <span style={{ position: "absolute", top: 5, right: 6, fontSize: 11, fontWeight: 800, color: "#fff", background: "#1b1e2b", borderRadius: 8, padding: "0 5px", lineHeight: "16px" }}>×{it.qty}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

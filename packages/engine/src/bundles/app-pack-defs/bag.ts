import type { AppPackDef } from "../app-pack-types.js";

export const bag: AppPackDef = {
  icon: "🎒",
  variableId: "app_bag",
  defaultValue: { currency: "", balance: 0, ledger: [], items: [] },
  sample: {
    zh: {
      currency: "元", balance: 18420,
      ledger: [
        { id: "l1", amount: 12000, what: "设计稿尾款", time: "周三" },
        { id: "l2", amount: -540, what: "给陆衍买的围巾", time: "周三" },
        { id: "l3", amount: -3000, what: "工作室房租", time: "周四" },
      ],
      items: [
        { id: "i1", name: "同款围巾", icon: "🧣", qty: 1, note: "陆衍那条的同款。现在热搜上都在扒它。", rarity: "rare" },
        { id: "i2", name: "备用手机", icon: "📱", qty: 1, note: "只存了一个号码，备注是一个月亮。", rarity: "epic" },
        { id: "i3", name: "口罩", icon: "😷", qty: 6, note: "出门见他时必备。", rarity: "common" },
        { id: "i4", name: "酒店房卡", icon: "🗝️", qty: 1, note: "他剧组附近那家，用的是化名。", rarity: "legendary" },
      ],
    },
    en: {
      currency: "¥", balance: 4200,
      ledger: [
        { id: "l1", amount: 5000, what: "Allowance", time: "Mon" },
        { id: "l2", amount: -650, what: "Café with Hina", time: "Wed" },
        { id: "l3", amount: -150, what: "Train ticket", time: "Thu" },
      ],
      items: [
        { id: "i1", name: "Hina's hair clip", icon: "🌸", qty: 1, note: "She dropped it on the rooftop. You haven't given it back yet.", rarity: "rare" },
        { id: "i2", name: "Study notes", icon: "📓", qty: 3, note: "Rin's handwriting in the margins.", rarity: "common" },
        { id: "i3", name: "Festival ticket", icon: "🎟️", qty: 2, note: "Two tickets. You only need one… or do you?", rarity: "epic" },
      ],
    },
    es: {
      currency: "€", balance: 320,
      ledger: [
        { id: "l1", amount: 900, what: "Sueldo de la cafetería", time: "Lun" },
        { id: "l2", amount: -45, what: "Supresores", time: "Vie" },
      ],
      items: [
        { id: "i1", name: "Supresores", icon: "💊", qty: 4, note: "Te quedan pocos para esta luna.", rarity: "rare" },
        { id: "i2", name: "Chaqueta de Daigo", icon: "🧥", qty: 1, note: "Todavía huele a él. No se la has devuelto.", rarity: "epic" },
        { id: "i3", name: "Llaves del piso", icon: "🔑", qty: 1, note: "Las compartes con Haruo.", rarity: "common" },
      ],
    },
  },
  words: {
    zh: {
      name: "背包",
      description: "钱包和随身物品：余额、每一笔收支、带着的东西。点开物品能看说明，一键\"使用\"。",
      variableName: "App · 背包",
      rules: `"背包"App，包括钱包和随身物品。数据形状：{"currency": 货币名, "balance": 余额数字, "ledger": [{"id", "amount": 正数为收入、负数为支出, "what": 一句说明, "time"}], "items": [{"id", "name", "icon": 一个 emoji, "qty": 数量, "note": 一句说明, "rarity": "common"|"rare"|"epic"|"legendary"}]}。
- 开场时按故事设定定好货币（符合这个世界的叫法）、初始余额和几件随身物品。
- 每次钱变化都要同时做两件事：改 balance，并 push 一条 ledger（最多保留 20 条，多了删最旧的）。
- 得到、用掉、丢失东西时改 items：新物品 push，数量变了改 qty，用完或丢了就删掉。icon 只放一个 emoji；重要或珍贵的东西用更高的 rarity。
- 所有文字用故事的语言写。`,
    },
    en: {
      name: "Bag",
      description: "Wallet and belongings: balance, every transaction, and what you carry. Tap an item to read about it and \"Use\" it in one tap.",
      variableName: "App · Bag",
      rules: `A "Bag" app holding the player's wallet and belongings. Shape: {"currency": currency name, "balance": number, "ledger": [{"id", "amount": positive for income, negative for spending, "what": one line, "time"}], "items": [{"id", "name", "icon": one emoji, "qty": number, "note": one line, "rarity": "common"|"rare"|"epic"|"legendary"}]}.
- At the opening, set a currency that fits this world, a starting balance and a few things the player carries.
- Every money change does two things together: update balance and push a ledger line (keep at most 20, delete the oldest).
- When the player gains, uses up or loses something, change items: push new ones, update qty when the amount changes, delete what is used up or gone. icon is a single emoji; give important or precious things a higher rarity.
- Write all text in the story's language.`,
    },
    es: {
      name: "Mochila",
      description: "Cartera y pertenencias: saldo, cada movimiento de dinero y lo que llevas encima. Toca un objeto para leerlo y \"Usar\" con un toque.",
      variableName: "App · Mochila",
      rules: `Una app de "Mochila" con la cartera y las pertenencias del jugador. Forma: {"currency": nombre de la moneda, "balance": número, "ledger": [{"id", "amount": positivo si es ingreso, negativo si es gasto, "what": una frase, "time"}], "items": [{"id", "name", "icon": un emoji, "qty": número, "note": una frase, "rarity": "common"|"rare"|"epic"|"legendary"}]}.
- En la apertura, fija una moneda que encaje con este mundo, un saldo inicial y unas cuantas cosas que lleva el jugador.
- Cada cambio de dinero hace dos cosas a la vez: actualiza balance y haz push de una línea en ledger (guarda como máximo 20 y borra las más antiguas).
- Cuando el jugador consigue, gasta o pierde algo, cambia items: push para lo nuevo, actualiza qty cuando cambie la cantidad y borra lo que se acabe o se pierda. icon es un solo emoji; da una rarity más alta a lo importante o valioso.
- Escribe todo el texto en el idioma de la historia.`,
    },
  },
};

import type { AppPackDef } from "../app-pack-types.js";

export const time: AppPackDef = {
  icon: "🕐",
  variableId: "app_time",
  defaultValue: { day: 0, clock: "", period: "", date: "", weather: "", agenda: [] },
  sample: {
    zh: { day: 3, clock: "23:47", period: "late", date: "周四", weather: "小雨",
      agenda: [
        { id: "a1", when: "明天 08:00", what: "品牌代言拍摄（陆衍）", with: "陆衍", done: false },
        { id: "a2", when: "周五晚", what: "和小瑜吃火锅", with: "林小瑜", done: false },
        { id: "p1", when: "", what: "删掉小号那条微博", done: false, by: "player" },
        { id: "a0", when: "今天下午", what: "去片场送宵夜", with: "陆衍", done: true },
      ] },
    en: { day: 12, clock: "16:20", period: "afternoon", date: "Sakura Season, week 2", weather: "Petals on the wind",
      agenda: [
        { id: "a1", when: "Tomorrow after school", what: "Study session in the library", with: "Rin", done: false },
        { id: "p1", when: "", what: "Buy Hina's birthday gift", done: false, by: "player" },
      ] },
    es: { day: 5, clock: "19:30", period: "evening", date: "Viernes", weather: "Luna llena",
      agenda: [
        { id: "a1", when: "Esta noche", what: "Cena con Daigo", with: "Daigo", done: false },
        { id: "p1", when: "", what: "Comprar supresores", done: true, by: "player" },
      ] },
  },
  words: {
    zh: {
      name: "时间与日程",
      description: "故事里的时钟：第几天、几点、天气，天色跟着时段变。约好的事会自动记进日程，玩家也能自己加、自己勾掉。",
      variableName: "App · 时间与日程",
      rules: `"时间与日程"App。数据形状：{"day": 第几天, "clock": "HH:MM", "period": dawn|morning|noon|afternoon|evening|night|late 之一, "date": 日期（可留空）, "weather": 天气（几个字）, "agenda": [{"id", "when": 什么时候, "what": 什么事, "with": 和谁, "done": 是否完成, "by": 谁加的}]}。
- 开场时按故事设定填好 day、clock、period、weather。故事里时间过去就推进 clock 和 period，新的一天开始时 day 加 1。
- 做了约定、安排或承诺，就 push 一条到 agenda，填好 when 和 with。事情发生了把 done 设为 true；不再成立就删掉。
- 日程快到的时候在剧情里提醒玩家；错过了就让它有后果。
- by 为 "player" 的条目是玩家自己加的打算，当作 TA 的意图对待，不要删，可以补上 when。
- 所有文字用故事的语言写。`,
    },
    en: {
      name: "Time & Plans",
      description: "The story's clock: day, time and weather, with a sky that follows the time of day. Appointments land in the plans on their own, and the player can add or tick off their own.",
      variableName: "App · Time & Plans",
      rules: `A "Time & Plans" app. Shape: {"day": day number, "clock": "HH:MM", "period": one of dawn|morning|noon|afternoon|evening|night|late, "date": date text (may be empty), "weather": a few words, "agenda": [{"id", "when", "what", "with", "done", "by"}]}.
- At the opening, fill day, clock, period and weather from the story. Advance clock and period as story time passes; add 1 to day when a new day starts.
- When a plan, appointment or promise is made, push it to agenda with when and with filled in. Set done to true when it happens; delete it if it no longer applies.
- Remind the player in the story when a plan is close; if they miss it, let that have consequences.
- Items with by "player" were added by the player: treat them as their intentions, never delete them, and you may fill in when.
- Write all text in the story's language.`,
    },
    es: {
      name: "Tiempo y agenda",
      description: "El reloj de la historia: día, hora y clima, con un cielo que cambia según la hora. Las citas se anotan solas y el jugador puede añadir o tachar las suyas.",
      variableName: "App · Tiempo y agenda",
      rules: `Una app de "Tiempo y agenda". Forma: {"day": número de día, "clock": "HH:MM", "period": uno de dawn|morning|noon|afternoon|evening|night|late, "date": fecha (puede quedar vacía), "weather": pocas palabras, "agenda": [{"id", "when", "what", "with", "done", "by"}]}.
- En la apertura, rellena day, clock, period y weather según la historia. Avanza clock y period cuando pase el tiempo; suma 1 a day cuando empiece un día nuevo.
- Cuando se haga un plan, una cita o una promesa, haz push a agenda con when y with. Pon done en true cuando ocurra; bórralo si ya no aplica.
- Recuérdale al jugador en la historia cuando se acerque un plan; si lo pierde, que tenga consecuencias.
- Los elementos con by "player" los añadió el jugador: trátalos como sus intenciones, no los borres nunca y puedes completar when.
- Escribe todo el texto en el idioma de la historia.`,
    },
  },
};

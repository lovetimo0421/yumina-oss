import type { AppPackDef } from "../app-pack-types.js";

export const places: AppPackDef = {
  icon: "🗺️",
  variableId: "app_places",
  defaultValue: { here: "", places: {} },
  sample: {
    zh: { here: "home", places: {
      home: { name: "你的公寓", icon: "🏠", desc: "十七楼，窗外能看到半个城市的霓虹。", who: [], visited: true, danger: 0 },
      studio: { name: "影视城 3 号棚", icon: "🎬", desc: "陆衍这几天都在这里拍夜戏。", who: ["陆衍", "赵姐"], visited: true, danger: 1 },
      hotpot: { name: "老街火锅店", icon: "🍲", desc: "小瑜最爱的店，包间隔音很好。", who: ["林小瑜"], visited: true, danger: 0 },
      airport: { name: "首都机场 T3", icon: "✈️", desc: "狗仔常年蹲守的地方。", who: [], visited: false, danger: 3 },
    } },
    en: { here: "classroom", places: {
      classroom: { name: "Class 2-B", icon: "🏫", desc: "Afternoon light, chalk dust, everyone packing up.", who: ["Rin"], visited: true, danger: 0 },
      rooftop: { name: "School rooftop", icon: "🌸", desc: "Technically off-limits. Hina is waiting.", who: ["Hina"], visited: true, danger: 0 },
      library: { name: "Library", icon: "📚", desc: "Quiet corner by the window, Rin's usual seat.", who: [], visited: false, danger: 0 },
    } },
    es: { here: "flat", places: {
      flat: { name: "Tu piso", icon: "🏠", desc: "Las ventanas cerradas, la luna llena asomando.", who: ["Haruo"], visited: true, danger: 0 },
      bar: { name: "Bar Kuroi", icon: "🍸", desc: "Territorio de la manada de Daigo.", who: ["Daigo"], visited: true, danger: 1 },
      forest: { name: "Bosque del norte", icon: "🌲", desc: "Nadie entra allí en luna llena.", who: [], visited: false, danger: 3 },
    } },
  },
  words: {
    zh: {
      name: "地点",
      description: "你现在在哪、知道哪些地方、谁在哪儿。点「去这里」就出发，不用自己打字。",
      variableName: "App · 地点",
      rules: `玩家随时能打开的"地点"App。数据形状：{"here": 当前地点的 id, "places": {"<id>": {"name": 地名, "icon": 一个 emoji, "desc": 一句话描述, "who": [此刻在那里的角色名], "visited": 玩家是否去过, "danger": 危险程度 0-3}}}。
- 开场时设好 here，并把故事里提到的几个地方加进 places。之后玩家知道了新地方，就用 merge 加进去。<id> 是简短的小写英文键，定了不要再改。
- who 按玩家所知道的角色行踪保持最新；玩家不知道的行踪不要写。
- 玩家以"（前往某地）"开头的行动，表示 TA 要去那里：路上怎么走由你写，到了之后把 here 改成那个地点，并把 visited 设为 true。
- 每回合只改真的变了的字段。所有文字用故事的语言写。`,
    },
    en: {
      name: "Places",
      description: "Where you are, the places you know, and who is where. Tap Go to head somewhere without typing it.",
      variableName: "App · Places",
      rules: `A "Places" app the player can open at any time. Shape: {"here": id of the current place, "places": {"<id>": {"name": name, "icon": one emoji, "desc": one sentence, "who": [names of characters there right now], "visited": whether the player has been there, "danger": 0-3}}}.
- At the opening, set here and add a few places the story mentions. After that, add places (merge into places) as the player learns of them. <id> is a short lowercase key you never change.
- Keep who current with the characters' whereabouts as far as the player knows; never list whereabouts the player could not know.
- Player actions that begin with "(goes to PLACE)" mean the player travels there: narrate the way, and when they arrive set here to that place and visited to true.
- Each turn, update only the fields that actually changed. Write all text in the story's language.`,
    },
    es: {
      name: "Lugares",
      description: "Dónde estás, qué lugares conoces y quién está en cada uno. Pulsa Ir para ir a un sitio sin escribirlo.",
      variableName: "App · Lugares",
      rules: `Una app de "Lugares" que el jugador puede abrir en cualquier momento. Forma: {"here": id del lugar actual, "places": {"<id>": {"name": nombre, "icon": un emoji, "desc": una frase, "who": [nombres de los personajes que están allí ahora], "visited": si el jugador ya ha estado, "danger": 0-3}}}.
- En la apertura, fija here y añade algunos lugares que menciona la historia. Después, añade lugares (merge en places) cuando el jugador los conozca. <id> es una clave corta en minúsculas que no cambias nunca.
- Mantén who al día con el paradero de los personajes según lo que sabe el jugador; nunca pongas paraderos que el jugador no podría saber.
- Las acciones del jugador que empiezan con "(va a LUGAR)" significan que viaja allí: narra el camino y, cuando llegue, pon here en ese lugar y visited en true.
- En cada turno, actualiza solo los campos que de verdad cambiaron. Escribe todo el texto en el idioma de la historia.`,
    },
  },
};

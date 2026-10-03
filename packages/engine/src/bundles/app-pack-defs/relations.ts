import type { AppPackDef } from "../app-pack-types.js";

export const relations: AppPackDef = {
  icon: "💞",
  variableId: "app_relations",
  defaultValue: { chars: {} },
  sample: {
    zh: { chars: {
      luyan: { name: "陆衍", tag: "秘密男友", mood: "疲惫但温柔", affection: 80, trust: 64, note: "觉得你今晚有心事，想问又怕你多想。" },
      zhao: { name: "赵姐", tag: "他的经纪人", mood: "警惕", affection: 35, trust: 22, note: "怀疑你会毁了陆衍的事业。" },
      xiaoyu: { name: "林小瑜", tag: "闺蜜", mood: "兴奋八卦中", affection: 85, trust: 78, note: "只想第一个知道你们的事。" },
    } },
    en: { chars: {
      hina: { name: "Hina", tag: "Childhood friend", mood: "Nervous, hopeful", affection: 72, trust: 60, note: "Thinks you've been avoiding her since the festival." },
      rin: { name: "Rin", tag: "Rival in class", mood: "Irritated", affection: 38, trust: 45, note: "Won't admit she enjoys arguing with you." },
    } },
    es: { chars: {
      daigo: { name: "Daigo", tag: "Tu alfa", mood: "Protector, celoso", affection: 76, trust: 58, note: "Siente que le ocultas algo desde ayer." },
      haruo: { name: "Haruo", tag: "Compañero de piso", mood: "Tranquilo", affection: 52, trust: 70, note: "Te cubre sin hacer preguntas." },
    } },
  },
  words: {
    zh: {
      name: "角色关系",
      description: "每个重要角色一张卡：好感、信任、此刻的心情、和你的关系。数值一变就标出 +3 / −2。",
      variableName: "App · 角色关系",
      rules: `玩家随时能打开的"角色关系"App。数据形状：{"chars": {"<id>": {"name": 名字, "tag": 和玩家的关系（几个字）, "mood": 此刻心情（几个字）, "affection": 好感 0-100, "trust": 信任 0-100, "note": 一句话，TA 现在怎么看玩家}}}。
- 开场时把登场的主要角色都加进来。之后角色第一次对玩家有意义时，用 merge 把 TA 加进 chars。<id> 是简短的小写英文键，定了不要再改。
- 陌生人一般从 30-50 起。好感和信任只因真实的原因变化，每次 1-5；只有转折点才动 10 以上。
- mood 和 note 要跟着剧情变：玩家这回合做的事让谁有了新想法，就更新谁的 note。
- 每回合只改真的变了的字段。所有文字用故事的语言写。`,
    },
    en: {
      name: "Relationships",
      description: "One card per important character: affection, trust, current mood and what they are to you. Every change is marked +3 / −2.",
      variableName: "App · Relationships",
      rules: `A "Relationships" app the player can open at any time. Shape: {"chars": {"<id>": {"name": name, "tag": what they are to the player (a few words), "mood": how they feel right now (a few words), "affection": 0-100, "trust": 0-100, "note": one sentence, what they currently think of the player}}}.
- At the opening, add the main characters on stage. After that, add a character (merge into chars) the first time they matter to the player. <id> is a short lowercase key you never change.
- Strangers usually start around 30-50. Affection and trust move only for real reasons, 1-5 at a time; 10 or more only at turning points.
- Keep mood and note alive: when something the player did this turn changes what someone thinks, update that person's note.
- Each turn, update only the fields that actually changed. Write all text in the story's language.`,
    },
    es: {
      name: "Relaciones",
      description: "Una tarjeta por personaje importante: afecto, confianza, estado de ánimo y qué es para ti. Cada cambio se marca +3 / −2.",
      variableName: "App · Relaciones",
      rules: `Una app de "Relaciones" que el jugador puede abrir en cualquier momento. Forma: {"chars": {"<id>": {"name": nombre, "tag": qué es para el jugador (pocas palabras), "mood": cómo se siente ahora (pocas palabras), "affection": 0-100, "trust": 0-100, "note": una frase, qué piensa ahora del jugador}}}.
- En la apertura, añade a los personajes principales en escena. Después, añade a un personaje (merge en chars) la primera vez que importe al jugador. <id> es una clave corta en minúsculas que no cambias nunca.
- Los desconocidos suelen empezar entre 30 y 50. El afecto y la confianza solo cambian por razones reales, de 1 a 5 cada vez; 10 o más solo en momentos decisivos.
- Mantén vivos mood y note: si algo que hizo el jugador en este turno cambia lo que alguien piensa, actualiza su note.
- En cada turno, actualiza solo los campos que de verdad cambiaron. Escribe todo el texto en el idioma de la historia.`,
    },
  },
};

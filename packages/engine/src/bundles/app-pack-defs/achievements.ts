import type { AppPackDef } from "../app-pack-types.js";

export const achievements: AppPackDef = {
  icon: "🏆",
  variableId: "app_achievements",
  defaultValue: { unlocked: [], hints: [] },
  sample: {
    zh: {
      unlocked: [
        { id: "a1", title: "地下恋人", desc: "和顶流在一起一周，没有一个狗仔发现。", icon: "🕶️", time: "第 2 天", rare: false },
        { id: "a2", title: "月亮只照一个人", desc: "陆衍在朋友圈里暗戳戳地提到了你。", icon: "🌙", time: "第 3 天", rare: true },
      ],
      hints: [
        { id: "h1", title: "官宣", hint: "也许有一天，你们能站在阳光下。" },
        { id: "h2", title: "赵姐的认可", hint: "让那个最不信任你的人改变看法。" },
      ],
    },
    en: {
      unlocked: [
        { id: "a1", title: "Rooftop Regular", desc: "Met Hina on the forbidden rooftop three times.", icon: "🌸", time: "Day 10", rare: false },
        { id: "a2", title: "Worthy Rival", desc: "Beat Rin on a test. She noticed.", icon: "📝", time: "Day 12", rare: false },
      ],
      hints: [
        { id: "h1", title: "Confession", hint: "Some words are easier to say under falling petals." },
        { id: "h2", title: "Library Secret", hint: "Who keeps leaving notes in the books?" },
      ],
    },
    es: {
      unlocked: [
        { id: "a1", title: "Olor a manada", desc: "Daigo te presentó a su manada sin gruñir a nadie.", icon: "🐺", time: "Día 4", rare: true },
      ],
      hints: [
        { id: "h1", title: "Luna llena", hint: "Sobrevive a una noche de luna llena junto a él." },
        { id: "h2", title: "El que te sigue", hint: "Descubre quién te vigila desde el bar Kuroi." },
      ],
    },
  },
  words: {
    zh: {
      name: "成就",
      description: "做了让人记住的事，就解锁一枚成就，还有几条没解锁的提示勾着你往下玩。",
      variableName: "App · 成就",
      rules: `玩家随时能打开的"成就"App。数据形状：{"unlocked": [{"id", "title": 成就名, "desc": 一句话说明, "icon": 一个 emoji, "time": 故事里的时间, "rare": 是否稀有}], "hints": [{"id", "title", "hint": 一句不剧透的提示}]}。
- 成就要少而珍贵：只在玩家亲手造成的、值得记住的时刻解锁（第一次心动、熬过一次背叛、揭开一个秘密……），几回合最多一个。用 push 加进 unlocked。
- title 简短、有点俏皮；desc 一句话。真正难得的时刻才把 rare 设为 true。
- 可以在 hints 里放 2-4 条玩家还能达成的事，hint 只给方向不剧透。玩家达成时，把那条从 hints 里 delete 掉，再 push 到 unlocked。
- 所有文字用故事的语言写。`,
    },
    en: {
      name: "Achievements",
      description: "Memorable moments unlock a medal, and a few locked hints tease what you could still pull off.",
      variableName: "App · Achievements",
      rules: `An "Achievements" app the player can open at any time. Shape: {"unlocked": [{"id", "title", "desc": one line, "icon": one emoji, "time": story time, "rare"}], "hints": [{"id", "title", "hint": one spoiler-free line}]}.
- Keep them rare and earned: unlock only for memorable moments the player caused (a first kiss, a betrayal survived, a secret uncovered…), at most one every few turns. Push it to unlocked.
- title is short and a little witty; desc is one line. Set rare to true only for truly exceptional moments.
- You may keep 2-4 hints for things the player could still achieve; a hint points the way without spoiling it. When the player earns one, delete it from hints and push it to unlocked.
- Write all text in the story's language.`,
    },
    es: {
      name: "Logros",
      description: "Los momentos memorables desbloquean una medalla, y algunas pistas bloqueadas insinúan lo que aún puedes conseguir.",
      variableName: "App · Logros",
      rules: `Una app de "Logros" que el jugador puede abrir en cualquier momento. Forma: {"unlocked": [{"id", "title", "desc": una línea, "icon": un emoji, "time": hora de la historia, "rare"}], "hints": [{"id", "title", "hint": una línea sin spoilers}]}.
- Que sean escasos y merecidos: desbloquea solo por momentos memorables que causó el jugador (un primer beso, sobrevivir a una traición, descubrir un secreto…), como mucho uno cada varios turnos. Haz push a unlocked.
- title es corto y con algo de gracia; desc es una línea. Pon rare en true solo para momentos realmente excepcionales.
- Puedes mantener 2-4 hints con cosas que el jugador aún podría lograr; la pista orienta sin destripar. Cuando el jugador lo consiga, bórrala (delete) de hints y haz push a unlocked.
- Escribe todo el texto en el idioma de la historia.`,
    },
  },
};

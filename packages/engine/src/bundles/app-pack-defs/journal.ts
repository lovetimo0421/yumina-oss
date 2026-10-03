import type { AppPackDef } from "../app-pack-types.js";

export const journal: AppPackDef = {
  icon: "📝",
  variableId: "app_journal",
  defaultValue: { entries: [] },
  sample: {
    zh: { entries: [
      { id: "e1", kind: "clue", title: "机场照片里的围巾", text: "热搜第三那张照片，陆衍脖子上的围巾和你送他的一模一样。", time: "第 3 天 · 下午", pinned: false },
      { id: "e2", kind: "secret", title: "赵姐在查你", text: "小瑜说赵姐托人打听过你的公司和住址。", time: "第 3 天 · 晚上", pinned: true },
      { id: "e3", kind: "goal", title: "撑过这周不被拍到", text: "周五之前不和陆衍同框出现在任何公共场所。", time: "第 3 天", pinned: false },
      { id: "p1", kind: "note", title: "", text: "小号那条微博一定要删。", time: "", pinned: false, by: "player" },
    ] },
    en: { entries: [
      { id: "e1", kind: "clue", title: "A note in the library book", text: "Someone slipped a folded note into the book Rin borrowed. It's signed with a cherry blossom.", time: "Day 12 · afternoon", pinned: true },
      { id: "e2", kind: "goal", title: "Find out what Hina wants to say", text: "She asked you to come to the rooftop after school.", time: "Day 12", pinned: false },
      { id: "p1", kind: "note", title: "", text: "Rin knows more than she lets on.", time: "", pinned: false, by: "player" },
    ] },
    es: { entries: [
      { id: "e1", kind: "secret", title: "Daigo no duerme en luna llena", text: "Haruo te contó que Daigo desaparece cada luna llena desde hace años.", time: "Día 5 · tarde", pinned: true },
      { id: "e2", kind: "clue", title: "Huellas junto al bosque", text: "Huellas enormes en el barro, demasiado grandes para un perro.", time: "Día 5", pinned: false },
      { id: "e3", kind: "goal", title: "Descubrir quién te sigue", text: "Alguien te observa desde el bar Kuroi.", time: "Día 5", pinned: false },
    ] },
  },
  words: {
    zh: {
      name: "线索笔记",
      description: "发现的线索、知道的秘密、接下的目标，自动记下来。你也能置顶、写自己的笔记，不花回合。",
      variableName: "App · 线索笔记",
      rules: `玩家随时能打开的"线索笔记"App。数据形状：{"entries": [{"id", "kind": clue|secret|goal|note 之一, "title": 短标题, "text": 一两句内容, "time": 故事里的时间, "pinned": 是否置顶, "by": 谁写的}]}。
- 玩家一得知某件事，就 push 一条：发现线索用 clue，知道了秘密用 secret，接下要做的事用 goal。站在玩家的角度，简短、只写事实。
- 绝不要写玩家还不知道的东西；不要替玩家下结论。
- 目标有进展时更新那条 goal 的 text；完成或作废时可以 delete 掉。
- by 为 "player" 的条目是玩家自己的想法：读它、让它影响剧情，但永远不要修改或删除。pinned 也由玩家决定，不要改。
- 所有文字用故事的语言写。`,
    },
    en: {
      name: "Journal",
      description: "Clues found, secrets learned, goals taken on — written down as they happen. Pin entries or add your own notes, no turn spent.",
      variableName: "App · Journal",
      rules: `A "Journal" app the player can open at any time. Shape: {"entries": [{"id", "kind": one of clue|secret|goal|note, "title": short title, "text": one or two sentences, "time": story time, "pinned", "by"}]}.
- As soon as the player learns something, push an entry: clue for evidence they found, secret for something hidden they found out, goal for something they set out to do. Write it from the player's point of view, short and factual.
- Never record anything the player has not learned, and never draw conclusions for them.
- When a goal progresses, update that goal's text; delete it when it is done or no longer applies.
- Entries with by "player" are the player's own thoughts: read them and let them shape the story, but never edit or delete them. pinned belongs to the player too; leave it alone.
- Write all text in the story's language.`,
    },
    es: {
      name: "Diario",
      description: "Pistas encontradas, secretos descubiertos, objetivos aceptados: se anotan en cuanto ocurren. Fija entradas o escribe tus notas sin gastar turno.",
      variableName: "App · Diario",
      rules: `Una app de "Diario" que el jugador puede abrir en cualquier momento. Forma: {"entries": [{"id", "kind": uno de clue|secret|goal|note, "title": título corto, "text": una o dos frases, "time": hora de la historia, "pinned", "by"}]}.
- En cuanto el jugador se entere de algo, haz push de una entrada: clue para una pista que encontró, secret para algo oculto que descubrió, goal para algo que se propone hacer. Escríbela desde el punto de vista del jugador, breve y con hechos.
- Nunca anotes nada que el jugador no sepa, ni saques conclusiones por él.
- Cuando un objetivo avance, actualiza su text; bórralo (delete) cuando se cumpla o ya no aplique.
- Las entradas con by "player" son pensamientos del propio jugador: léelas y deja que influyan en la historia, pero nunca las edites ni las borres. pinned también es del jugador; no lo toques.
- Escribe todo el texto en el idioma de la historia.`,
    },
  },
};

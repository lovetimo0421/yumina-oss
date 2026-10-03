import type { AppPackDef } from "../app-pack-types.js";

export const status: AppPackDef = {
  icon: "📊",
  variableId: "app_status",
  defaultValue: { bars: [], tags: [] },
  sample: {
    zh: {
      bars: [
        { id: "energy", label: "精力", value: 42, max: 100, color: "#10b981", note: "连着三天没睡好" },
        { id: "secrecy", label: "隐秘度", value: 80, max: 100, color: "#3d8bff", note: "小号那条微博还没删" },
        { id: "career", label: "事业值", value: 35, max: 100, color: "#f5a524" },
        { id: "suspicion", label: "粉丝怀疑值", value: 15, max: 100, color: "#ff5f8f" },
      ],
      tags: [
        { label: "身份", value: "服装设计师" },
        { label: "当前处境", value: "地下恋情第 2 年" },
        { label: "所在地", value: "城东公寓" },
        { label: "风险", value: "同款围巾被扒" },
      ],
    },
    en: {
      bars: [
        { id: "stamina", label: "Stamina", value: 64, max: 100, color: "#10b981" },
        { id: "grades", label: "Grades", value: 71, max: 100, color: "#3d8bff", note: "Midterms in two weeks" },
        { id: "popularity", label: "Popularity", value: 38, max: 100, color: "#ff5f8f" },
      ],
      tags: [
        { label: "Class", value: "2-B" },
        { label: "Club", value: "Literature" },
        { label: "Reputation", value: "Quiet but kind" },
      ],
    },
    es: {
      bars: [
        { id: "health", label: "Salud", value: 88, max: 100, color: "#10b981" },
        { id: "control", label: "Autocontrol", value: 46, max: 100, color: "#9a5bff", note: "La luna llena lo pone difícil" },
        { id: "danger", label: "Peligro", value: 62, max: 100, color: "#ef6a3a" },
        { id: "pack", label: "Lealtad de la manada", value: 30, max: 100, color: "#3d8bff" },
      ],
      tags: [
        { label: "Rango", value: "Omega" },
        { label: "Celo", value: "En 3 días" },
        { label: "Territorio", value: "Barrio Norte" },
      ],
    },
  },
  words: {
    zh: {
      name: "状态",
      description: "这个故事自己的数值面板：血量、体力、名声、危险度……开场时 AI 按故事挑合适的几项，之后跟着剧情涨跌。",
      variableName: "App · 状态",
      rules: `"状态"App，显示这个故事里最要紧的数值。数据形状：{"bars": [{"id", "label": 名称, "value": 当前值, "max": 上限, "color": "#rrggbb"（可省略）, "note": 一句说明（可省略）}], "tags": [{"label", "value"}]}。
- 开场时建 3-6 条适合这个故事的数值（比如生命、体力、名声、危险度、某种怀疑度），再加几个标签（身份、等级、所在地、状态之类）。id 用简短小写英文，定了就不要再改。
- 之后按剧情的因果改 value：受伤、休息、被发现、立功……value 始终在 0 到 max 之间。note 可以写这项为什么变了。
- 故事需要时可以加新的一条，不再有意义的可以删掉，但不要每回合重建整个列表。
- 所有文字用故事的语言写。`,
    },
    en: {
      name: "Status",
      description: "This story's own stat panel: health, stamina, reputation, danger… At the opening the AI picks the ones that fit, then moves them with the story.",
      variableName: "App · Status",
      rules: `A "Status" app showing the numbers that matter most in this story. Shape: {"bars": [{"id", "label", "value", "max", "color": "#rrggbb" (optional), "note": one line (optional)}], "tags": [{"label", "value"}]}.
- At the opening, create 3-6 bars that fit this story (for example health, stamina, reputation, danger, or some kind of suspicion) and a few tags (role, level, location, condition…). ids are short lowercase keys you never change.
- After that, change value by the story's cause and effect: injury, rest, being found out, a win… value always stays between 0 and max. note may say why it changed.
- Add a bar when the story needs one and delete one that no longer matters, but do not rebuild the whole list every turn.
- Write all text in the story's language.`,
    },
    es: {
      name: "Estado",
      description: "El panel de valores propio de esta historia: salud, energía, reputación, peligro… En la apertura la IA elige los que encajan y luego los mueve con la historia.",
      variableName: "App · Estado",
      rules: `Una app de "Estado" que muestra los valores que más importan en esta historia. Forma: {"bars": [{"id", "label", "value", "max", "color": "#rrggbb" (opcional), "note": una frase (opcional)}], "tags": [{"label", "value"}]}.
- En la apertura, crea 3-6 barras que encajen con esta historia (por ejemplo salud, energía, reputación, peligro o algún tipo de sospecha) y unas cuantas etiquetas (rol, nivel, lugar, condición…). Los id son claves cortas en minúsculas que no cambias nunca.
- Después, cambia value según la causa y el efecto de la historia: heridas, descanso, ser descubierto, un logro… value siempre queda entre 0 y max. note puede decir por qué cambió.
- Añade una barra cuando la historia la necesite y borra la que ya no importe, pero no reconstruyas toda la lista en cada turno.
- Escribe todo el texto en el idioma de la historia.`,
    },
  },
};

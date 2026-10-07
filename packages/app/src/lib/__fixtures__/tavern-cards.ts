/**
 * SillyTavern character cards in the three shapes found in the wild, as the
 * files carry them. Shared by the converter and import tests.
 */

/** V1: everything at the top level, no spec, no lorebook. */
export const TAVERN_V1 = {
  name: "Aqua",
  description: "A cheerful water goddess who is bad with money.",
  personality: "Loud, proud, cries easily.",
  scenario: "{{user}} just summoned her by accident.",
  first_mes: "Hey! You there! Worship me!",
  mes_example: "<START>\n{{char}}: I am a goddess, you know.",
};

/** V2: `spec: chara_card_v2`, data object, character_book with V2 entries. */
export const TAVERN_V2 = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "林雾",
    description: "二十四岁的图书管理员，戴一副圆框眼镜。",
    personality: "安静、记仇、嘴硬心软。",
    scenario: "雨夜，图书馆闭馆前十分钟。",
    first_mes: "……还有十分钟闭馆。",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: ["你又来还书了？"],
    tags: ["图书馆"],
    creator: "someone",
    character_version: "1",
    extensions: {},
    character_book: {
      name: "图书馆",
      entries: [
        { keys: ["旧书库"], content: "地下一层，常年锁着。", comment: "旧书库", enabled: true, insertion_order: 100, constant: false },
        { keys: ["馆长"], content: "姓周，六十岁。", name: "周馆长", comment: "", enabled: true, insertion_order: 100 },
        { keys: ["借书卡", "卡片"], content: "纸质借书卡。", enabled: true, insertion_order: 100 },
        { keys: [], content: "这座城市常年下雨。", constant: true, enabled: true, insertion_order: 100 },
      ],
    },
  },
};

/** V3: `spec: chara_card_v3`, V3 entry fields (name, use_regex, string positions). */
export const TAVERN_V3 = {
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "Sera",
    nickname: "Captain",
    description: "Captain of the airship Kestrel.",
    personality: "",
    scenario: "",
    first_mes: "Welcome aboard.",
    mes_example: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    group_only_greetings: [],
    tags: [],
    creator: "",
    character_version: "",
    extensions: {},
    character_book: {
      entries: [
        { keys: ["Kestrel"], content: "A three-mast airship.", name: "The Kestrel", comment: "", use_regex: false, enabled: true, insertion_order: 10, position: "after_char", extensions: {} },
      ],
    },
  },
};

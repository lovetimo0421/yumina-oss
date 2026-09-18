/**
 * The tag vocabulary: one entry per concept, with a display label in every app
 * locale and every spelling that should fold into it.
 *
 * WHY THIS IS ONE TABLE. A world tag is two things at once — a label the viewer
 * reads and an exact-match filter key. Before this file, the labels lived in the
 * app (stores/hub.ts OFFICIAL_TAGS) and the aliases lived in the server
 * (routes/worlds.ts CANONICAL_TAG_ALIASES), two hand-mirrored copies whose own
 * comment admitted they must not diverge. At ten entries you can mirror by hand.
 * At 277 you cannot, and a divergence forks a tag in storage.
 *
 * WHY MERGING MATTERS MORE THAN TRANSLATING. On 2026-09-02 the published
 * catalogue carried 恋爱 (181 cards), Romance (25) and romance (14) as three
 * separate filters for one idea, and 74 such groups in total, splitting 513 card
 * appearances across duplicate chips. Localising the labels without merging
 * first would have put three chips reading "Romance" side by side.
 *
 * INVARIANTS, checked by tags.test.ts:
 *  - no alias may equal another entry's canonical;
 *  - no two entries may render the same label in any locale — that is exactly
 *    the duplicate-chip bug, seen from the other end;
 *  - the official subset must match OFFICIAL_WORLD_TAGS.
 *
 * A tag outside this table displays as typed, which is the pre-existing
 * behaviour and never a regression. Entries were added for every tag on 3+
 * published cards (90.6% of all tag usage); the long tail stays free-form.
 */
export type TagLocale = "zh" | "zh-Hant" | "en" | "ja" | "es";

export interface TagEntry {
  /** Stored value. An id, not a claim about which language owns the idea —
   *  English-origin concepts (NSFW, Slowburn, kpop) keep their English form. */
  canonical: string;
  labels: Record<TagLocale, string>;
  /** Spellings that fold into this entry on write: other languages' labels,
   *  case variants, and script variants (恋爱/戀愛). */
  aliases?: string[];
  /** One of the curated tags shown as a fixed chip in every locale. */
  official?: true;
}

export const TAG_VOCABULARY: readonly TagEntry[] = [
  // ── official: fixed chips, shown in every locale ──
  { canonical: "角色卡", labels: { zh: "角色卡", "zh-Hant": "角色卡", en: "Character", ja: "キャラクター", es: "Personaje" }, aliases: ["Character Card", "character", "character card", "キャラクター", "personaje"], official: true },
  { canonical: "世界卡", labels: { zh: "世界卡", "zh-Hant": "世界卡", en: "World", ja: "世界観", es: "Mundo" }, aliases: ["world card", "World Card", "world", "世界観", "mundo"], official: true },
  { canonical: "同人", labels: { zh: "同人", "zh-Hant": "同人", en: "Fandom", ja: "二次創作", es: "Fandom" }, aliases: ["fandom", "fanwork", "fan work", "doujin", "二次創作"], official: true },
  { canonical: "原创", labels: { zh: "原创", "zh-Hant": "原創", en: "Original", ja: "オリジナル", es: "Original" }, aliases: ["Original", "original"], official: true },
  { canonical: "模拟器", labels: { zh: "模拟器", "zh-Hant": "模擬器", en: "Simulator", ja: "シミュレーター", es: "Simulador" }, aliases: ["simulator", "模擬器", "シミュレーター", "simulador", "模拟", "Simulator"], official: true },
  { canonical: "男性向", labels: { zh: "男性向", "zh-Hant": "男性向", en: "Male-oriented", ja: "男性向け", es: "Para hombres" }, aliases: ["male-oriented", "男性向け", "para hombres"], official: true },
  { canonical: "女性向", labels: { zh: "女性向", "zh-Hant": "女性向", en: "Female-oriented", ja: "女性向け", es: "Para mujeres" }, aliases: ["female-oriented", "女性向け", "para mujeres"], official: true },
  { canonical: "游戏", labels: { zh: "游戏", "zh-Hant": "遊戲", en: "Game", ja: "ゲーム", es: "Juego" }, aliases: ["game", "遊戲", "ゲーム", "juego", "Games"], official: true },
  { canonical: "历史", labels: { zh: "历史", "zh-Hant": "歷史", en: "History", ja: "歴史", es: "Historia" }, aliases: ["history", "歷史", "歴史", "historia"], official: true },
  { canonical: "名著", labels: { zh: "名著", "zh-Hant": "名著", en: "Classic", ja: "名作", es: "Clásico" }, aliases: ["classic", "名作", "clásico"], official: true },
  // ── free-form vocabulary, ordered by how many published cards carry it ──
  { canonical: "恋爱", labels: { zh: "恋爱", "zh-Hant": "戀愛", en: "Romance", ja: "恋愛", es: "Romance" }, aliases: ["Romance", "romance", "戀愛"] },
  { canonical: "动漫", labels: { zh: "动漫", "zh-Hant": "動漫", en: "Anime", ja: "アニメ", es: "Anime" }, aliases: ["anime", "Anime"] },
  { canonical: "Alfa", labels: { zh: "Alfa", "zh-Hant": "Alfa", en: "Alpha", ja: "アルファ", es: "Alfa" }, aliases: ["Alpha"] },
  { canonical: "小说", labels: { zh: "小说", "zh-Hant": "小說", en: "Novel", ja: "小説", es: "Novela" }, aliases: ["novel"] },
  { canonical: "kpop", labels: { zh: "K-pop", "zh-Hant": "K-pop", en: "K-pop", ja: "K-POP", es: "K-pop" }, aliases: ["KPOP"] },
  { canonical: "NSFW", labels: { zh: "NSFW", "zh-Hant": "NSFW", en: "NSFW", ja: "NSFW", es: "NSFW" }, aliases: ["nsfw", "Nsfw"] },
  { canonical: "榨精", labels: { zh: "榨精", "zh-Hant": "榨精", en: "Semen Extraction", ja: "搾精", es: "Extracción de semen" }, aliases: ["搾精"] },
  { canonical: "Omegaverse", labels: { zh: "Omegaverse", "zh-Hant": "Omegaverse", en: "Omegaverse", ja: "オメガバース", es: "Omegaverse" } },
  { canonical: "玄幻", labels: { zh: "玄幻", "zh-Hant": "玄幻", en: "Xianxia Fantasy", ja: "中華ファンタジー", es: "Fantasía xianxia" } },
  { canonical: "Wholesome", labels: { zh: "治愈", "zh-Hant": "治癒", en: "Wholesome", ja: "ほのぼの", es: "Wholesome" }, aliases: ["wholesome", "Cozy", "Confort", "healing"] },
  { canonical: "校园", labels: { zh: "校园", "zh-Hant": "校園", en: "School", ja: "学園", es: "Escolar" }, aliases: ["school", "School"] },
  { canonical: "Drama", labels: { zh: "剧情", "zh-Hant": "劇情", en: "Drama", ja: "ドラマ", es: "Drama" }, aliases: ["drama"] },
  { canonical: "色诱", labels: { zh: "色诱", "zh-Hant": "色誘", en: "Seduction", ja: "誘惑", es: "Seducción" }, aliases: ["诱惑"] },
  { canonical: "抖m", labels: { zh: "抖M", "zh-Hant": "抖M", en: "Masochist", ja: "ドM", es: "Masoquista" }, aliases: ["m向", "M向"] },
  { canonical: "Lobo", labels: { zh: "狼", "zh-Hant": "狼", en: "Wolf", ja: "狼", es: "Lobo" } },
  { canonical: "言情", labels: { zh: "言情", "zh-Hant": "言情", en: "Romance Novel", ja: "ラブストーリー", es: "Novela romántica" }, aliases: ["love story"] },
  { canonical: "Roleplay", labels: { zh: "角色扮演", "zh-Hant": "角色扮演", en: "Roleplay", ja: "ロールプレイ", es: "Roleplay" } },
  { canonical: "搞笑", labels: { zh: "搞笑", "zh-Hant": "搞笑", en: "Comedy", ja: "コメディ", es: "Comedia" }, aliases: ["Comedy", "comedy"] },
  { canonical: "推理", labels: { zh: "推理", "zh-Hant": "推理", en: "Mystery", ja: "ミステリー", es: "Misterio" }, aliases: ["Mystery", "mystery"] },
  { canonical: "悬疑", labels: { zh: "悬疑", "zh-Hant": "懸疑", en: "Suspense", ja: "サスペンス", es: "Suspenso" }, aliases: ["suspense"] },
  { canonical: "canon character RP", labels: { zh: "原作角色扮演", "zh-Hant": "原作角色扮演", en: "Canon Character RP", ja: "原作キャラロールプレイ", es: "RP con personajes canon" } },
  { canonical: "Slowburn", labels: { zh: "慢热", "zh-Hant": "慢熱", en: "Slow Burn", ja: "スローバーン", es: "Desarrollo lento" }, aliases: ["Slow Burn"] },
  { canonical: "Fantasy", labels: { zh: "奇幻", "zh-Hant": "奇幻", en: "Fantasy", ja: "ファンタジー", es: "Fantasía" }, aliases: ["fantasy"] },
  { canonical: "恐怖", labels: { zh: "恐怖", "zh-Hant": "恐怖", en: "Horror", ja: "ホラー", es: "Terror" }, aliases: ["horror", "Terror", "Horror"] },
  { canonical: "魅魔", labels: { zh: "魅魔", "zh-Hant": "魅魔", en: "Succubus", ja: "サキュバス", es: "Súcubo" }, aliases: ["succubus", "Succubus"] },
  { canonical: "Slice of Life", labels: { zh: "日常", "zh-Hant": "日常", en: "Slice of Life", ja: "日常系", es: "Vida Cotidiana" }, aliases: ["slice of life", "日常"] },
  { canonical: "科幻", labels: { zh: "科幻", "zh-Hant": "科幻", en: "Sci-Fi", ja: "SF", es: "Ciencia Ficción" }, aliases: ["sci-fi", "Sci-Fi"] },
  { canonical: "榨死", labels: { zh: "榨死", "zh-Hant": "榨死", en: "Drained Dry", ja: "搾り殺し", es: "Exprimido hasta morir" } },
  { canonical: "Hyperdimension Neptunia", labels: { zh: "超次元海王星", "zh-Hant": "超次元戰記少女兵器（超次元海王星）", en: "Hyperdimension Neptunia", ja: "超次元ゲイム ネプテューヌ", es: "Hyperdimension Neptunia" }, aliases: ["Neptunia"] },
  { canonical: "vanilla", labels: { zh: "无特殊癖好", "zh-Hant": "無特殊癖好", en: "Vanilla", ja: "バニラ", es: "Vainilla" } },
  { canonical: "Action", labels: { zh: "动作", "zh-Hant": "動作", en: "Action", ja: "アクション", es: "Acción" }, aliases: ["action"] },
  { canonical: "RPG", labels: { zh: "RPG", "zh-Hant": "RPG", en: "RPG", ja: "RPG", es: "RPG" }, aliases: ["Rpg"] },
  { canonical: "Adventure", labels: { zh: "冒险", "zh-Hant": "冒險", en: "Adventure", ja: "アドベンチャー", es: "Aventura" }, aliases: ["adventure", "冒险"] },
  { canonical: "Scenario", labels: { zh: "剧情向", "zh-Hant": "劇情向", en: "Scenario", ja: "シナリオ", es: "Escenario" } },
  { canonical: "Female", labels: { zh: "女性角色", "zh-Hant": "女性角色", en: "Female", ja: "女性", es: "Femenino" } },
  { canonical: "Omega", labels: { zh: "Omega", "zh-Hant": "Omega", en: "Omega", ja: "オメガ", es: "Omega" } },
  { canonical: "femdom", labels: { zh: "女性主导", "zh-Hant": "女性主導", en: "Femdom", ja: "女性主導（フェムドム）", es: "Femdom" }, aliases: ["女性主导", "女性支配"] },
  { canonical: "生存", labels: { zh: "生存", "zh-Hant": "生存", en: "Survival", ja: "サバイバル", es: "Supervivencia" }, aliases: ["Survival"] },
  { canonical: "米哈游", labels: { zh: "米哈游", "zh-Hant": "米哈遊", en: "HoYoverse", ja: "ミホヨ", es: "HoYoverse" }, aliases: ["HoYoverse"] },
  { canonical: "男女皆可", labels: { zh: "男女皆可", "zh-Hant": "男女皆可", en: "Any Gender", ja: "男女問わず", es: "Cualquier Género" }, aliases: ["性別不限"] },
  { canonical: "Jefe x Empleado", labels: { zh: "上司×下属", "zh-Hant": "上司×下屬", en: "Boss x Employee", ja: "上司×部下", es: "Jefe x Empleado" } },
  { canonical: "gacha games", labels: { zh: "抽卡游戏", "zh-Hant": "抽卡遊戲", en: "Gacha Games", ja: "ガチャゲーム", es: "Juegos Gacha" }, aliases: ["gacha"] },
  { canonical: "Tsundere", labels: { zh: "傲娇", "zh-Hant": "傲嬌", en: "Tsundere", ja: "ツンデレ", es: "Tsundere" }, aliases: ["tsundere"] },
  { canonical: "Friends to Lovers", labels: { zh: "朋友变恋人", "zh-Hant": "朋友變戀人", en: "Friends to Lovers", ja: "友達から恋人へ", es: "Amigos a Amantes" }, aliases: ["Amigos a amantes"] },
  { canonical: "Genshin Impact", labels: { zh: "原神", "zh-Hant": "原神", en: "Genshin Impact", ja: "原神", es: "Genshin Impact" }, aliases: ["原神", "Genshin"] },
  { canonical: "Strategy", labels: { zh: "策略", "zh-Hant": "策略", en: "Strategy", ja: "ストラテジー", es: "Estrategia" }, aliases: ["策略", "strategy"] },
  { canonical: "master and slave roleplay", labels: { zh: "主仆角色扮演", "zh-Hant": "主僕角色扮演", en: "Master and Slave Roleplay", ja: "主従プレイ", es: "Juego de Amo y Esclavo" } },
  { canonical: "架空历史", labels: { zh: "架空历史", "zh-Hant": "架空歷史", en: "Alternate History", ja: "架空歴史", es: "Historia Alternativa" }, aliases: ["alternate history", "架空歷史"] },
  { canonical: "Original Character", labels: { zh: "原创角色", "zh-Hant": "原創角色", en: "Original Character", ja: "オリジナルキャラクター", es: "Personaje Original" } },
  { canonical: "Thriller", labels: { zh: "惊悚", "zh-Hant": "驚悚", en: "Thriller", ja: "スリラー", es: "Thriller" }, aliases: ["thriller"] },
  { canonical: "Arknights", labels: { zh: "明日方舟", "zh-Hant": "明日方舟", en: "Arknights", ja: "アークナイツ", es: "Arknights" }, aliases: ["明日方舟", "方舟"] },
  { canonical: "纯爱", labels: { zh: "纯爱", "zh-Hant": "純愛", en: "Pure Love", ja: "純愛", es: "Amor Puro" }, aliases: ["純愛"] },
  { canonical: "仙侠", labels: { zh: "仙侠", "zh-Hant": "仙俠", en: "Xianxia", ja: "仙侠", es: "Xianxia" }, aliases: ["xianxia"] },
  { canonical: "Original World", labels: { zh: "原创世界", "zh-Hant": "原創世界", en: "Original World", ja: "オリジナル世界", es: "Mundo original" } },
  { canonical: "Dulzura", labels: { zh: "Dulzura", "zh-Hant": "Dulzura", en: "Dulzura", ja: "Dulzura", es: "Dulzura" } },
  { canonical: "堕落", labels: { zh: "堕落", "zh-Hant": "墮落", en: "Corruption", ja: "堕落", es: "Corrupción" } },
  { canonical: "全屏", labels: { zh: "全屏", "zh-Hant": "全螢幕", en: "Fullscreen", ja: "全画面", es: "Pantalla completa" }, aliases: ["Fullscreen"] },
  { canonical: "Supernatural", labels: { zh: "超自然", "zh-Hant": "超自然", en: "Supernatural", ja: "超常現象", es: "Sobrenatural" }, aliases: ["supernatural"] },
  { canonical: "绝区零", labels: { zh: "绝区零", "zh-Hant": "絕區零", en: "Zenless Zone Zero", ja: "ゼンレスゾーンゼロ", es: "Zenless Zone Zero" }, aliases: ["Zenless Zone Zero", "ZZZ"] },
  { canonical: "Ternura", labels: { zh: "温柔", "zh-Hant": "溫柔", en: "Tenderness", ja: "優しさ", es: "Ternura" }, aliases: ["Suave"] },
  // "multiplayer" used to fold in here, which made one word mean two unrelated
  // things: a cast with several characters, and a game two people play together.
  // The PvZ Online cards were tagged 多人 and advertised "Multiple Characters"
  // for a PvP match. Real multiplayer now has its own entry below.
  { canonical: "多人", labels: { zh: "多人", "zh-Hant": "多人", en: "Multiple Characters", ja: "複数人", es: "Múltiples personajes" }, aliases: ["Multi-Character", "Multi character", "Multiple Characters", "Multiple"] },
  { canonical: "Dark Fantasy", labels: { zh: "黑暗奇幻", "zh-Hant": "黑暗奇幻", en: "Dark Fantasy", ja: "ダークファンタジー", es: "Fantasía Oscura" }, aliases: ["dark fantasy"] },
  { canonical: "Psicología", labels: { zh: "心理", "zh-Hant": "心理", en: "Psychological", ja: "サイコロジカル", es: "Psicología" }, aliases: ["psychological", "Psicológico"] },
  { canonical: "古风", labels: { zh: "古风", "zh-Hant": "古風", en: "Ancient China", ja: "中華風", es: "China antigua" } },
  { canonical: "shounen", labels: { zh: "少年向", "zh-Hant": "少年向", en: "Shounen", ja: "少年", es: "Shōnen" } },
  { canonical: "power dynamics", labels: { zh: "权力关系", "zh-Hant": "權力關係", en: "Power Dynamics", ja: "力関係", es: "Dinámica de poder" } },
  { canonical: "Game Characters", labels: { zh: "游戏角色", "zh-Hant": "遊戲角色", en: "Game Characters", ja: "ゲームキャラクター", es: "Personajes de videojuegos" } },
  { canonical: "switch", labels: { zh: "攻受皆可", "zh-Hant": "攻受皆可", en: "Switch", ja: "スイッチ", es: "Switch" } },
  { canonical: "左右不限", labels: { zh: "左右不限", "zh-Hant": "左右不限", en: "Any Position", ja: "ポジション不問", es: "Posición flexible" } },
  { canonical: "Idol", labels: { zh: "偶像", "zh-Hant": "偶像", en: "Idol", ja: "アイドル", es: "Ídolo" } },
  { canonical: "火影忍者", labels: { zh: "火影忍者", "zh-Hant": "火影忍者", en: "Naruto", ja: "NARUTO", es: "Naruto" }, aliases: ["Naruto"] },
  { canonical: "Wuthering Waves", labels: { zh: "鸣潮", "zh-Hant": "鳴潮", en: "Wuthering Waves", ja: "鳴潮", es: "Wuthering Waves" }, aliases: ["鸣潮"] },
  { canonical: "Dominante", labels: { zh: "支配型", "zh-Hant": "支配型", en: "Dominant", ja: "支配的", es: "Dominante" } },
  { canonical: "Smut", labels: { zh: "Smut", "zh-Hant": "Smut", en: "Smut", ja: "スマット", es: "Smut" } },
  { canonical: "Apasionado", labels: { zh: "热情", "zh-Hant": "熱情", en: "Passionate", ja: "情熱的", es: "Apasionado" } },
  { canonical: "Male", labels: { zh: "男性", "zh-Hant": "男性", en: "Male", ja: "男性", es: "Masculino" } },
  { canonical: "乙游", labels: { zh: "乙女游戏", "zh-Hant": "乙女遊戲", en: "Otome Game", ja: "乙女ゲーム", es: "Otome" } },
  { canonical: "Enemies to lovers", labels: { zh: "欢喜冤家", "zh-Hant": "歡喜冤家", en: "Enemies to Lovers", ja: "喧嘩するほど恋をする", es: "De enemigos a amantes" } },
  { canonical: "Dulce", labels: { zh: "甜蜜", "zh-Hant": "甜蜜", en: "Sweet", ja: "甘々", es: "Dulce" } },
  { canonical: "巨乳", labels: { zh: "巨乳", "zh-Hant": "巨乳", en: "Huge Breasts", ja: "巨乳", es: "Pechos Grandes" } },
  { canonical: "足控", labels: { zh: "足控", "zh-Hant": "足控", en: "Foot Fetish", ja: "足フェチ", es: "Fetiche de Pies" } },
  { canonical: "Worldbuilding", labels: { zh: "世界观构建", "zh-Hant": "世界觀構建", en: "Worldbuilding", ja: "世界観構築", es: "Construcción de Mundo" } },
  { canonical: "Hell's Paradise", labels: { zh: "地狱乐园", "zh-Hant": "地獄樂園", en: "Hell's Paradise", ja: "地獄楽", es: "Hell's Paradise" }, aliases: ["Jigokuraku"] },
  { canonical: "music", labels: { zh: "音乐", "zh-Hant": "音樂", en: "Music", ja: "音楽", es: "Música" }, aliases: ["Música"] },
  { canonical: "messenger", labels: { zh: "聊天软件", "zh-Hant": "聊天軟體", en: "Messenger", ja: "メッセンジャー", es: "Mensajería" }, aliases: ["Messenger"] },
  { canonical: "Steins;Gate", labels: { zh: "命运石之门", "zh-Hant": "命運石之門", en: "Steins;Gate", ja: "シュタインズ・ゲート", es: "Steins;Gate" }, aliases: ["命运石之门"] },
  { canonical: "温暖", labels: { zh: "温暖", "zh-Hant": "溫暖", en: "Warmth", ja: "温かさ", es: "Calidez" }, aliases: ["Calidez"] },
  { canonical: "Honkai: Star Rail", labels: { zh: "崩坏：星穹铁道", "zh-Hant": "崩壞：星穹鐵道", en: "Honkai: Star Rail", ja: "崩壊：スターレイル", es: "Honkai: Star Rail" }, aliases: ["星穹铁道"] },
  { canonical: "色情", labels: { zh: "色情", "zh-Hant": "色情", en: "Explicit", ja: "エロ", es: "Explícito" } },
  { canonical: "Companion", labels: { zh: "伴侣", "zh-Hant": "伴侶", en: "Companion", ja: "コンパニオン", es: "Compañero" } },
  { canonical: "Visual Novel", labels: { zh: "视觉小说", "zh-Hant": "視覺小說", en: "Visual Novel", ja: "ビジュアルノベル", es: "Novela Visual" }, aliases: ["视觉小说"] },
  { canonical: "mecha", labels: { zh: "机甲", "zh-Hant": "機甲", en: "Mecha", ja: "メカ", es: "Mecha" }, aliases: ["Mecha"] },
  { canonical: "斗罗大陆", labels: { zh: "斗罗大陆", "zh-Hant": "斗羅大陸", en: "Soul Land", ja: "斗羅大陸", es: "Soul Land" }, aliases: ["Soul Land", "Douluo Dalu"] },
  { canonical: "Parody", labels: { zh: "恶搞", "zh-Hant": "惡搞", en: "Parody", ja: "パロディ", es: "Parodia" }, aliases: ["parody"] },
  { canonical: "BDSM", labels: { zh: "BDSM", "zh-Hant": "BDSM", en: "BDSM", ja: "BDSM", es: "BDSM" }, aliases: ["bdsm"] },
  { canonical: "Sandbox", labels: { zh: "沙盒", "zh-Hant": "沙盒", en: "Sandbox", ja: "サンドボックス", es: "Sandbox" } },
  { canonical: "anypov", labels: { zh: "任意视角", "zh-Hant": "任意視角", en: "AnyPOV", ja: "AnyPOV", es: "AnyPOV" } },
  { canonical: "碧蓝档案", labels: { zh: "碧蓝档案", "zh-Hant": "碧藍檔案", en: "Blue Archive", ja: "ブルーアーカイブ", es: "Blue Archive" } },
  { canonical: "petplay", labels: { zh: "宠物调教", "zh-Hant": "寵物調教", en: "Petplay", ja: "ペットプレイ", es: "Petplay" } },
  { canonical: "等级吸取", labels: { zh: "等级吸取", "zh-Hant": "等級吸取", en: "Level Drain", ja: "レベル吸収", es: "Absorción de Nivel" } },
  { canonical: "Noir", labels: { zh: "黑色电影", "zh-Hant": "黑色電影", en: "Noir", ja: "ノワール", es: "Noir" } },
  { canonical: "三国", labels: { zh: "三国", "zh-Hant": "三國", en: "Three Kingdoms", ja: "三国志", es: "Tres Reinos" } },
  { canonical: "Sadistic", labels: { zh: "抖S", "zh-Hant": "抖S", en: "Sadistic", ja: "ドS", es: "Sádico" }, aliases: ["sadistic"] },
  { canonical: "机器人", labels: { zh: "机器人", "zh-Hant": "機器人", en: "Android", ja: "アンドロイド", es: "Androide" }, aliases: ["Android"] },
  { canonical: "Chainsaw Man", labels: { zh: "电锯人", "zh-Hant": "鏈鋸人", en: "Chainsaw Man", ja: "チェンソーマン", es: "Chainsaw Man" }, aliases: ["电锯人"] },
  { canonical: "My Hero Academia", labels: { zh: "我的英雄学院", "zh-Hant": "我的英雄學院", en: "My Hero Academia", ja: "僕のヒーローアカデミア", es: "My Hero Academia" }, aliases: ["My hero academia", "My hero academia rpg", "My hero academia world"] },
  { canonical: "furry", labels: { zh: "兽人", "zh-Hant": "獸人", en: "Furry", ja: "ケモノ", es: "Furry" } },
  { canonical: "战斗", labels: { zh: "战斗", "zh-Hant": "戰鬥", en: "Combat", ja: "バトル", es: "Combate" } },
  { canonical: "角色聊天", labels: { zh: "角色聊天", "zh-Hant": "角色聊天", en: "Character Chat", ja: "キャラチャット", es: "Chat de personajes" } },
  { canonical: "皇宫", labels: { zh: "皇宫", "zh-Hant": "皇宮", en: "Royal Palace", ja: "王宮", es: "Palacio real" } },
  { canonical: "TCG", labels: { zh: "TCG", "zh-Hant": "TCG", en: "TCG", ja: "TCG", es: "TCG" } },
  { canonical: "submissive", labels: { zh: "顺从", "zh-Hant": "順從", en: "Submissive", ja: "受け身", es: "Sumiso" } },
  { canonical: "全性向", labels: { zh: "全性向", "zh-Hant": "全性向", en: "Any Orientation", ja: "全指向", es: "Todas las orientaciones" } },
  { canonical: "后妈", labels: { zh: "后妈", "zh-Hant": "後媽", en: "Stepmother", ja: "義母", es: "Madrastra" } },
  { canonical: "百合", labels: { zh: "百合", "zh-Hant": "百合", en: "Yuri", ja: "百合", es: "Yuri" } },
  { canonical: "giantess", labels: { zh: "巨大娘", "zh-Hant": "巨大娘", en: "Giantess", ja: "ジャイアンテス", es: "Giganta" } },
  { canonical: "DND", labels: { zh: "DND", "zh-Hant": "DND", en: "D&D", ja: "D&D", es: "D&D" } },
  { canonical: "葬送的芙莉莲", labels: { zh: "葬送的芙莉莲", "zh-Hant": "葬送的芙莉蓮", en: "Frieren: Beyond Journey's End", ja: "葬送のフリーレン", es: "Frieren" }, aliases: ["Frieren"] },
  { canonical: "碧蓝航线", labels: { zh: "碧蓝航线", "zh-Hant": "碧藍航線", en: "Azur Lane", ja: "アズールレーン", es: "Azur Lane" }, aliases: ["Azur Lane"] },
  { canonical: "Detective", labels: { zh: "侦探", "zh-Hant": "偵探", en: "Detective", ja: "探偵", es: "Detective" }, aliases: ["detective"] },
  { canonical: "Cyberpunk", labels: { zh: "赛博朋克", "zh-Hant": "賽博龐克", en: "Cyberpunk", ja: "サイバーパンク", es: "Ciberpunk" }, aliases: ["cyberpunk"] },
  { canonical: "Representante x Idol", labels: { zh: "经纪人×偶像", "zh-Hant": "經紀人×偶像", en: "Manager x Idol", ja: "マネージャー×アイドル", es: "Representante x Idol" } },
  { canonical: "Oshi no Ko", labels: { zh: "我推的孩子", "zh-Hant": "【我推的孩子】", en: "Oshi no Ko", ja: "推しの子", es: "Oshi no Ko" } },
  { canonical: "Heredero a CEO", labels: { zh: "CEO继承人", "zh-Hant": "CEO繼承人", en: "CEO Heir", ja: "CEO後継者", es: "Heredero a CEO" } },
  { canonical: "SNS Simulator", labels: { zh: "社交网络模拟器", "zh-Hant": "社群網路模擬器", en: "SNS Simulator", ja: "SNSシミュレーター", es: "Simulador de SNS" } },
  { canonical: "童颜巨乳", labels: { zh: "童颜巨乳", "zh-Hant": "童顏巨乳", en: "Loli Face Big Tits", ja: "ロリ顔巨乳", es: "Cara infantil, pechos grandes" } },
  { canonical: "开盖即食", labels: { zh: "开盖即食", "zh-Hant": "開蓋即食", en: "Ready to Play", ja: "すぐ遊べる", es: "Listo para jugar" } },
  { canonical: "绝世唐门", labels: { zh: "绝世唐门", "zh-Hant": "絕世唐門", en: "Jueshi Tangmen", ja: "絶世唐門", es: "Jueshi Tangmen" } },
  { canonical: "Gintama", labels: { zh: "银魂", "zh-Hant": "銀魂", en: "Gintama", ja: "銀魂", es: "Gintama" } },
  { canonical: "后宫", labels: { zh: "后宫", "zh-Hant": "後宮", en: "Harem", ja: "ハーレム", es: "Harén" } },
  { canonical: "vore", labels: { zh: "吞食", "zh-Hant": "吞食", en: "Vore", ja: "丸呑み", es: "Vore" } },
  { canonical: "改造", labels: { zh: "改造", "zh-Hant": "改造", en: "Modification", ja: "改造", es: "Modificación" } },
  { canonical: "Roguelite", labels: { zh: "Roguelite", "zh-Hant": "Roguelite", en: "Roguelite", ja: "ローグライト", es: "Roguelite" } },
  { canonical: "科幻奇幻", labels: { zh: "科幻奇幻", "zh-Hant": "科幻奇幻", en: "Sci-Fi & Fantasy", ja: "SF・ファンタジー", es: "Ciencia ficción y fantasía" } },
  { canonical: "都市", labels: { zh: "都市", "zh-Hant": "都市", en: "Urban", ja: "都市", es: "Urbano" } },
  { canonical: "母性", labels: { zh: "母性", "zh-Hant": "母性", en: "Motherly", ja: "母性", es: "Maternal" } },
  { canonical: "全息网游", labels: { zh: "全息网游", "zh-Hant": "全息網遊", en: "Full-Dive VR Game", ja: "フルダイブVR", es: "Juego VR inmersivo" } },
  { canonical: "综艺", labels: { zh: "综艺", "zh-Hant": "綜藝", en: "Variety Show", ja: "バラエティ", es: "Programa de variedades" } },
  { canonical: "伪娘", labels: { zh: "伪娘", "zh-Hant": "偽娘", en: "Femboy", ja: "女装", es: "Femboy" } },
  { canonical: "修仙", labels: { zh: "修仙", "zh-Hant": "修仙", en: "Cultivation", ja: "仙侠修真", es: "Cultivo inmortal" } },
  { canonical: "怪物收集", labels: { zh: "怪物收集", "zh-Hant": "怪物收集", en: "Monster Collecting", ja: "モンスター収集", es: "Colección de monstruos" } },
  { canonical: "生命力榨取", labels: { zh: "生命力榨取", "zh-Hant": "生命力榨取", en: "Life Drain", ja: "生命力吸収", es: "Drenaje de vida" } },
  { canonical: "足交", labels: { zh: "足交", "zh-Hant": "足交", en: "Footjob", ja: "足コキ", es: "Footjob" } },
  { canonical: "Amigos con derecho", labels: { zh: "炮友", "zh-Hant": "砲友", en: "Friends with Benefits", ja: "セフレ", es: "Amigos con derechos" } },
  { canonical: "Storybook", labels: { zh: "童话绘本", "zh-Hant": "童話繪本", en: "Storybook", ja: "絵本風", es: "Cuento ilustrado" } },
  { canonical: "青梅竹马", labels: { zh: "青梅竹马", "zh-Hant": "青梅竹馬", en: "Childhood Friends", ja: "幼馴染", es: "Amigos de la infancia" } },
  { canonical: "妖怪", labels: { zh: "妖怪", "zh-Hant": "妖怪", en: "Youkai", ja: "妖怪", es: "Yōkai" } },
  { canonical: "体香", labels: { zh: "体香", "zh-Hant": "體香", en: "Body Scent", ja: "体臭フェチ", es: "Aroma corporal" } },
  { canonical: "下流", labels: { zh: "下流", "zh-Hant": "下流", en: "Lewd", ja: "スケベ", es: "Lascivo" } },
  { canonical: "Comic", labels: { zh: "漫画", "zh-Hant": "漫畫", en: "Comic", ja: "コミック", es: "Cómic" } },
  { canonical: "神社", labels: { zh: "神社", "zh-Hant": "神社", en: "Shrine", ja: "神社", es: "Santuario sintoísta" } },
  { canonical: "位面战争", labels: { zh: "位面战争", "zh-Hant": "位面戰爭", en: "Planar War", ja: "次元戦争", es: "Guerra entre planos" } },
  { canonical: "架空王朝", labels: { zh: "架空王朝", "zh-Hant": "架空王朝", en: "Fictional Dynasty", ja: "架空王朝", es: "Dinastía ficticia" } },
  { canonical: "魔法少女", labels: { zh: "魔法少女", "zh-Hant": "魔法少女", en: "Magical Girl", ja: "魔法少女", es: "Chica mágica" } },
  { canonical: "Amor rudo", labels: { zh: "粗暴之爱", "zh-Hant": "粗暴之愛", en: "Rough Love", ja: "乱暴な愛", es: "Amor rudo" } },
  { canonical: "追妻", labels: { zh: "追妻", "zh-Hant": "追妻", en: "Chasing the Wife", ja: "妻の追跡", es: "Recuperar a la esposa" } },
  { canonical: "Grand Line", labels: { zh: "伟大航路", "zh-Hant": "偉大航路", en: "Grand Line", ja: "グランドライン", es: "Grand Line" } },
  { canonical: "Crecimiento personal", labels: { zh: "个人成长", "zh-Hant": "個人成長", en: "Personal Growth", ja: "自己成長", es: "Crecimiento personal" } },
  { canonical: "Bankai", labels: { zh: "卍解", "zh-Hant": "卍解", en: "Bankai", ja: "卍解", es: "Bankai" } },
  { canonical: "少女", labels: { zh: "少女", "zh-Hant": "少女", en: "Girl", ja: "少女", es: "Chica joven" } },
  { canonical: "朝廷", labels: { zh: "朝廷", "zh-Hant": "朝廷", en: "Imperial Court", ja: "朝廷", es: "Corte imperial" } },
  { canonical: "Universidad", labels: { zh: "大学", "zh-Hant": "大學", en: "University", ja: "大学", es: "Universidad" } },
  { canonical: "养成", labels: { zh: "养成", "zh-Hant": "養成", en: "Character Development", ja: "育成", es: "Desarrollo de personaje" }, aliases: ["養成"] },
  { canonical: "Gato", labels: { zh: "猫", "zh-Hant": "貓", en: "Cat", ja: "猫", es: "Gato" } },
  { canonical: "Soul Reaper", labels: { zh: "死神", "zh-Hant": "死神", en: "Soul Reaper", ja: "死神", es: "Segador de almas" } },
  { canonical: "BG/BL", labels: { zh: "BG/BL", "zh-Hant": "BG/BL", en: "BG/BL", ja: "BG/BL", es: "BG/BL" } },
  { canonical: "关押", labels: { zh: "关押", "zh-Hant": "關押", en: "Imprisonment", ja: "監禁", es: "Encierro" } },
  { canonical: "催眠", labels: { zh: "催眠", "zh-Hant": "催眠", en: "Hypnosis", ja: "催眠", es: "Hipnosis" } },
  { canonical: "乳交", labels: { zh: "乳交", "zh-Hant": "乳交", en: "Paizuri", ja: "パイズリ", es: "Sexo con pechos" } },
  { canonical: "Destino", labels: { zh: "命运", "zh-Hant": "命運", en: "Destiny", ja: "運命", es: "Destino" } },
  { canonical: "网黄", labels: { zh: "网黄", "zh-Hant": "網黃", en: "Internet Porn Star", ja: "ネット配信者", es: "Creador de contenido adulto" } },
  { canonical: "未来", labels: { zh: "未来", "zh-Hant": "未來", en: "Future", ja: "未来", es: "Futuro" } },
  { canonical: "Zorro", labels: { zh: "狐", "zh-Hant": "狐", en: "Fox", ja: "狐", es: "Zorro" } },
  { canonical: "无限流", labels: { zh: "无限流", "zh-Hant": "無限流", en: "Infinite Loop", ja: "無限ループ", es: "Bucle infinito" } },
  { canonical: "Alchemy", labels: { zh: "炼金术", "zh-Hant": "煉金術", en: "Alchemy", ja: "錬金術", es: "Alquimia" } },
  { canonical: "逃生", labels: { zh: "逃生", "zh-Hant": "逃生", en: "Escape", ja: "脱出", es: "Escape" } },
  { canonical: "Kuro Games", labels: { zh: "库洛游戏", "zh-Hant": "庫洛遊戲", en: "Kuro Games", ja: "クログames", es: "Kuro Games" } },
  { canonical: "Fate", labels: { zh: "Fate", "zh-Hant": "Fate", en: "Fate", ja: "Fate", es: "Fate" } },
  { canonical: "无表情", labels: { zh: "无表情", "zh-Hant": "無表情", en: "Expressionless", ja: "無表情", es: "Sin expresión" } },
  { canonical: "Alfa x Omega", labels: { zh: "Alpha x Omega", "zh-Hant": "Alpha x Omega", en: "Alpha x Omega", ja: "アルファ×オメガ", es: "Alfa x Omega" } },
  { canonical: "监狱", labels: { zh: "监狱", "zh-Hant": "監獄", en: "Prison", ja: "監獄", es: "Prisión" } },
  { canonical: "反抗", labels: { zh: "反抗", "zh-Hant": "反抗", en: "Rebellion", ja: "反抗", es: "Rebelión" } },
  { canonical: "净化", labels: { zh: "净化", "zh-Hant": "淨化", en: "Purification", ja: "浄化", es: "Purificación" } },
  { canonical: "高自由", labels: { zh: "高自由", "zh-Hant": "高自由", en: "High Freedom", ja: "ハイフリーダム", es: "Alta libertad" } },
  { canonical: "Tension", labels: { zh: "张力", "zh-Hant": "張力", en: "Tension", ja: "緊張感", es: "Tensión" } },
  { canonical: "Traumas", labels: { zh: "创伤", "zh-Hant": "創傷", en: "Trauma", ja: "トラウマ", es: "Traumas" } },
  { canonical: "下克上", labels: { zh: "下克上", "zh-Hant": "下剋上", en: "underdog rising to power", ja: "下剋上", es: "ascenso del subordinado" } },
  { canonical: "CEO", labels: { zh: "CEO", "zh-Hant": "CEO", en: "CEO", ja: "CEO", es: "CEO" } },
  { canonical: "Fullmetal Alchemist", labels: { zh: "钢之炼金术师", "zh-Hant": "鋼之鍊金術師", en: "Fullmetal Alchemist", ja: "鋼の錬金術師", es: "Fullmetal Alchemist" } },
  { canonical: "PRTS", labels: { zh: "PRTS", "zh-Hant": "PRTS", en: "PRTS", ja: "PRTS", es: "PRTS" } },
  { canonical: "向导", labels: { zh: "向导", "zh-Hant": "嚮導", en: "guide", ja: "ガイド", es: "guía" } },
  { canonical: "Acción y misterio", labels: { zh: "动作与悬疑", "zh-Hant": "動作與懸疑", en: "action & mystery", ja: "アクション・ミステリー", es: "Acción y misterio" } },
  { canonical: "Intensidad", labels: { zh: "高强度", "zh-Hant": "高強度", en: "intensity", ja: "激しい展開", es: "Intensidad" } },
  { canonical: "Matrimonio arreglado", labels: { zh: "包办婚姻", "zh-Hant": "包辦婚姻", en: "arranged marriage", ja: "政略結婚", es: "Matrimonio arreglado" } },
  { canonical: "ai chat", labels: { zh: "AI聊天", "zh-Hant": "AI聊天", en: "AI chat", ja: "AIチャット", es: "chat con IA" } },
  { canonical: "Oficina", labels: { zh: "办公室", "zh-Hant": "辦公室", en: "office", ja: "オフィス", es: "Oficina" } },
  { canonical: "流浪", labels: { zh: "流浪", "zh-Hant": "流浪", en: "drifting", ja: "流浪", es: "vagabundeo" } },
  { canonical: "Universitario", labels: { zh: "大学生", "zh-Hant": "大學生", en: "college student", ja: "大学生", es: "Universitario" } },
  { canonical: "支配", labels: { zh: "支配", "zh-Hant": "支配", en: "domination", ja: "支配", es: "dominación" } },
  { canonical: "丰满", labels: { zh: "丰满", "zh-Hant": "豐滿", en: "voluptuous", ja: "豊満", es: "voluptuosa" } },
  { canonical: "不洁", labels: { zh: "不洁", "zh-Hant": "不潔", en: "impure", ja: "不潔", es: "impureza" } },
  { canonical: "Maestro x Pupilo", labels: { zh: "师徒", "zh-Hant": "師徒", en: "mentor x protégé", ja: "師匠×弟子", es: "Maestro x Pupilo" } },
  { canonical: "Servant", labels: { zh: "从者", "zh-Hant": "從者", en: "Servant", ja: "サーヴァント", es: "Servant" } },
  { canonical: "Familia", labels: { zh: "家庭", "zh-Hant": "家庭", en: "family", ja: "家族", es: "Familia" } },
  { canonical: "武林", labels: { zh: "武林", "zh-Hant": "武林", en: "jianghu", ja: "武林", es: "mundo marcial (jianghu)" } },
  { canonical: "魔法少男", labels: { zh: "魔法少男", "zh-Hant": "魔法少男", en: "magical boy", ja: "魔法少年", es: "chico mágico" } },
  { canonical: "巫女", labels: { zh: "巫女", "zh-Hant": "巫女", en: "shrine maiden", ja: "巫女", es: "miko (sacerdotisa sintoísta)" } },
  { canonical: "性冷淡", labels: { zh: "性冷淡", "zh-Hant": "性冷淡", en: "frigid", ja: "sexless / 冷淡", es: "frigidez" } },
  { canonical: "爆乳", labels: { zh: "爆乳", "zh-Hant": "爆乳", en: "Massive Breasts", ja: "爆乳", es: "Pechos enormes" } },
  { canonical: "西幻", labels: { zh: "西幻", "zh-Hant": "西幻", en: "Western Fantasy", ja: "西洋ファンタジー", es: "Fantasía occidental" } },
  { canonical: "Dark", labels: { zh: "黑暗", "zh-Hant": "黑暗", en: "Dark", ja: "ダーク", es: "Oscuro" } },
  { canonical: "Monster Girl", labels: { zh: "魔物娘", "zh-Hant": "魔物娘", en: "Monster Girl", ja: "モンスター娘", es: "Chica monstruo" } },
  { canonical: "寡妇", labels: { zh: "寡妇", "zh-Hant": "寡婦", en: "Widow", ja: "未亡人", es: "Viuda" } },
  { canonical: "One Piece", labels: { zh: "海贼王", "zh-Hant": "航海王", en: "One Piece", ja: "ONE PIECE", es: "One Piece" } },
  { canonical: "榨取", labels: { zh: "榨取", "zh-Hant": "榨取", en: "Milking", ja: "搾り取り", es: "Extracción" } },
  { canonical: "逆ntr", labels: { zh: "逆NTR", "zh-Hant": "逆NTR", en: "Reverse NTR", ja: "逆NTR", es: "NTR inverso" } },
  { canonical: "暴风雪山庄", labels: { zh: "暴风雪山庄", "zh-Hant": "暴風雪山莊", en: "Closed Circle", ja: "クローズドサークル", es: "Círculo cerrado" } },
  { canonical: "Pirate", labels: { zh: "海盗", "zh-Hant": "海盜", en: "Pirate", ja: "海賊", es: "Pirata" } },
  { canonical: "哨向", labels: { zh: "哨向", "zh-Hant": "哨向", en: "Sentinel/Guide", ja: "哨兵/ガイド", es: "Centinela/Guía" } },
  { canonical: "BLEACH", labels: { zh: "BLEACH 死神", "zh-Hant": "BLEACH", en: "BLEACH", ja: "BLEACH", es: "BLEACH" } },
  { canonical: "Holy Grail War", labels: { zh: "圣杯战争", "zh-Hant": "聖杯戰爭", en: "Holy Grail War", ja: "聖杯戦争", es: "Guerra del Santo Grial" } },
  { canonical: "人妻", labels: { zh: "人妻", "zh-Hant": "人妻", en: "Married Woman", ja: "人妻", es: "Mujer casada" }, aliases: ["wife"] },
  { canonical: "Mom", labels: { zh: "妈妈", "zh-Hant": "媽媽", en: "Mom", ja: "ママ", es: "Mamá" }, aliases: ["mom"] },
  { canonical: "JJBA", labels: { zh: "JOJO的奇妙冒险", "zh-Hant": "JOJO的奇妙冒險", en: "JoJo's Bizarre Adventure", ja: "ジョジョの奇妙な冒険", es: "JoJo's Bizarre Adventure" }, aliases: ["Jojo's bizarre adventure"] },
  { canonical: "Waifu", labels: { zh: "Waifu", "zh-Hant": "Waifu", en: "Waifu", ja: "ワイフ", es: "Waifu" }, aliases: ["waifu"] },
  { canonical: "Murder", labels: { zh: "凶杀", "zh-Hant": "兇殺", en: "Murder", ja: "殺人", es: "Asesinato" }, aliases: ["凶杀"] },
  { canonical: "Vampire Survivors", labels: { zh: "吸血鬼幸存者", "zh-Hant": "吸血鬼倖存者", en: "Vampire Survivors", ja: "ヴァンパイアサバイバー", es: "Vampire Survivors" }, aliases: ["吸血鬼幸存者"] },
  { canonical: "Maid", labels: { zh: "女仆", "zh-Hant": "女僕", en: "Maid", ja: "メイド", es: "Sirvienta" }, aliases: ["maid"] },
  { canonical: "少女前线", labels: { zh: "少女前线", "zh-Hant": "少女前線", en: "Girls' Frontline", ja: "ドールズフロントライン", es: "Girls' Frontline" }, aliases: ["Girls' Frontline"] },
  { canonical: "密室", labels: { zh: "密室", "zh-Hant": "密室", en: "Locked Room", ja: "密室", es: "Habitación cerrada" }, aliases: ["Locked Room"] },
  { canonical: "Palworld", labels: { zh: "幻兽帕鲁", "zh-Hant": "幻獸帕魯", en: "Palworld", ja: "パルワールド", es: "Palworld" } },
  { canonical: "AI", labels: { zh: "AI", "zh-Hant": "AI", en: "AI", ja: "AI", es: "IA" } },
  { canonical: "shoujo", labels: { zh: "少女漫画", "zh-Hant": "少女漫畫", en: "Shoujo", ja: "少女漫画", es: "Shoujo" } },
  { canonical: "SFW <-> NSFW", labels: { zh: "SFW <-> NSFW", "zh-Hant": "SFW <-> NSFW", en: "SFW <-> NSFW", ja: "SFW <-> NSFW", es: "SFW <-> NSFW" } },
  { canonical: "Dungeon", labels: { zh: "地下城", "zh-Hant": "地下城", en: "Dungeon", ja: "ダンジョン", es: "Mazmorra" } },
  { canonical: "时间旅行", labels: { zh: "时间旅行", "zh-Hant": "時間旅行", en: "Time Travel", ja: "タイムトラベル", es: "Viaje en el tiempo" } },
  { canonical: "HUNTER×HUNTER", labels: { zh: "全职猎人", "zh-Hant": "獵人", en: "Hunter x Hunter", ja: "HUNTER×HUNTER", es: "Hunter x Hunter" } },
  { canonical: "Dice", labels: { zh: "骰子", "zh-Hant": "骰子", en: "Dice", ja: "ダイス", es: "Dados" } },
  { canonical: "3d", labels: { zh: "3D", "zh-Hant": "3D", en: "3D", ja: "3D", es: "3D" } },
  { canonical: "isekai", labels: { zh: "异世界", "zh-Hant": "異世界", en: "Isekai", ja: "異世界", es: "Isekai" } },
  { canonical: "arcade", labels: { zh: "街机", "zh-Hant": "街機", en: "Arcade", ja: "アーケード", es: "Arcade" } },
  { canonical: "进击的巨人", labels: { zh: "进击的巨人", "zh-Hant": "進擊的巨人", en: "Attack on Titan", ja: "進撃の巨人", es: "Attack on Titan" } },
  { canonical: "手机", labels: { zh: "手机", "zh-Hant": "手機", en: "Mobile Phone", ja: "スマホ", es: "Teléfono móvil" } },
  { canonical: "5E", labels: { zh: "龙与地下城5E", "zh-Hant": "龍與地下城5E", en: "D&D 5E", ja: "D&D 5E", es: "D&D 5E" } },
  { canonical: "军略", labels: { zh: "军略", "zh-Hant": "軍略", en: "Military Strategy", ja: "軍略", es: "Estrategia militar" } },
  { canonical: "English", labels: { zh: "英语", "zh-Hant": "英語", en: "English", ja: "英語", es: "Inglés" } },
  { canonical: "Superhero", labels: { zh: "超级英雄", "zh-Hant": "超級英雄", en: "Superhero", ja: "ヒーロー", es: "Superhéroes" } },
  { canonical: "为美好的世界献上祝福", labels: { zh: "为美好的世界献上祝福", "zh-Hant": "為美好的世界獻上祝福", en: "KonoSuba", ja: "この素晴らしい世界に祝福を!", es: "KonoSuba" } },
  { canonical: "Incest", labels: { zh: "近亲相奸", "zh-Hant": "近親相姦", en: "Incest", ja: "近親相姦", es: "Incesto" } },
  { canonical: "Tom and Jerry", labels: { zh: "猫和老鼠", "zh-Hant": "湯姆與傑利", en: "Tom and Jerry", ja: "トムとジェリー", es: "Tom y Jerry" } },
  { canonical: "谋略", labels: { zh: "谋略", "zh-Hant": "謀略", en: "Scheming", ja: "謀略", es: "Intriga" } },
  { canonical: "Jujutsu Kaisen", labels: { zh: "咒术回战", "zh-Hant": "咒術迴戰", en: "Jujutsu Kaisen", ja: "呪術廻戦", es: "Jujutsu Kaisen" } },
  { canonical: "Villain", labels: { zh: "反派", "zh-Hant": "反派", en: "Villain", ja: "ヴィラン", es: "Villano" } },
  { canonical: "智斗", labels: { zh: "智斗", "zh-Hant": "智鬥", en: "Battle of Wits", ja: "頭脳戦", es: "Duelo de ingenio" } },
  { canonical: "火凤燎原", labels: { zh: "火凤燎原", "zh-Hant": "火鳳燎原", en: "The Ravages of Time", ja: "火鳳燎原", es: "The Ravages of Time" } },
  { canonical: "骗子酒馆", labels: { zh: "骗子酒馆", "zh-Hant": "騙子酒館", en: "Liar's Bar", ja: "ライアーズバー", es: "Liar's Bar" } },
  { canonical: "Banter", labels: { zh: "斗嘴打趣", "zh-Hant": "鬥嘴打趣", en: "Banter", ja: "軽口", es: "Bromas" } },
  { canonical: "pvp", labels: { zh: "PvP", "zh-Hant": "PvP", en: "PvP", ja: "PvP", es: "PvP" } },
  { canonical: "联机", labels: { zh: "联机", "zh-Hant": "連線", en: "Multiplayer", ja: "マルチプレイ", es: "Multijugador" }, aliases: ["multiplayer", "多人联机", "連線", "マルチプレイ", "multijugador", "online multiplayer"] },
  // A card can name the work it is set in. Left free-form, an IP tag written in
  // one language shows that language's characters to every other reader: the
  // Japanese PvZ card carried a chip reading 植物大战僵尸.
  { canonical: "植物大战僵尸", labels: { zh: "植物大战僵尸", "zh-Hant": "植物大戰殭屍", en: "Plants vs. Zombies", ja: "プラント vs. ゾンビ", es: "Plants vs. Zombies" }, aliases: ["plants vs zombies", "plants vs. zombies", "pvz", "植物大戰殭屍", "プラントvsゾンビ"] },
  { canonical: "Crime", labels: { zh: "犯罪", "zh-Hant": "犯罪", en: "Crime", ja: "犯罪", es: "Crimen" } },
  { canonical: "惠惠", labels: { zh: "惠惠", "zh-Hant": "惠惠", en: "Megumin", ja: "めぐみん", es: "Megumin" } },
  { canonical: "Modern", labels: { zh: "现代", "zh-Hant": "現代", en: "Modern", ja: "現代", es: "Moderno" } },
  { canonical: "电影", labels: { zh: "电影", "zh-Hant": "電影", en: "Movie", ja: "映画", es: "Película" }, aliases: ["movie"] },
  { canonical: "Life Sim", labels: { zh: "生活模拟", "zh-Hant": "生活模擬", en: "Life Sim", ja: "ライフシミュレーション", es: "Simulación de vida" }, aliases: ["life sim"] },
  { canonical: "Roommates", labels: { zh: "室友", "zh-Hant": "室友", en: "Roommates", ja: "ルームメイト", es: "Compañeros de cuarto" }, aliases: ["Roomate"] },
  { canonical: "Komi Shouko", labels: { zh: "古见硝子", "zh-Hant": "古見硝子", en: "Komi Shouko", ja: "古見硝子", es: "Komi Shouko" }, aliases: ["Komi Cant Communicate", "Shouko Nishimiya"] },
  { canonical: "dragon", labels: { zh: "龙", "zh-Hant": "龍", en: "Dragon", ja: "ドラゴン", es: "Dragón" }, aliases: ["Dragon", "Dragons"] },
  { canonical: "Evangelion", labels: { zh: "新世纪福音战士", "zh-Hant": "新世紀福音戰士", en: "Neon Genesis Evangelion", ja: "新世紀エヴァンゲリオン", es: "Neon Genesis Evangelion" }, aliases: ["Neon Genesis Evangelion", "EVA"] },
];

const BY_KEY = new Map<string, TagEntry>();
for (const entry of TAG_VOCABULARY) {
  BY_KEY.set(entry.canonical.toLowerCase(), entry);
  for (const alias of entry.aliases ?? []) BY_KEY.set(alias.toLowerCase(), entry);
  for (const label of Object.values(entry.labels)) BY_KEY.set(label.toLowerCase(), entry);
}

/** The vocabulary entry a typed or stored tag belongs to, if any. */
export function findTagEntry(input: string): TagEntry | undefined {
  return BY_KEY.get(String(input).trim().toLowerCase());
}

/** Stored form of a typed tag. Unknown tags store trimmed, as typed. */
export function canonicalizeTag(input: string): string {
  const trimmed = String(input).trim();
  return findTagEntry(trimmed)?.canonical ?? trimmed;
}

/** Display label for a stored tag. Unknown tags display as stored. */
export function tagLabel(value: string, locale: TagLocale): string {
  return findTagEntry(value)?.labels[locale] ?? String(value);
}

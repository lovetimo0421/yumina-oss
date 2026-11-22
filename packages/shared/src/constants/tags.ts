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
export type TagLocale = "zh" | "zh-Hant" | "en" | "ja" | "es" | "ko" | "id" | "ru";

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
  { canonical: "角色卡", labels: { zh: "角色卡", "zh-Hant": "角色卡", en: "Character", ja: "キャラクター", es: "Personaje", ko: "캐릭터", id: "Karakter", ru: "Персонаж" }, aliases: ["Character Card", "character", "character card", "キャラクター", "personaje"], official: true },
  { canonical: "世界卡", labels: { zh: "世界卡", "zh-Hant": "世界卡", en: "World", ja: "世界観", es: "Mundo", ko: "세계관", id: "Dunia", ru: "Мир" }, aliases: ["world card", "World Card", "world", "世界観", "mundo"], official: true },
  { canonical: "同人", labels: { zh: "同人", "zh-Hant": "同人", en: "Fandom", ja: "二次創作", es: "Fandom", ko: "2차 창작", id: "Fandom", ru: "Фандом" }, aliases: ["fandom", "fanwork", "fan work", "doujin", "二次創作"], official: true },
  { canonical: "原创", labels: { zh: "原创", "zh-Hant": "原創", en: "Original", ja: "オリジナル", es: "Original", ko: "오리지널", id: "Orisinal", ru: "Оригинал" }, aliases: ["Original", "original"], official: true },
  { canonical: "模拟器", labels: { zh: "模拟器", "zh-Hant": "模擬器", en: "Simulator", ja: "シミュレーター", es: "Simulador", ko: "시뮬레이터", id: "Simulator", ru: "Симулятор" }, aliases: ["simulator", "模擬器", "シミュレーター", "simulador", "模拟", "Simulator"], official: true },
  { canonical: "男性向", labels: { zh: "男性向", "zh-Hant": "男性向", en: "Male-oriented", ja: "男性向け", es: "Para hombres", ko: "남성향", id: "Untuk Pria", ru: "Для мужчин" }, aliases: ["male-oriented", "男性向け", "para hombres"], official: true },
  { canonical: "女性向", labels: { zh: "女性向", "zh-Hant": "女性向", en: "Female-oriented", ja: "女性向け", es: "Para mujeres", ko: "여성향", id: "Untuk Wanita", ru: "Для женщин" }, aliases: ["female-oriented", "女性向け", "para mujeres"], official: true },
  { canonical: "游戏", labels: { zh: "游戏", "zh-Hant": "遊戲", en: "Game", ja: "ゲーム", es: "Juego", ko: "게임", id: "Game", ru: "Игра" }, aliases: ["game", "遊戲", "ゲーム", "juego", "Games"], official: true },
  { canonical: "历史", labels: { zh: "历史", "zh-Hant": "歷史", en: "History", ja: "歴史", es: "Historia", ko: "역사", id: "Sejarah", ru: "История" }, aliases: ["history", "歷史", "歴史", "historia"], official: true },
  { canonical: "名著", labels: { zh: "名著", "zh-Hant": "名著", en: "Classic", ja: "名作", es: "Clásico", ko: "명작", id: "Klasik", ru: "Классика" }, aliases: ["classic", "名作", "clásico"], official: true },
  // ── free-form vocabulary, ordered by how many published cards carry it ──
  { canonical: "恋爱", labels: { zh: "恋爱", "zh-Hant": "戀愛", en: "Romance", ja: "恋愛", es: "Romance", ko: "연애", id: "Romance", ru: "Романтика" }, aliases: ["Romance", "romance", "戀愛"] },
  { canonical: "动漫", labels: { zh: "动漫", "zh-Hant": "動漫", en: "Anime", ja: "アニメ", es: "Anime", ko: "애니", id: "Anime", ru: "Аниме" }, aliases: ["anime", "Anime"] },
  { canonical: "Alfa", labels: { zh: "Alfa", "zh-Hant": "Alfa", en: "Alpha", ja: "アルファ", es: "Alfa", ko: "알파", id: "Alpha", ru: "Альфа" }, aliases: ["Alpha"] },
  { canonical: "小说", labels: { zh: "小说", "zh-Hant": "小說", en: "Novel", ja: "小説", es: "Novela", ko: "소설", id: "Novel", ru: "Роман" }, aliases: ["novel"] },
  { canonical: "kpop", labels: { zh: "K-pop", "zh-Hant": "K-pop", en: "K-pop", ja: "K-POP", es: "K-pop", ko: "K-pop", id: "K-pop", ru: "K-pop" }, aliases: ["KPOP"] },
  { canonical: "NSFW", labels: { zh: "NSFW", "zh-Hant": "NSFW", en: "NSFW", ja: "NSFW", es: "NSFW", ko: "NSFW", id: "NSFW", ru: "NSFW" }, aliases: ["nsfw", "Nsfw"] },
  { canonical: "榨精", labels: { zh: "榨精", "zh-Hant": "榨精", en: "Semen Extraction", ja: "搾精", es: "Extracción de semen", ko: "착정", id: "Pemerasan Sperma", ru: "Выкачивание семени" }, aliases: ["搾精"] },
  { canonical: "Omegaverse", labels: { zh: "Omegaverse", "zh-Hant": "Omegaverse", en: "Omegaverse", ja: "オメガバース", es: "Omegaverse", ko: "오메가버스", id: "Omegaverse", ru: "Омегаверс" } },
  { canonical: "玄幻", labels: { zh: "玄幻", "zh-Hant": "玄幻", en: "Xianxia Fantasy", ja: "中華ファンタジー", es: "Fantasía xianxia", ko: "중국 판타지", id: "Fantasi Xianxia", ru: "Китайское фэнтези" } },
  { canonical: "Wholesome", labels: { zh: "治愈", "zh-Hant": "治癒", en: "Wholesome", ja: "ほのぼの", es: "Wholesome", ko: "힐링", id: "Wholesome", ru: "Ламповое" }, aliases: ["wholesome", "Cozy", "Confort", "healing"] },
  { canonical: "校园", labels: { zh: "校园", "zh-Hant": "校園", en: "School", ja: "学園", es: "Escolar", ko: "학원", id: "Sekolah", ru: "Школа" }, aliases: ["school", "School"] },
  { canonical: "Drama", labels: { zh: "剧情", "zh-Hant": "劇情", en: "Drama", ja: "ドラマ", es: "Drama", ko: "드라마", id: "Drama", ru: "Драма" }, aliases: ["drama"] },
  { canonical: "色诱", labels: { zh: "色诱", "zh-Hant": "色誘", en: "Seduction", ja: "誘惑", es: "Seducción", ko: "유혹", id: "Rayuan", ru: "Соблазнение" }, aliases: ["诱惑"] },
  { canonical: "抖m", labels: { zh: "抖M", "zh-Hant": "抖M", en: "Masochist", ja: "ドM", es: "Masoquista", ko: "M성향", id: "Masokis", ru: "Мазохист" }, aliases: ["m向", "M向"] },
  { canonical: "Lobo", labels: { zh: "狼", "zh-Hant": "狼", en: "Wolf", ja: "狼", es: "Lobo", ko: "늑대", id: "Serigala", ru: "Волк" } },
  { canonical: "言情", labels: { zh: "言情", "zh-Hant": "言情", en: "Romance Novel", ja: "ラブストーリー", es: "Novela romántica", ko: "로맨스 소설", id: "Novel Romantis", ru: "Любовный роман" }, aliases: ["love story"] },
  { canonical: "Roleplay", labels: { zh: "角色扮演", "zh-Hant": "角色扮演", en: "Roleplay", ja: "ロールプレイ", es: "Roleplay", ko: "롤플레이", id: "Roleplay", ru: "Ролевая игра" } },
  { canonical: "搞笑", labels: { zh: "搞笑", "zh-Hant": "搞笑", en: "Comedy", ja: "コメディ", es: "Comedia", ko: "코미디", id: "Komedi", ru: "Комедия" }, aliases: ["Comedy", "comedy"] },
  { canonical: "推理", labels: { zh: "推理", "zh-Hant": "推理", en: "Mystery", ja: "ミステリー", es: "Misterio", ko: "추리", id: "Misteri", ru: "Детектив" }, aliases: ["Mystery", "mystery"] },
  { canonical: "悬疑", labels: { zh: "悬疑", "zh-Hant": "懸疑", en: "Suspense", ja: "サスペンス", es: "Suspenso", ko: "서스펜스", id: "Suspense", ru: "Саспенс" }, aliases: ["suspense"] },
  { canonical: "canon character RP", labels: { zh: "原作角色扮演", "zh-Hant": "原作角色扮演", en: "Canon Character RP", ja: "原作キャラロールプレイ", es: "RP con personajes canon", ko: "원작 캐릭터 RP", id: "RP Karakter Canon", ru: "РП по канону" } },
  { canonical: "Slowburn", labels: { zh: "慢热", "zh-Hant": "慢熱", en: "Slow Burn", ja: "スローバーン", es: "Desarrollo lento", ko: "슬로우번", id: "Slow Burn", ru: "Слоубёрн" }, aliases: ["Slow Burn"] },
  { canonical: "Fantasy", labels: { zh: "奇幻", "zh-Hant": "奇幻", en: "Fantasy", ja: "ファンタジー", es: "Fantasía", ko: "판타지", id: "Fantasi", ru: "Фэнтези" }, aliases: ["fantasy"] },
  { canonical: "恐怖", labels: { zh: "恐怖", "zh-Hant": "恐怖", en: "Horror", ja: "ホラー", es: "Terror", ko: "공포", id: "Horor", ru: "Ужасы" }, aliases: ["horror", "Terror", "Horror"] },
  { canonical: "魅魔", labels: { zh: "魅魔", "zh-Hant": "魅魔", en: "Succubus", ja: "サキュバス", es: "Súcubo", ko: "서큐버스", id: "Succubus", ru: "Суккуб" }, aliases: ["succubus", "Succubus"] },
  { canonical: "Slice of Life", labels: { zh: "日常", "zh-Hant": "日常", en: "Slice of Life", ja: "日常系", es: "Vida Cotidiana", ko: "일상물", id: "Slice of Life", ru: "Повседневность" }, aliases: ["slice of life", "日常"] },
  { canonical: "科幻", labels: { zh: "科幻", "zh-Hant": "科幻", en: "Sci-Fi", ja: "SF", es: "Ciencia Ficción", ko: "SF", id: "Sci-Fi", ru: "Научная фантастика" }, aliases: ["sci-fi", "Sci-Fi"] },
  { canonical: "榨死", labels: { zh: "榨死", "zh-Hant": "榨死", en: "Drained Dry", ja: "搾り殺し", es: "Exprimido hasta morir", ko: "착정 사망", id: "Dikuras Habis", ru: "Досуха" } },
  { canonical: "Hyperdimension Neptunia", labels: { zh: "超次元海王星", "zh-Hant": "超次元戰記少女兵器（超次元海王星）", en: "Hyperdimension Neptunia", ja: "超次元ゲイム ネプテューヌ", es: "Hyperdimension Neptunia", ko: "초차원 게임 넵튠", id: "Hyperdimension Neptunia", ru: "Hyperdimension Neptunia" }, aliases: ["Neptunia"] },
  { canonical: "vanilla", labels: { zh: "无特殊癖好", "zh-Hant": "無特殊癖好", en: "Vanilla", ja: "バニラ", es: "Vainilla", ko: "바닐라", id: "Vanilla", ru: "Ваниль" } },
  { canonical: "Action", labels: { zh: "动作", "zh-Hant": "動作", en: "Action", ja: "アクション", es: "Acción", ko: "액션", id: "Aksi", ru: "Экшен" }, aliases: ["action"] },
  { canonical: "RPG", labels: { zh: "RPG", "zh-Hant": "RPG", en: "RPG", ja: "RPG", es: "RPG", ko: "RPG", id: "RPG", ru: "RPG" }, aliases: ["Rpg"] },
  { canonical: "Adventure", labels: { zh: "冒险", "zh-Hant": "冒險", en: "Adventure", ja: "アドベンチャー", es: "Aventura", ko: "어드벤처", id: "Petualangan", ru: "Приключения" }, aliases: ["adventure", "冒险"] },
  { canonical: "Scenario", labels: { zh: "剧情向", "zh-Hant": "劇情向", en: "Scenario", ja: "シナリオ", es: "Escenario", ko: "시나리오", id: "Skenario", ru: "Сценарий" } },
  { canonical: "Female", labels: { zh: "女性角色", "zh-Hant": "女性角色", en: "Female", ja: "女性", es: "Femenino", ko: "여성 캐릭터", id: "Perempuan", ru: "Женский персонаж" } },
  { canonical: "Omega", labels: { zh: "Omega", "zh-Hant": "Omega", en: "Omega", ja: "オメガ", es: "Omega", ko: "오메가", id: "Omega", ru: "Омега" } },
  { canonical: "femdom", labels: { zh: "女性主导", "zh-Hant": "女性主導", en: "Femdom", ja: "女性主導（フェムドム）", es: "Femdom", ko: "펨돔", id: "Femdom", ru: "Фемдом" }, aliases: ["女性主导", "女性支配"] },
  { canonical: "生存", labels: { zh: "生存", "zh-Hant": "生存", en: "Survival", ja: "サバイバル", es: "Supervivencia", ko: "서바이벌", id: "Survival", ru: "Выживание" }, aliases: ["Survival"] },
  { canonical: "米哈游", labels: { zh: "米哈游", "zh-Hant": "米哈遊", en: "HoYoverse", ja: "ミホヨ", es: "HoYoverse", ko: "호요버스", id: "HoYoverse", ru: "HoYoverse" }, aliases: ["HoYoverse"] },
  { canonical: "男女皆可", labels: { zh: "男女皆可", "zh-Hant": "男女皆可", en: "Any Gender", ja: "男女問わず", es: "Cualquier Género", ko: "성별 무관", id: "Gender Bebas", ru: "Любой пол" }, aliases: ["性別不限"] },
  { canonical: "Jefe x Empleado", labels: { zh: "上司×下属", "zh-Hant": "上司×下屬", en: "Boss x Employee", ja: "上司×部下", es: "Jefe x Empleado", ko: "상사×부하", id: "Bos x Karyawan", ru: "Босс × подчинённый" } },
  { canonical: "gacha games", labels: { zh: "抽卡游戏", "zh-Hant": "抽卡遊戲", en: "Gacha Games", ja: "ガチャゲーム", es: "Juegos Gacha", ko: "가챠 게임", id: "Game Gacha", ru: "Гача-игры" }, aliases: ["gacha"] },
  { canonical: "Tsundere", labels: { zh: "傲娇", "zh-Hant": "傲嬌", en: "Tsundere", ja: "ツンデレ", es: "Tsundere", ko: "츤데레", id: "Tsundere", ru: "Цундере" }, aliases: ["tsundere"] },
  { canonical: "Friends to Lovers", labels: { zh: "朋友变恋人", "zh-Hant": "朋友變戀人", en: "Friends to Lovers", ja: "友達から恋人へ", es: "Amigos a Amantes", ko: "친구에서 연인으로", id: "Friends to Lovers", ru: "От друзей к возлюбленным" }, aliases: ["Amigos a amantes"] },
  { canonical: "Genshin Impact", labels: { zh: "原神", "zh-Hant": "原神", en: "Genshin Impact", ja: "原神", es: "Genshin Impact", ko: "원신", id: "Genshin Impact", ru: "Genshin Impact" }, aliases: ["原神", "Genshin"] },
  { canonical: "Strategy", labels: { zh: "策略", "zh-Hant": "策略", en: "Strategy", ja: "ストラテジー", es: "Estrategia", ko: "전략", id: "Strategi", ru: "Стратегия" }, aliases: ["策略", "strategy"] },
  { canonical: "master and slave roleplay", labels: { zh: "主仆角色扮演", "zh-Hant": "主僕角色扮演", en: "Master and Slave Roleplay", ja: "主従プレイ", es: "Juego de Amo y Esclavo", ko: "주종 롤플레이", id: "Roleplay Tuan & Budak", ru: "Господин и раб" } },
  { canonical: "架空历史", labels: { zh: "架空历史", "zh-Hant": "架空歷史", en: "Alternate History", ja: "架空歴史", es: "Historia Alternativa", ko: "대체 역사", id: "Sejarah Alternatif", ru: "Альтернативная история" }, aliases: ["alternate history", "架空歷史"] },
  { canonical: "Original Character", labels: { zh: "原创角色", "zh-Hant": "原創角色", en: "Original Character", ja: "オリジナルキャラクター", es: "Personaje Original", ko: "오리지널 캐릭터", id: "OC", ru: "Оригинальный персонаж" } },
  { canonical: "Thriller", labels: { zh: "惊悚", "zh-Hant": "驚悚", en: "Thriller", ja: "スリラー", es: "Thriller", ko: "스릴러", id: "Thriller", ru: "Триллер" }, aliases: ["thriller"] },
  { canonical: "Arknights", labels: { zh: "明日方舟", "zh-Hant": "明日方舟", en: "Arknights", ja: "アークナイツ", es: "Arknights", ko: "명일방주", id: "Arknights", ru: "Arknights" }, aliases: ["明日方舟", "方舟"] },
  { canonical: "纯爱", labels: { zh: "纯爱", "zh-Hant": "純愛", en: "Pure Love", ja: "純愛", es: "Amor Puro", ko: "순애", id: "Cinta Murni", ru: "Чистая любовь" }, aliases: ["純愛"] },
  { canonical: "仙侠", labels: { zh: "仙侠", "zh-Hant": "仙俠", en: "Xianxia", ja: "仙侠", es: "Xianxia", ko: "선협", id: "Xianxia", ru: "Сянься" }, aliases: ["xianxia"] },
  { canonical: "Original World", labels: { zh: "原创世界", "zh-Hant": "原創世界", en: "Original World", ja: "オリジナル世界", es: "Mundo original", ko: "오리지널 세계관", id: "Dunia Orisinal", ru: "Оригинальный мир" } },
  { canonical: "Dulzura", labels: { zh: "Dulzura", "zh-Hant": "Dulzura", en: "Dulzura", ja: "Dulzura", es: "Dulzura", ko: "둘수라", id: "Dulzura", ru: "Dulzura" } },
  { canonical: "堕落", labels: { zh: "堕落", "zh-Hant": "墮落", en: "Corruption", ja: "堕落", es: "Corrupción", ko: "타락", id: "Corruption", ru: "Развращение" } },
  { canonical: "全屏", labels: { zh: "全屏", "zh-Hant": "全螢幕", en: "Fullscreen", ja: "全画面", es: "Pantalla completa", ko: "전체 화면", id: "Layar Penuh", ru: "Полный экран" }, aliases: ["Fullscreen"] },
  { canonical: "Supernatural", labels: { zh: "超自然", "zh-Hant": "超自然", en: "Supernatural", ja: "超常現象", es: "Sobrenatural", ko: "초자연", id: "Supernatural", ru: "Сверхъестественное" }, aliases: ["supernatural"] },
  { canonical: "绝区零", labels: { zh: "绝区零", "zh-Hant": "絕區零", en: "Zenless Zone Zero", ja: "ゼンレスゾーンゼロ", es: "Zenless Zone Zero", ko: "젠레스 존 제로", id: "Zenless Zone Zero", ru: "Zenless Zone Zero" }, aliases: ["Zenless Zone Zero", "ZZZ"] },
  { canonical: "Ternura", labels: { zh: "温柔", "zh-Hant": "溫柔", en: "Tenderness", ja: "優しさ", es: "Ternura", ko: "다정함", id: "Kelembutan", ru: "Нежность" }, aliases: ["Suave"] },
  // "multiplayer" used to fold in here, which made one word mean two unrelated
  // things: a cast with several characters, and a game two people play together.
  // The PvZ Online cards were tagged 多人 and advertised "Multiple Characters"
  // for a PvP match. Real multiplayer now has its own entry below.
  { canonical: "多人", labels: { zh: "多人", "zh-Hant": "多人", en: "Multiple Characters", ja: "複数人", es: "Múltiples personajes", ko: "다인", id: "Banyak Karakter", ru: "Несколько персонажей" }, aliases: ["Multi-Character", "Multi character", "Multiple Characters", "Multiple"] },
  { canonical: "Dark Fantasy", labels: { zh: "黑暗奇幻", "zh-Hant": "黑暗奇幻", en: "Dark Fantasy", ja: "ダークファンタジー", es: "Fantasía Oscura", ko: "다크 판타지", id: "Dark Fantasy", ru: "Тёмное фэнтези" }, aliases: ["dark fantasy"] },
  { canonical: "Psicología", labels: { zh: "心理", "zh-Hant": "心理", en: "Psychological", ja: "サイコロジカル", es: "Psicología", ko: "심리", id: "Psikologis", ru: "Психологическое" }, aliases: ["psychological", "Psicológico"] },
  { canonical: "古风", labels: { zh: "古风", "zh-Hant": "古風", en: "Ancient China", ja: "中華風", es: "China antigua", ko: "고풍", id: "Tiongkok Kuno", ru: "Древний Китай" } },
  { canonical: "shounen", labels: { zh: "少年向", "zh-Hant": "少年向", en: "Shounen", ja: "少年", es: "Shōnen", ko: "소년물", id: "Shounen", ru: "Сёнэн" } },
  { canonical: "power dynamics", labels: { zh: "权力关系", "zh-Hant": "權力關係", en: "Power Dynamics", ja: "力関係", es: "Dinámica de poder", ko: "파워 다이내믹스", id: "Dinamika Kuasa", ru: "Динамика власти" } },
  { canonical: "Game Characters", labels: { zh: "游戏角色", "zh-Hant": "遊戲角色", en: "Game Characters", ja: "ゲームキャラクター", es: "Personajes de videojuegos", ko: "게임 캐릭터", id: "Karakter Game", ru: "Игровые персонажи" } },
  { canonical: "switch", labels: { zh: "攻受皆可", "zh-Hant": "攻受皆可", en: "Switch", ja: "スイッチ", es: "Switch", ko: "리버시블", id: "Switch", ru: "Свитч" } },
  { canonical: "左右不限", labels: { zh: "左右不限", "zh-Hant": "左右不限", en: "Any Position", ja: "ポジション不問", es: "Posición flexible", ko: "공수 무관", id: "Posisi Bebas", ru: "Любая позиция" } },
  { canonical: "Idol", labels: { zh: "偶像", "zh-Hant": "偶像", en: "Idol", ja: "アイドル", es: "Ídolo", ko: "아이돌", id: "Idol", ru: "Айдол" } },
  { canonical: "火影忍者", labels: { zh: "火影忍者", "zh-Hant": "火影忍者", en: "Naruto", ja: "NARUTO", es: "Naruto", ko: "나루토", id: "Naruto", ru: "Наруто" }, aliases: ["Naruto"] },
  { canonical: "Wuthering Waves", labels: { zh: "鸣潮", "zh-Hant": "鳴潮", en: "Wuthering Waves", ja: "鳴潮", es: "Wuthering Waves", ko: "명조", id: "Wuthering Waves", ru: "Wuthering Waves" }, aliases: ["鸣潮"] },
  { canonical: "Dominante", labels: { zh: "支配型", "zh-Hant": "支配型", en: "Dominant", ja: "支配的", es: "Dominante", ko: "지배형", id: "Dominan", ru: "Доминант" } },
  { canonical: "Smut", labels: { zh: "Smut", "zh-Hant": "Smut", en: "Smut", ja: "スマット", es: "Smut", ko: "스멋", id: "Smut", ru: "Смат" } },
  { canonical: "Apasionado", labels: { zh: "热情", "zh-Hant": "熱情", en: "Passionate", ja: "情熱的", es: "Apasionado", ko: "열정적", id: "Penuh Gairah", ru: "Страстный" } },
  { canonical: "Male", labels: { zh: "男性", "zh-Hant": "男性", en: "Male", ja: "男性", es: "Masculino", ko: "남성 캐릭터", id: "Laki-laki", ru: "Мужской персонаж" } },
  { canonical: "乙游", labels: { zh: "乙女游戏", "zh-Hant": "乙女遊戲", en: "Otome Game", ja: "乙女ゲーム", es: "Otome", ko: "오토메 게임", id: "Otome Game", ru: "Отомэ" } },
  { canonical: "Enemies to lovers", labels: { zh: "欢喜冤家", "zh-Hant": "歡喜冤家", en: "Enemies to Lovers", ja: "喧嘩するほど恋をする", es: "De enemigos a amantes", ko: "앙숙에서 연인으로", id: "Enemies to Lovers", ru: "От врагов к возлюбленным" } },
  { canonical: "Dulce", labels: { zh: "甜蜜", "zh-Hant": "甜蜜", en: "Sweet", ja: "甘々", es: "Dulce", ko: "달달", id: "Manis", ru: "Сладкий" } },
  { canonical: "巨乳", labels: { zh: "巨乳", "zh-Hant": "巨乳", en: "Huge Breasts", ja: "巨乳", es: "Pechos Grandes", ko: "거유", id: "Dada Besar", ru: "Большая грудь" } },
  { canonical: "足控", labels: { zh: "足控", "zh-Hant": "足控", en: "Foot Fetish", ja: "足フェチ", es: "Fetiche de Pies", ko: "발 페티시", id: "Foot Fetish", ru: "Фут-фетиш" } },
  { canonical: "Worldbuilding", labels: { zh: "世界观构建", "zh-Hant": "世界觀構建", en: "Worldbuilding", ja: "世界観構築", es: "Construcción de Mundo", ko: "세계관 구축", id: "Worldbuilding", ru: "Построение мира" } },
  { canonical: "Hell's Paradise", labels: { zh: "地狱乐园", "zh-Hant": "地獄樂園", en: "Hell's Paradise", ja: "地獄楽", es: "Hell's Paradise", ko: "지옥락", id: "Hell's Paradise", ru: "Адский рай" }, aliases: ["Jigokuraku"] },
  { canonical: "music", labels: { zh: "音乐", "zh-Hant": "音樂", en: "Music", ja: "音楽", es: "Música", ko: "음악", id: "Musik", ru: "Музыка" }, aliases: ["Música"] },
  { canonical: "messenger", labels: { zh: "聊天软件", "zh-Hant": "聊天軟體", en: "Messenger", ja: "メッセンジャー", es: "Mensajería", ko: "메신저", id: "Messenger", ru: "Мессенджер" }, aliases: ["Messenger"] },
  { canonical: "Steins;Gate", labels: { zh: "命运石之门", "zh-Hant": "命運石之門", en: "Steins;Gate", ja: "シュタインズ・ゲート", es: "Steins;Gate", ko: "슈타인즈 게이트", id: "Steins;Gate", ru: "Врата Штейна" }, aliases: ["命运石之门"] },
  { canonical: "温暖", labels: { zh: "温暖", "zh-Hant": "溫暖", en: "Warmth", ja: "温かさ", es: "Calidez", ko: "따뜻함", id: "Kehangatan", ru: "Теплота" }, aliases: ["Calidez"] },
  { canonical: "Honkai: Star Rail", labels: { zh: "崩坏：星穹铁道", "zh-Hant": "崩壞：星穹鐵道", en: "Honkai: Star Rail", ja: "崩壊：スターレイル", es: "Honkai: Star Rail", ko: "붕괴: 스타레일", id: "Honkai: Star Rail", ru: "Honkai: Star Rail" }, aliases: ["星穹铁道"] },
  { canonical: "色情", labels: { zh: "色情", "zh-Hant": "色情", en: "Explicit", ja: "エロ", es: "Explícito", ko: "야한", id: "Explicit", ru: "Откровенное" } },
  { canonical: "Companion", labels: { zh: "伴侣", "zh-Hant": "伴侶", en: "Companion", ja: "コンパニオン", es: "Compañero", ko: "컴패니언", id: "Pendamping", ru: "Компаньон" } },
  { canonical: "Visual Novel", labels: { zh: "视觉小说", "zh-Hant": "視覺小說", en: "Visual Novel", ja: "ビジュアルノベル", es: "Novela Visual", ko: "비주얼 노벨", id: "Visual Novel", ru: "Визуальная новелла" }, aliases: ["视觉小说"] },
  { canonical: "mecha", labels: { zh: "机甲", "zh-Hant": "機甲", en: "Mecha", ja: "メカ", es: "Mecha", ko: "메카", id: "Mecha", ru: "Меха" }, aliases: ["Mecha"] },
  { canonical: "斗罗大陆", labels: { zh: "斗罗大陆", "zh-Hant": "斗羅大陸", en: "Soul Land", ja: "斗羅大陸", es: "Soul Land", ko: "투라대륙", id: "Soul Land", ru: "Боевой континент" }, aliases: ["Soul Land", "Douluo Dalu"] },
  { canonical: "Parody", labels: { zh: "恶搞", "zh-Hant": "惡搞", en: "Parody", ja: "パロディ", es: "Parodia", ko: "패러디", id: "Parodi", ru: "Пародия" }, aliases: ["parody"] },
  { canonical: "BDSM", labels: { zh: "BDSM", "zh-Hant": "BDSM", en: "BDSM", ja: "BDSM", es: "BDSM", ko: "BDSM", id: "BDSM", ru: "BDSM" }, aliases: ["bdsm"] },
  { canonical: "Sandbox", labels: { zh: "沙盒", "zh-Hant": "沙盒", en: "Sandbox", ja: "サンドボックス", es: "Sandbox", ko: "샌드박스", id: "Sandbox", ru: "Песочница" } },
  { canonical: "anypov", labels: { zh: "任意视角", "zh-Hant": "任意視角", en: "AnyPOV", ja: "AnyPOV", es: "AnyPOV", ko: "AnyPOV", id: "AnyPOV", ru: "AnyPOV" } },
  { canonical: "碧蓝档案", labels: { zh: "碧蓝档案", "zh-Hant": "碧藍檔案", en: "Blue Archive", ja: "ブルーアーカイブ", es: "Blue Archive", ko: "블루 아카이브", id: "Blue Archive", ru: "Blue Archive" } },
  { canonical: "petplay", labels: { zh: "宠物调教", "zh-Hant": "寵物調教", en: "Petplay", ja: "ペットプレイ", es: "Petplay", ko: "펫플레이", id: "Petplay", ru: "Петплей" } },
  { canonical: "等级吸取", labels: { zh: "等级吸取", "zh-Hant": "等級吸取", en: "Level Drain", ja: "レベル吸収", es: "Absorción de Nivel", ko: "레벨 드레인", id: "Level Drain", ru: "Поглощение уровней" } },
  { canonical: "Noir", labels: { zh: "黑色电影", "zh-Hant": "黑色電影", en: "Noir", ja: "ノワール", es: "Noir", ko: "누아르", id: "Noir", ru: "Нуар" } },
  { canonical: "三国", labels: { zh: "三国", "zh-Hant": "三國", en: "Three Kingdoms", ja: "三国志", es: "Tres Reinos", ko: "삼국지", id: "Tiga Kerajaan", ru: "Троецарствие" } },
  { canonical: "Sadistic", labels: { zh: "抖S", "zh-Hant": "抖S", en: "Sadistic", ja: "ドS", es: "Sádico", ko: "S성향", id: "Sadis", ru: "Садист" }, aliases: ["sadistic"] },
  { canonical: "机器人", labels: { zh: "机器人", "zh-Hant": "機器人", en: "Android", ja: "アンドロイド", es: "Androide", ko: "안드로이드", id: "Android", ru: "Андроид" }, aliases: ["Android"] },
  { canonical: "Chainsaw Man", labels: { zh: "电锯人", "zh-Hant": "鏈鋸人", en: "Chainsaw Man", ja: "チェンソーマン", es: "Chainsaw Man", ko: "체인소 맨", id: "Chainsaw Man", ru: "Человек-бензопила" }, aliases: ["电锯人"] },
  { canonical: "My Hero Academia", labels: { zh: "我的英雄学院", "zh-Hant": "我的英雄學院", en: "My Hero Academia", ja: "僕のヒーローアカデミア", es: "My Hero Academia", ko: "나의 히어로 아카데미아", id: "My Hero Academia", ru: "Моя геройская академия" }, aliases: ["My hero academia", "My hero academia rpg", "My hero academia world"] },
  { canonical: "furry", labels: { zh: "兽人", "zh-Hant": "獸人", en: "Furry", ja: "ケモノ", es: "Furry", ko: "수인", id: "Furry", ru: "Фурри" } },
  { canonical: "战斗", labels: { zh: "战斗", "zh-Hant": "戰鬥", en: "Combat", ja: "バトル", es: "Combate", ko: "전투", id: "Pertarungan", ru: "Бои" } },
  { canonical: "角色聊天", labels: { zh: "角色聊天", "zh-Hant": "角色聊天", en: "Character Chat", ja: "キャラチャット", es: "Chat de personajes", ko: "캐릭터 챗", id: "Chat Karakter", ru: "Чат с персонажем" } },
  { canonical: "皇宫", labels: { zh: "皇宫", "zh-Hant": "皇宮", en: "Royal Palace", ja: "王宮", es: "Palacio real", ko: "왕궁", id: "Istana Kerajaan", ru: "Королевский дворец" } },
  { canonical: "TCG", labels: { zh: "TCG", "zh-Hant": "TCG", en: "TCG", ja: "TCG", es: "TCG", ko: "TCG", id: "TCG", ru: "TCG" } },
  { canonical: "submissive", labels: { zh: "顺从", "zh-Hant": "順從", en: "Submissive", ja: "受け身", es: "Sumiso", ko: "복종", id: "Submisif", ru: "Сабмиссив" } },
  { canonical: "全性向", labels: { zh: "全性向", "zh-Hant": "全性向", en: "Any Orientation", ja: "全指向", es: "Todas las orientaciones", ko: "모든 성향", id: "Orientasi Bebas", ru: "Любая ориентация" } },
  { canonical: "后妈", labels: { zh: "后妈", "zh-Hant": "後媽", en: "Stepmother", ja: "義母", es: "Madrastra", ko: "계모", id: "Ibu Tiri", ru: "Мачеха" } },
  { canonical: "百合", labels: { zh: "百合", "zh-Hant": "百合", en: "Yuri", ja: "百合", es: "Yuri", ko: "백합", id: "Yuri", ru: "Юри" } },
  { canonical: "giantess", labels: { zh: "巨大娘", "zh-Hant": "巨大娘", en: "Giantess", ja: "ジャイアンテス", es: "Giganta", ko: "거대화", id: "Giantess", ru: "Гигантесса" } },
  { canonical: "DND", labels: { zh: "DND", "zh-Hant": "DND", en: "D&D", ja: "D&D", es: "D&D", ko: "던전 앤 드래곤", id: "D&D", ru: "D&D" } },
  { canonical: "葬送的芙莉莲", labels: { zh: "葬送的芙莉莲", "zh-Hant": "葬送的芙莉蓮", en: "Frieren: Beyond Journey's End", ja: "葬送のフリーレン", es: "Frieren", ko: "장송의 프리렌", id: "Frieren", ru: "Фрирен" }, aliases: ["Frieren"] },
  { canonical: "碧蓝航线", labels: { zh: "碧蓝航线", "zh-Hant": "碧藍航線", en: "Azur Lane", ja: "アズールレーン", es: "Azur Lane", ko: "벽람항로", id: "Azur Lane", ru: "Azur Lane" }, aliases: ["Azur Lane"] },
  { canonical: "Detective", labels: { zh: "侦探", "zh-Hant": "偵探", en: "Detective", ja: "探偵", es: "Detective", ko: "탐정", id: "Detektif", ru: "Сыщик" }, aliases: ["detective"] },
  { canonical: "Cyberpunk", labels: { zh: "赛博朋克", "zh-Hant": "賽博龐克", en: "Cyberpunk", ja: "サイバーパンク", es: "Ciberpunk", ko: "사이버펑크", id: "Cyberpunk", ru: "Киберпанк" }, aliases: ["cyberpunk"] },
  { canonical: "Representante x Idol", labels: { zh: "经纪人×偶像", "zh-Hant": "經紀人×偶像", en: "Manager x Idol", ja: "マネージャー×アイドル", es: "Representante x Idol", ko: "매니저×아이돌", id: "Manager x Idol", ru: "Менеджер × айдол" } },
  { canonical: "Oshi no Ko", labels: { zh: "我推的孩子", "zh-Hant": "【我推的孩子】", en: "Oshi no Ko", ja: "推しの子", es: "Oshi no Ko", ko: "최애의 아이", id: "Oshi no Ko", ru: "Oshi no Ko" } },
  { canonical: "Heredero a CEO", labels: { zh: "CEO继承人", "zh-Hant": "CEO繼承人", en: "CEO Heir", ja: "CEO後継者", es: "Heredero a CEO", ko: "재벌 후계자", id: "Pewaris CEO", ru: "Наследник корпорации" } },
  { canonical: "SNS Simulator", labels: { zh: "社交网络模拟器", "zh-Hant": "社群網路模擬器", en: "SNS Simulator", ja: "SNSシミュレーター", es: "Simulador de SNS", ko: "SNS 시뮬레이터", id: "Simulator Medsos", ru: "Симулятор соцсетей" } },
  { canonical: "童颜巨乳", labels: { zh: "童颜巨乳", "zh-Hant": "童顏巨乳", en: "Loli Face Big Tits", ja: "ロリ顔巨乳", es: "Cara infantil, pechos grandes", ko: "동안 거유", id: "Wajah Imut Dada Besar", ru: "Бэбифейс, большая грудь" } },
  { canonical: "开盖即食", labels: { zh: "开盖即食", "zh-Hant": "開蓋即食", en: "Ready to Play", ja: "すぐ遊べる", es: "Listo para jugar", ko: "바로 플레이", id: "Siap Main", ru: "Готово к игре" } },
  { canonical: "绝世唐门", labels: { zh: "绝世唐门", "zh-Hant": "絕世唐門", en: "Jueshi Tangmen", ja: "絶世唐門", es: "Jueshi Tangmen", ko: "절세당문", id: "Jueshi Tangmen", ru: "Jueshi Tangmen" } },
  { canonical: "Gintama", labels: { zh: "银魂", "zh-Hant": "銀魂", en: "Gintama", ja: "銀魂", es: "Gintama", ko: "은혼", id: "Gintama", ru: "Гинтама" } },
  { canonical: "后宫", labels: { zh: "后宫", "zh-Hant": "後宮", en: "Harem", ja: "ハーレム", es: "Harén", ko: "하렘", id: "Harem", ru: "Гарем" } },
  { canonical: "vore", labels: { zh: "吞食", "zh-Hant": "吞食", en: "Vore", ja: "丸呑み", es: "Vore", ko: "보어", id: "Vore", ru: "Vore" } },
  { canonical: "改造", labels: { zh: "改造", "zh-Hant": "改造", en: "Modification", ja: "改造", es: "Modificación", ko: "개조", id: "Modifikasi", ru: "Модификации" } },
  { canonical: "Roguelite", labels: { zh: "Roguelite", "zh-Hant": "Roguelite", en: "Roguelite", ja: "ローグライト", es: "Roguelite", ko: "로그라이트", id: "Roguelite", ru: "Roguelite" } },
  { canonical: "科幻奇幻", labels: { zh: "科幻奇幻", "zh-Hant": "科幻奇幻", en: "Sci-Fi & Fantasy", ja: "SF・ファンタジー", es: "Ciencia ficción y fantasía", ko: "SF·판타지", id: "Sci-Fi & Fantasi", ru: "Фантастика и фэнтези" } },
  { canonical: "都市", labels: { zh: "都市", "zh-Hant": "都市", en: "Urban", ja: "都市", es: "Urbano", ko: "도시", id: "Urban", ru: "Городское" } },
  { canonical: "母性", labels: { zh: "母性", "zh-Hant": "母性", en: "Motherly", ja: "母性", es: "Maternal", ko: "모성", id: "Keibuan", ru: "Материнская" } },
  { canonical: "全息网游", labels: { zh: "全息网游", "zh-Hant": "全息網遊", en: "Full-Dive VR Game", ja: "フルダイブVR", es: "Juego VR inmersivo", ko: "풀다이브 VR", id: "Game VR Full-Dive", ru: "Фулл-дайв" } },
  { canonical: "综艺", labels: { zh: "综艺", "zh-Hant": "綜藝", en: "Variety Show", ja: "バラエティ", es: "Programa de variedades", ko: "예능", id: "Variety Show", ru: "Телешоу" } },
  { canonical: "伪娘", labels: { zh: "伪娘", "zh-Hant": "偽娘", en: "Femboy", ja: "女装", es: "Femboy", ko: "여장남자", id: "Femboy", ru: "Фембой" } },
  { canonical: "修仙", labels: { zh: "修仙", "zh-Hant": "修仙", en: "Cultivation", ja: "仙侠修真", es: "Cultivo inmortal", ko: "수선", id: "Kultivasi", ru: "Культивация" } },
  { canonical: "怪物收集", labels: { zh: "怪物收集", "zh-Hant": "怪物收集", en: "Monster Collecting", ja: "モンスター収集", es: "Colección de monstruos", ko: "몬스터 수집", id: "Koleksi Monster", ru: "Коллекция монстров" } },
  { canonical: "生命力榨取", labels: { zh: "生命力榨取", "zh-Hant": "生命力榨取", en: "Life Drain", ja: "生命力吸収", es: "Drenaje de vida", ko: "생명력 흡수", id: "Life Drain", ru: "Высасывание жизни" } },
  { canonical: "足交", labels: { zh: "足交", "zh-Hant": "足交", en: "Footjob", ja: "足コキ", es: "Footjob", ko: "풋잡", id: "Footjob", ru: "Футджоб" } },
  { canonical: "Amigos con derecho", labels: { zh: "炮友", "zh-Hant": "砲友", en: "Friends with Benefits", ja: "セフレ", es: "Amigos con derechos", ko: "섹파", id: "FWB", ru: "Секс по дружбе" } },
  { canonical: "Storybook", labels: { zh: "童话绘本", "zh-Hant": "童話繪本", en: "Storybook", ja: "絵本風", es: "Cuento ilustrado", ko: "동화책", id: "Buku Cerita", ru: "Сказка" } },
  { canonical: "青梅竹马", labels: { zh: "青梅竹马", "zh-Hant": "青梅竹馬", en: "Childhood Friends", ja: "幼馴染", es: "Amigos de la infancia", ko: "소꿉친구", id: "Teman Masa Kecil", ru: "Друзья детства" } },
  { canonical: "妖怪", labels: { zh: "妖怪", "zh-Hant": "妖怪", en: "Youkai", ja: "妖怪", es: "Yōkai", ko: "요괴", id: "Youkai", ru: "Ёкай" } },
  { canonical: "体香", labels: { zh: "体香", "zh-Hant": "體香", en: "Body Scent", ja: "体臭フェチ", es: "Aroma corporal", ko: "체취 페티시", id: "Aroma Tubuh", ru: "Запах тела" } },
  { canonical: "下流", labels: { zh: "下流", "zh-Hant": "下流", en: "Lewd", ja: "スケベ", es: "Lascivo", ko: "음란", id: "Lewd", ru: "Пошлость" } },
  { canonical: "Comic", labels: { zh: "漫画", "zh-Hant": "漫畫", en: "Comic", ja: "コミック", es: "Cómic", ko: "만화", id: "Komik", ru: "Комикс" } },
  { canonical: "神社", labels: { zh: "神社", "zh-Hant": "神社", en: "Shrine", ja: "神社", es: "Santuario sintoísta", ko: "신사", id: "Kuil", ru: "Святилище" } },
  { canonical: "位面战争", labels: { zh: "位面战争", "zh-Hant": "位面戰爭", en: "Planar War", ja: "次元戦争", es: "Guerra entre planos", ko: "차원 전쟁", id: "Perang Antar Dimensi", ru: "Межмировая война" } },
  { canonical: "架空王朝", labels: { zh: "架空王朝", "zh-Hant": "架空王朝", en: "Fictional Dynasty", ja: "架空王朝", es: "Dinastía ficticia", ko: "가상 왕조", id: "Dinasti Fiktif", ru: "Вымышленная династия" } },
  { canonical: "魔法少女", labels: { zh: "魔法少女", "zh-Hant": "魔法少女", en: "Magical Girl", ja: "魔法少女", es: "Chica mágica", ko: "마법소녀", id: "Magical Girl", ru: "Махо-сёдзё" } },
  { canonical: "Amor rudo", labels: { zh: "粗暴之爱", "zh-Hant": "粗暴之愛", en: "Rough Love", ja: "乱暴な愛", es: "Amor rudo", ko: "거친 사랑", id: "Cinta Kasar", ru: "Грубая любовь" } },
  { canonical: "追妻", labels: { zh: "追妻", "zh-Hant": "追妻", en: "Chasing the Wife", ja: "妻の追跡", es: "Recuperar a la esposa", ko: "처 쫓기", id: "Mengejar Istri", ru: "Возвращение жены" } },
  { canonical: "Grand Line", labels: { zh: "伟大航路", "zh-Hant": "偉大航路", en: "Grand Line", ja: "グランドライン", es: "Grand Line", ko: "그랜드 라인", id: "Grand Line", ru: "Гранд Лайн" } },
  { canonical: "Crecimiento personal", labels: { zh: "个人成长", "zh-Hant": "個人成長", en: "Personal Growth", ja: "自己成長", es: "Crecimiento personal", ko: "자기 성장", id: "Pengembangan Diri", ru: "Личностный рост" } },
  { canonical: "Bankai", labels: { zh: "卍解", "zh-Hant": "卍解", en: "Bankai", ja: "卍解", es: "Bankai", ko: "반카이", id: "Bankai", ru: "Банкай" } },
  { canonical: "少女", labels: { zh: "少女", "zh-Hant": "少女", en: "Girl", ja: "少女", es: "Chica joven", ko: "소녀", id: "Gadis", ru: "Девушка" } },
  { canonical: "朝廷", labels: { zh: "朝廷", "zh-Hant": "朝廷", en: "Imperial Court", ja: "朝廷", es: "Corte imperial", ko: "조정", id: "Istana Kekaisaran", ru: "Императорский двор" } },
  { canonical: "Universidad", labels: { zh: "大学", "zh-Hant": "大學", en: "University", ja: "大学", es: "Universidad", ko: "대학", id: "Universitas", ru: "Университет" } },
  { canonical: "养成", labels: { zh: "养成", "zh-Hant": "養成", en: "Character Development", ja: "育成", es: "Desarrollo de personaje", ko: "육성", id: "Pengembangan Karakter", ru: "Развитие персонажа" }, aliases: ["養成"] },
  { canonical: "Gato", labels: { zh: "猫", "zh-Hant": "貓", en: "Cat", ja: "猫", es: "Gato", ko: "고양이", id: "Kucing", ru: "Кот" } },
  { canonical: "Soul Reaper", labels: { zh: "死神", "zh-Hant": "死神", en: "Soul Reaper", ja: "死神", es: "Segador de almas", ko: "사신", id: "Shinigami", ru: "Жнец душ" } },
  { canonical: "BG/BL", labels: { zh: "BG/BL", "zh-Hant": "BG/BL", en: "BG/BL", ja: "BG/BL", es: "BG/BL", ko: "BG/BL", id: "BG/BL", ru: "BG/BL" } },
  { canonical: "关押", labels: { zh: "关押", "zh-Hant": "關押", en: "Imprisonment", ja: "監禁", es: "Encierro", ko: "감금", id: "Kurungan", ru: "Заточение" } },
  { canonical: "催眠", labels: { zh: "催眠", "zh-Hant": "催眠", en: "Hypnosis", ja: "催眠", es: "Hipnosis", ko: "최면", id: "Hipnotis", ru: "Гипноз" } },
  { canonical: "乳交", labels: { zh: "乳交", "zh-Hant": "乳交", en: "Paizuri", ja: "パイズリ", es: "Sexo con pechos", ko: "파이즈리", id: "Paizuri", ru: "Пайзури" } },
  { canonical: "Destino", labels: { zh: "命运", "zh-Hant": "命運", en: "Destiny", ja: "運命", es: "Destino", ko: "운명", id: "Takdir", ru: "Судьба" } },
  { canonical: "网黄", labels: { zh: "网黄", "zh-Hant": "網黃", en: "Internet Porn Star", ja: "ネット配信者", es: "Creador de contenido adulto", ko: "인터넷 방송인", id: "Kreator Dewasa", ru: "Вебкам" } },
  { canonical: "未来", labels: { zh: "未来", "zh-Hant": "未來", en: "Future", ja: "未来", es: "Futuro", ko: "미래", id: "Masa Depan", ru: "Будущее" } },
  { canonical: "Zorro", labels: { zh: "狐", "zh-Hant": "狐", en: "Fox", ja: "狐", es: "Zorro", ko: "여우", id: "Rubah", ru: "Лиса" } },
  { canonical: "无限流", labels: { zh: "无限流", "zh-Hant": "無限流", en: "Infinite Loop", ja: "無限ループ", es: "Bucle infinito", ko: "무한류", id: "Infinite Loop", ru: "Бесконечный цикл" } },
  { canonical: "Alchemy", labels: { zh: "炼金术", "zh-Hant": "煉金術", en: "Alchemy", ja: "錬金術", es: "Alquimia", ko: "연금술", id: "Alkimia", ru: "Алхимия" } },
  { canonical: "逃生", labels: { zh: "逃生", "zh-Hant": "逃生", en: "Escape", ja: "脱出", es: "Escape", ko: "탈출", id: "Escape", ru: "Побег" } },
  { canonical: "Kuro Games", labels: { zh: "库洛游戏", "zh-Hant": "庫洛遊戲", en: "Kuro Games", ja: "クログames", es: "Kuro Games", ko: "쿠로 게임즈", id: "Kuro Games", ru: "Kuro Games" } },
  { canonical: "Fate", labels: { zh: "Fate", "zh-Hant": "Fate", en: "Fate", ja: "Fate", es: "Fate", ko: "Fate", id: "Fate", ru: "Fate" } },
  { canonical: "无表情", labels: { zh: "无表情", "zh-Hant": "無表情", en: "Expressionless", ja: "無表情", es: "Sin expresión", ko: "무표정", id: "Tanpa Ekspresi", ru: "Без эмоций" } },
  { canonical: "Alfa x Omega", labels: { zh: "Alpha x Omega", "zh-Hant": "Alpha x Omega", en: "Alpha x Omega", ja: "アルファ×オメガ", es: "Alfa x Omega", ko: "알파×오메가", id: "Alpha x Omega", ru: "Альфа × Омега" } },
  { canonical: "监狱", labels: { zh: "监狱", "zh-Hant": "監獄", en: "Prison", ja: "監獄", es: "Prisión", ko: "감옥", id: "Penjara", ru: "Тюрьма" } },
  { canonical: "反抗", labels: { zh: "反抗", "zh-Hant": "反抗", en: "Rebellion", ja: "反抗", es: "Rebelión", ko: "반항", id: "Pemberontakan", ru: "Бунт" } },
  { canonical: "净化", labels: { zh: "净化", "zh-Hant": "淨化", en: "Purification", ja: "浄化", es: "Purificación", ko: "정화", id: "Pemurnian", ru: "Очищение" } },
  { canonical: "高自由", labels: { zh: "高自由", "zh-Hant": "高自由", en: "High Freedom", ja: "ハイフリーダム", es: "Alta libertad", ko: "고자유도", id: "Kebebasan Tinggi", ru: "Свобода действий" } },
  { canonical: "Tension", labels: { zh: "张力", "zh-Hant": "張力", en: "Tension", ja: "緊張感", es: "Tensión", ko: "긴장감", id: "Ketegangan", ru: "Напряжение" } },
  { canonical: "Traumas", labels: { zh: "创伤", "zh-Hant": "創傷", en: "Trauma", ja: "トラウマ", es: "Traumas", ko: "트라우마", id: "Trauma", ru: "Травма" } },
  { canonical: "下克上", labels: { zh: "下克上", "zh-Hant": "下剋上", en: "underdog rising to power", ja: "下剋上", es: "ascenso del subordinado", ko: "하극상", id: "Underdog Bangkit", ru: "Гэкокудзё" } },
  { canonical: "CEO", labels: { zh: "CEO", "zh-Hant": "CEO", en: "CEO", ja: "CEO", es: "CEO", ko: "CEO", id: "CEO", ru: "CEO" } },
  { canonical: "Fullmetal Alchemist", labels: { zh: "钢之炼金术师", "zh-Hant": "鋼之鍊金術師", en: "Fullmetal Alchemist", ja: "鋼の錬金術師", es: "Fullmetal Alchemist", ko: "강철의 연금술사", id: "Fullmetal Alchemist", ru: "Стальной алхимик" } },
  { canonical: "PRTS", labels: { zh: "PRTS", "zh-Hant": "PRTS", en: "PRTS", ja: "PRTS", es: "PRTS", ko: "PRTS", id: "PRTS", ru: "PRTS" } },
  { canonical: "向导", labels: { zh: "向导", "zh-Hant": "嚮導", en: "guide", ja: "ガイド", es: "guía", ko: "가이드", id: "Guide", ru: "Гайд" } },
  { canonical: "Acción y misterio", labels: { zh: "动作与悬疑", "zh-Hant": "動作與懸疑", en: "action & mystery", ja: "アクション・ミステリー", es: "Acción y misterio", ko: "액션·미스터리", id: "Aksi & Misteri", ru: "Экшен и детектив" } },
  { canonical: "Intensidad", labels: { zh: "高强度", "zh-Hant": "高強度", en: "intensity", ja: "激しい展開", es: "Intensidad", ko: "고강도", id: "Intens", ru: "Накал страстей" } },
  { canonical: "Matrimonio arreglado", labels: { zh: "包办婚姻", "zh-Hant": "包辦婚姻", en: "arranged marriage", ja: "政略結婚", es: "Matrimonio arreglado", ko: "정략결혼", id: "Perjodohan", ru: "Брак по расчёту" } },
  { canonical: "ai chat", labels: { zh: "AI聊天", "zh-Hant": "AI聊天", en: "AI chat", ja: "AIチャット", es: "chat con IA", ko: "AI 챗", id: "Chat AI", ru: "ИИ-чат" } },
  { canonical: "Oficina", labels: { zh: "办公室", "zh-Hant": "辦公室", en: "office", ja: "オフィス", es: "Oficina", ko: "사무실", id: "Kantor", ru: "Офис" } },
  { canonical: "流浪", labels: { zh: "流浪", "zh-Hant": "流浪", en: "drifting", ja: "流浪", es: "vagabundeo", ko: "방랑", id: "Pengembara", ru: "Скитания" } },
  { canonical: "Universitario", labels: { zh: "大学生", "zh-Hant": "大學生", en: "college student", ja: "大学生", es: "Universitario", ko: "대학생", id: "Mahasiswa", ru: "Студент" } },
  { canonical: "支配", labels: { zh: "支配", "zh-Hant": "支配", en: "domination", ja: "支配", es: "dominación", ko: "지배", id: "Dominasi", ru: "Доминирование" } },
  { canonical: "丰满", labels: { zh: "丰满", "zh-Hant": "豐滿", en: "voluptuous", ja: "豊満", es: "voluptuosa", ko: "풍만", id: "Berisi", ru: "Пышные формы" } },
  { canonical: "不洁", labels: { zh: "不洁", "zh-Hant": "不潔", en: "impure", ja: "不潔", es: "impureza", ko: "불결", id: "Tak Murni", ru: "Скверна" } },
  { canonical: "Maestro x Pupilo", labels: { zh: "师徒", "zh-Hant": "師徒", en: "mentor x protégé", ja: "師匠×弟子", es: "Maestro x Pupilo", ko: "사제", id: "Guru x Murid", ru: "Наставник × ученик" } },
  { canonical: "Servant", labels: { zh: "从者", "zh-Hant": "從者", en: "Servant", ja: "サーヴァント", es: "Servant", ko: "서번트", id: "Servant", ru: "Слуга" } },
  { canonical: "Familia", labels: { zh: "家庭", "zh-Hant": "家庭", en: "family", ja: "家族", es: "Familia", ko: "가족", id: "Keluarga", ru: "Семья" } },
  { canonical: "武林", labels: { zh: "武林", "zh-Hant": "武林", en: "jianghu", ja: "武林", es: "mundo marcial (jianghu)", ko: "무림", id: "Jianghu", ru: "Цзянху" } },
  { canonical: "魔法少男", labels: { zh: "魔法少男", "zh-Hant": "魔法少男", en: "magical boy", ja: "魔法少年", es: "chico mágico", ko: "마법소년", id: "Magical Boy", ru: "Волшебный мальчик" } },
  { canonical: "巫女", labels: { zh: "巫女", "zh-Hant": "巫女", en: "shrine maiden", ja: "巫女", es: "miko (sacerdotisa sintoísta)", ko: "무녀", id: "Miko", ru: "Мико" } },
  { canonical: "性冷淡", labels: { zh: "性冷淡", "zh-Hant": "性冷淡", en: "frigid", ja: "sexless / 冷淡", es: "frigidez", ko: "불감증", id: "Libido Rendah", ru: "Фригидность" } },
  { canonical: "爆乳", labels: { zh: "爆乳", "zh-Hant": "爆乳", en: "Massive Breasts", ja: "爆乳", es: "Pechos enormes", ko: "폭유", id: "Dada Masif", ru: "Огромная грудь" } },
  { canonical: "西幻", labels: { zh: "西幻", "zh-Hant": "西幻", en: "Western Fantasy", ja: "西洋ファンタジー", es: "Fantasía occidental", ko: "서양 판타지", id: "Fantasi Barat", ru: "Западное фэнтези" } },
  { canonical: "Dark", labels: { zh: "黑暗", "zh-Hant": "黑暗", en: "Dark", ja: "ダーク", es: "Oscuro", ko: "다크", id: "Gelap", ru: "Мрачное" } },
  { canonical: "Monster Girl", labels: { zh: "魔物娘", "zh-Hant": "魔物娘", en: "Monster Girl", ja: "モンスター娘", es: "Chica monstruo", ko: "몬스터 걸", id: "Monster Girl", ru: "Монстродевушки" } },
  { canonical: "寡妇", labels: { zh: "寡妇", "zh-Hant": "寡婦", en: "Widow", ja: "未亡人", es: "Viuda", ko: "미망인", id: "Janda", ru: "Вдова" } },
  { canonical: "One Piece", labels: { zh: "海贼王", "zh-Hant": "航海王", en: "One Piece", ja: "ONE PIECE", es: "One Piece", ko: "원피스", id: "One Piece", ru: "Ван-Пис" } },
  { canonical: "榨取", labels: { zh: "榨取", "zh-Hant": "榨取", en: "Milking", ja: "搾り取り", es: "Extracción", ko: "착유", id: "Milking", ru: "Милкинг" } },
  { canonical: "逆ntr", labels: { zh: "逆NTR", "zh-Hant": "逆NTR", en: "Reverse NTR", ja: "逆NTR", es: "NTR inverso", ko: "역NTR", id: "Reverse NTR", ru: "Обратный NTR" } },
  { canonical: "暴风雪山庄", labels: { zh: "暴风雪山庄", "zh-Hant": "暴風雪山莊", en: "Closed Circle", ja: "クローズドサークル", es: "Círculo cerrado", ko: "폭풍의 산장", id: "Closed Circle", ru: "Закрытый круг" } },
  { canonical: "Pirate", labels: { zh: "海盗", "zh-Hant": "海盜", en: "Pirate", ja: "海賊", es: "Pirata", ko: "해적", id: "Bajak Laut", ru: "Пираты" } },
  { canonical: "哨向", labels: { zh: "哨向", "zh-Hant": "哨向", en: "Sentinel/Guide", ja: "哨兵/ガイド", es: "Centinela/Guía", ko: "센티넬버스", id: "Sentinel/Guide", ru: "Сентинел/Гайд" } },
  { canonical: "BLEACH", labels: { zh: "BLEACH 死神", "zh-Hant": "BLEACH", en: "BLEACH", ja: "BLEACH", es: "BLEACH", ko: "블리치", id: "BLEACH", ru: "Блич" } },
  { canonical: "Holy Grail War", labels: { zh: "圣杯战争", "zh-Hant": "聖杯戰爭", en: "Holy Grail War", ja: "聖杯戦争", es: "Guerra del Santo Grial", ko: "성배전쟁", id: "Holy Grail War", ru: "Война за Святой Грааль" } },
  { canonical: "人妻", labels: { zh: "人妻", "zh-Hant": "人妻", en: "Married Woman", ja: "人妻", es: "Mujer casada", ko: "유부녀", id: "Wanita Menikah", ru: "Замужняя женщина" }, aliases: ["wife"] },
  { canonical: "Mom", labels: { zh: "妈妈", "zh-Hant": "媽媽", en: "Mom", ja: "ママ", es: "Mamá", ko: "엄마", id: "Ibu", ru: "Мама" }, aliases: ["mom"] },
  { canonical: "JJBA", labels: { zh: "JOJO的奇妙冒险", "zh-Hant": "JOJO的奇妙冒險", en: "JoJo's Bizarre Adventure", ja: "ジョジョの奇妙な冒険", es: "JoJo's Bizarre Adventure", ko: "죠죠의 기묘한 모험", id: "JoJo's Bizarre Adventure", ru: "ДжоДжо" }, aliases: ["Jojo's bizarre adventure"] },
  { canonical: "Waifu", labels: { zh: "Waifu", "zh-Hant": "Waifu", en: "Waifu", ja: "ワイフ", es: "Waifu", ko: "와이프", id: "Waifu", ru: "Вайфу" }, aliases: ["waifu"] },
  { canonical: "Murder", labels: { zh: "凶杀", "zh-Hant": "兇殺", en: "Murder", ja: "殺人", es: "Asesinato", ko: "살인", id: "Pembunuhan", ru: "Убийство" }, aliases: ["凶杀"] },
  { canonical: "Vampire Survivors", labels: { zh: "吸血鬼幸存者", "zh-Hant": "吸血鬼倖存者", en: "Vampire Survivors", ja: "ヴァンパイアサバイバー", es: "Vampire Survivors", ko: "뱀파이어 서바이버즈", id: "Vampire Survivors", ru: "Vampire Survivors" }, aliases: ["吸血鬼幸存者"] },
  { canonical: "Maid", labels: { zh: "女仆", "zh-Hant": "女僕", en: "Maid", ja: "メイド", es: "Sirvienta", ko: "메이드", id: "Maid", ru: "Горничная" }, aliases: ["maid"] },
  { canonical: "少女前线", labels: { zh: "少女前线", "zh-Hant": "少女前線", en: "Girls' Frontline", ja: "ドールズフロントライン", es: "Girls' Frontline", ko: "소녀전선", id: "Girls' Frontline", ru: "Girls' Frontline" }, aliases: ["Girls' Frontline"] },
  { canonical: "密室", labels: { zh: "密室", "zh-Hant": "密室", en: "Locked Room", ja: "密室", es: "Habitación cerrada", ko: "밀실", id: "Ruang Terkunci", ru: "Запертая комната" }, aliases: ["Locked Room"] },
  { canonical: "Palworld", labels: { zh: "幻兽帕鲁", "zh-Hant": "幻獸帕魯", en: "Palworld", ja: "パルワールド", es: "Palworld", ko: "팰월드", id: "Palworld", ru: "Palworld" } },
  { canonical: "AI", labels: { zh: "AI", "zh-Hant": "AI", en: "AI", ja: "AI", es: "IA", ko: "AI", id: "AI", ru: "ИИ" } },
  { canonical: "shoujo", labels: { zh: "少女漫画", "zh-Hant": "少女漫畫", en: "Shoujo", ja: "少女漫画", es: "Shoujo", ko: "순정만화", id: "Shoujo", ru: "Сёдзё" } },
  { canonical: "SFW <-> NSFW", labels: { zh: "SFW <-> NSFW", "zh-Hant": "SFW <-> NSFW", en: "SFW <-> NSFW", ja: "SFW <-> NSFW", es: "SFW <-> NSFW", ko: "SFW <-> NSFW", id: "SFW <-> NSFW", ru: "SFW <-> NSFW" } },
  { canonical: "Dungeon", labels: { zh: "地下城", "zh-Hant": "地下城", en: "Dungeon", ja: "ダンジョン", es: "Mazmorra", ko: "던전", id: "Dungeon", ru: "Подземелье" } },
  { canonical: "时间旅行", labels: { zh: "时间旅行", "zh-Hant": "時間旅行", en: "Time Travel", ja: "タイムトラベル", es: "Viaje en el tiempo", ko: "시간 여행", id: "Time Travel", ru: "Путешествия во времени" } },
  { canonical: "HUNTER×HUNTER", labels: { zh: "全职猎人", "zh-Hant": "獵人", en: "Hunter x Hunter", ja: "HUNTER×HUNTER", es: "Hunter x Hunter", ko: "헌터×헌터", id: "Hunter x Hunter", ru: "Хантер × Хантер" } },
  { canonical: "Dice", labels: { zh: "骰子", "zh-Hant": "骰子", en: "Dice", ja: "ダイス", es: "Dados", ko: "주사위", id: "Dadu", ru: "Кубики" } },
  { canonical: "3d", labels: { zh: "3D", "zh-Hant": "3D", en: "3D", ja: "3D", es: "3D", ko: "3D", id: "3D", ru: "3D" } },
  { canonical: "isekai", labels: { zh: "异世界", "zh-Hant": "異世界", en: "Isekai", ja: "異世界", es: "Isekai", ko: "이세계", id: "Isekai", ru: "Исекай" } },
  { canonical: "arcade", labels: { zh: "街机", "zh-Hant": "街機", en: "Arcade", ja: "アーケード", es: "Arcade", ko: "아케이드", id: "Arcade", ru: "Аркада" } },
  { canonical: "进击的巨人", labels: { zh: "进击的巨人", "zh-Hant": "進擊的巨人", en: "Attack on Titan", ja: "進撃の巨人", es: "Attack on Titan", ko: "진격의 거인", id: "Attack on Titan", ru: "Атака титанов" } },
  { canonical: "手机", labels: { zh: "手机", "zh-Hant": "手機", en: "Mobile Phone", ja: "スマホ", es: "Teléfono móvil", ko: "휴대폰", id: "Ponsel", ru: "Телефон" } },
  { canonical: "5E", labels: { zh: "龙与地下城5E", "zh-Hant": "龍與地下城5E", en: "D&D 5E", ja: "D&D 5E", es: "D&D 5E", ko: "D&D 5E", id: "D&D 5E", ru: "D&D 5E" } },
  { canonical: "军略", labels: { zh: "军略", "zh-Hant": "軍略", en: "Military Strategy", ja: "軍略", es: "Estrategia militar", ko: "군략", id: "Strategi Militer", ru: "Военная стратегия" } },
  { canonical: "English", labels: { zh: "英语", "zh-Hant": "英語", en: "English", ja: "英語", es: "Inglés", ko: "영어", id: "Bahasa Inggris", ru: "Английский" } },
  { canonical: "Superhero", labels: { zh: "超级英雄", "zh-Hant": "超級英雄", en: "Superhero", ja: "ヒーロー", es: "Superhéroes", ko: "슈퍼히어로", id: "Superhero", ru: "Супергерои" } },
  { canonical: "为美好的世界献上祝福", labels: { zh: "为美好的世界献上祝福", "zh-Hant": "為美好的世界獻上祝福", en: "KonoSuba", ja: "この素晴らしい世界に祝福を!", es: "KonoSuba", ko: "이 멋진 세계에 축복을!", id: "KonoSuba", ru: "Коносуба" } },
  { canonical: "Incest", labels: { zh: "近亲相奸", "zh-Hant": "近親相姦", en: "Incest", ja: "近親相姦", es: "Incesto", ko: "근친", id: "Inses", ru: "Инцест" } },
  { canonical: "Tom and Jerry", labels: { zh: "猫和老鼠", "zh-Hant": "湯姆與傑利", en: "Tom and Jerry", ja: "トムとジェリー", es: "Tom y Jerry", ko: "톰과 제리", id: "Tom and Jerry", ru: "Том и Джерри" } },
  { canonical: "谋略", labels: { zh: "谋略", "zh-Hant": "謀略", en: "Scheming", ja: "謀略", es: "Intriga", ko: "모략", id: "Intrik", ru: "Интриги" } },
  { canonical: "Jujutsu Kaisen", labels: { zh: "咒术回战", "zh-Hant": "咒術迴戰", en: "Jujutsu Kaisen", ja: "呪術廻戦", es: "Jujutsu Kaisen", ko: "주술회전", id: "Jujutsu Kaisen", ru: "Магическая битва" } },
  { canonical: "Villain", labels: { zh: "反派", "zh-Hant": "反派", en: "Villain", ja: "ヴィラン", es: "Villano", ko: "악역", id: "Villain", ru: "Злодей" } },
  { canonical: "智斗", labels: { zh: "智斗", "zh-Hant": "智鬥", en: "Battle of Wits", ja: "頭脳戦", es: "Duelo de ingenio", ko: "두뇌전", id: "Adu Otak", ru: "Битва умов" } },
  { canonical: "火凤燎原", labels: { zh: "火凤燎原", "zh-Hant": "火鳳燎原", en: "The Ravages of Time", ja: "火鳳燎原", es: "The Ravages of Time", ko: "화봉요원", id: "The Ravages of Time", ru: "The Ravages of Time" } },
  { canonical: "骗子酒馆", labels: { zh: "骗子酒馆", "zh-Hant": "騙子酒館", en: "Liar's Bar", ja: "ライアーズバー", es: "Liar's Bar", ko: "라이어스 바", id: "Liar's Bar", ru: "Liar's Bar" } },
  { canonical: "Banter", labels: { zh: "斗嘴打趣", "zh-Hant": "鬥嘴打趣", en: "Banter", ja: "軽口", es: "Bromas", ko: "티키타카", id: "Banter", ru: "Пикировки" } },
  { canonical: "pvp", labels: { zh: "PvP", "zh-Hant": "PvP", en: "PvP", ja: "PvP", es: "PvP", ko: "PvP", id: "PvP", ru: "PvP" } },
  { canonical: "联机", labels: { zh: "联机", "zh-Hant": "連線", en: "Multiplayer", ja: "マルチプレイ", es: "Multijugador", ko: "멀티플레이", id: "Multiplayer", ru: "Мультиплеер" }, aliases: ["multiplayer", "多人联机", "連線", "マルチプレイ", "multijugador", "online multiplayer"] },
  // A card can name the work it is set in. Left free-form, an IP tag written in
  // one language shows that language's characters to every other reader: the
  // Japanese PvZ card carried a chip reading 植物大战僵尸.
  { canonical: "植物大战僵尸", labels: { zh: "植物大战僵尸", "zh-Hant": "植物大戰殭屍", en: "Plants vs. Zombies", ja: "プラント vs. ゾンビ", es: "Plants vs. Zombies", ko: "식물 vs. 좀비", id: "Plants vs. Zombies", ru: "Растения против зомби" }, aliases: ["plants vs zombies", "plants vs. zombies", "pvz", "植物大戰殭屍", "プラントvsゾンビ"] },
  { canonical: "Crime", labels: { zh: "犯罪", "zh-Hant": "犯罪", en: "Crime", ja: "犯罪", es: "Crimen", ko: "범죄", id: "Kriminal", ru: "Криминал" } },
  { canonical: "惠惠", labels: { zh: "惠惠", "zh-Hant": "惠惠", en: "Megumin", ja: "めぐみん", es: "Megumin", ko: "메구밍", id: "Megumin", ru: "Мегумин" } },
  { canonical: "Modern", labels: { zh: "现代", "zh-Hant": "現代", en: "Modern", ja: "現代", es: "Moderno", ko: "현대", id: "Modern", ru: "Современность" } },
  { canonical: "电影", labels: { zh: "电影", "zh-Hant": "電影", en: "Movie", ja: "映画", es: "Película", ko: "영화", id: "Film", ru: "Фильм" }, aliases: ["movie"] },
  { canonical: "Life Sim", labels: { zh: "生活模拟", "zh-Hant": "生活模擬", en: "Life Sim", ja: "ライフシミュレーション", es: "Simulación de vida", ko: "생활 시뮬", id: "Life Sim", ru: "Симулятор жизни" }, aliases: ["life sim"] },
  { canonical: "Roommates", labels: { zh: "室友", "zh-Hant": "室友", en: "Roommates", ja: "ルームメイト", es: "Compañeros de cuarto", ko: "룸메이트", id: "Teman Sekamar", ru: "Соседи по комнате" }, aliases: ["Roomate"] },
  { canonical: "Komi Shouko", labels: { zh: "古见硝子", "zh-Hant": "古見硝子", en: "Komi Shouko", ja: "古見硝子", es: "Komi Shouko", ko: "코미 쇼코", id: "Komi Shouko", ru: "Сёко Коми" }, aliases: ["Komi Cant Communicate", "Shouko Nishimiya"] },
  { canonical: "dragon", labels: { zh: "龙", "zh-Hant": "龍", en: "Dragon", ja: "ドラゴン", es: "Dragón", ko: "드래곤", id: "Naga", ru: "Дракон" }, aliases: ["Dragon", "Dragons"] },
  { canonical: "Evangelion", labels: { zh: "新世纪福音战士", "zh-Hant": "新世紀福音戰士", en: "Neon Genesis Evangelion", ja: "新世紀エヴァンゲリオン", es: "Neon Genesis Evangelion", ko: "신세기 에반게리온", id: "Neon Genesis Evangelion", ru: "Евангелион" }, aliases: ["Neon Genesis Evangelion", "EVA"] },
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

// ── Tag pages (/app/tag/<slug>) ──────────────────────────────────────────────
// A tag page's address is the tag's English label, lowercased with dashes:
// 恋爱 lives at /app/tag/romance. Only vocabulary tags get an address, so the
// server and the app turn a slug back into the stored tag from this table,
// with no lookup. A tag outside the vocabulary has no page.

/** The path prefix of a world tag page. */
export const TAG_PAGE_PREFIX = "/app/tag/";

function slugifyTagLabel(label: string): string {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

const BY_SLUG = new Map<string, TagEntry>();
const SLUG_OF = new Map<TagEntry, string>();
for (const entry of TAG_VOCABULARY) {
  const slug = slugifyTagLabel(entry.labels.en);
  // The first entry keeps a contested slug; tags.test.ts fails on any clash.
  if (!slug || BY_SLUG.has(slug)) continue;
  BY_SLUG.set(slug, entry);
  SLUG_OF.set(entry, slug);
}

/** The address slug of a stored or typed tag, or null when it has no page. */
export function tagSlug(tag: string): string | null {
  const entry = findTagEntry(tag);
  return entry ? SLUG_OF.get(entry) ?? null : null;
}

/** The vocabulary entry a tag page slug names, if any. */
export function findTagBySlug(slug: string): TagEntry | undefined {
  let decoded = String(slug);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep the raw text
  }
  return BY_SLUG.get(decoded.trim().toLowerCase());
}

/** `/app/tag/<slug>` for a tag that has a page, else null. */
export function tagPagePath(tag: string): string | null {
  const slug = tagSlug(tag);
  return slug ? `${TAG_PAGE_PREFIX}${slug}` : null;
}

/** Every spelling stored worlds may carry for this tag, lowercased. */
export function tagSpellings(entry: TagEntry): string[] {
  return [...new Set([entry.canonical, ...Object.values(entry.labels), ...(entry.aliases ?? [])].map((s) => s.toLowerCase()))];
}

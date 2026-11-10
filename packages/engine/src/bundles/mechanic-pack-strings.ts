/**
 * The words in a mechanic pack, per language.
 *
 * Every pack ships as authored content, not as a template the player's UI
 * language decorates at render time — once installed it IS the card's own
 * variables and behaviours, and those are edited, translated and published by
 * the author like anything else they wrote.
 *
 * The keyword lists are the reason this file exists rather than one English
 * pack with translated labels. A behaviour that watches for "love, thanks,
 * sorry" fires on nothing in a Chinese card, and the author would have no way
 * to tell the pack was doing nothing at all. Keywords are content.
 */
export interface PackStrings {
  name: string;
  description: string;
  /** One line per pack, shown under the title in the picker. */
  gives: string;

  affection?: {
    varAffection: string;
    varTrust: string;
    affectionRules: string;
    trustRules: string;
    warmWords: string[];
    coldWords: string[];
    onWarm: string;
    onCold: string;
    onTime: string;
    onThreshold: string;
    thresholdDirective: string;
    stagesTitle: string;
    stagesContent: string;
  };

  survival?: {
    varHunger: string;
    varThirst: string;
    varStamina: string;
    varWarmth: string;
    hungerRules: string;
    tickName: string;
    lowName: string;
    criticalName: string;
    lowDirective: string;
    criticalDirective: string;
    rulesTitle: string;
    rulesContent: string;
  };

  events?: {
    weatherName: string;
    weatherDirective: string;
    passerbyName: string;
    passerbyDirective: string;
    beatName: string;
    beatDirective: string;
    noteTitle: string;
    noteContent: string;
  };

  panel?: {
    behaviorName: string;
    directive: string;
  };
}

const zh: Record<string, PackStrings> = {
  affection: {
    name: "好感度",
    description: "两条数值随剧情涨落；到线了就换语气、开新词条。关系阶段写在一条常驻词条里，AI 每回合读得到。",
    gives: "2 变量 · 4 行为 · 1 词条",
    affection: {
      varAffection: "好感",
      varTrust: "信任",
      affectionRules: "这个角色对 {{user}} 的好感，0–100。它由剧情推动：被理解、被记住、被善待会涨；被敷衍、被利用、被冒犯会跌。不要在正文里报数字，用态度和措辞体现它。",
      trustRules: "这个角色对 {{user}} 的信任，0–100。它比好感涨得慢：靠时间、靠兑现承诺、靠在难处没走开。信任低时她保留真话，信任高时她主动说出不该说的。",
      warmWords: ["谢谢", "对不起", "我懂", "陪你", "别怕", "记得", "喜欢", "在乎", "抱歉", "辛苦"],
      coldWords: ["随便", "无所谓", "关我什么事", "烦", "闭嘴", "滚", "不想听", "懒得"],
      onWarm: "玩家说了在意的话",
      onCold: "玩家敷衍或走开",
      onTime: "相处久了",
      onThreshold: "好感过线",
      thresholdDirective: "{{user}} 和这个角色的关系已经越过一道线。她可以主动一点，可以说一件以前不会说的事，但不要宣布「我们关系变好了」——让它体现在她做什么上。",
      stagesTitle: "关系阶段",
      stagesContent: `好感与信任怎么读：

- 好感 0–25：礼貌但有距离。她回答问题，不多说一个字。
- 好感 26–55：熟人。她会主动提起自己的事，但停在表面。
- 好感 56–80：在乎。她会记住 {{user}} 说过的细节，并在后面用上。
- 好感 81–100：亲近。她会说只对一个人说的话。

信任是另一条线，低信任会让高好感显得矛盾——她喜欢 {{user}}，但还是不敢把真话交出去。这种矛盾是好的，别把它磨平。`,
    },
  },
  survival: {
    name: "生存数值",
    description: "饥饿、口渴、体力、保暖每回合往下走；过线警告，归零有后果。数值一直在动，故事自己就有压力。",
    gives: "4 变量 · 3 行为 · 1 词条",
    survival: {
      varHunger: "饥饿",
      varThirst: "口渴",
      varStamina: "体力",
      varWarmth: "保暖",
      hungerRules: "0–100，越高越好。吃东西回升，长时间赶路和剧烈活动下降。低于 20 时人会发抖、注意力涣散。",
      tickName: "时间在流逝",
      lowName: "有一项见底了",
      criticalName: "撑不住了",
      lowDirective: "{{user}} 的某项身体状态已经很低。让它在这一回合被身体感觉到——手抖、眼前发黑、脚步不稳——而不是用一句「你很饿」带过。",
      criticalDirective: "{{user}} 有一项身体状态已经归零。这一回合必须有真实后果：倒下、判断失误、被迫放弃正在做的事。不要让 ta 靠意志力硬撑过去。",
      rulesTitle: "生存规则",
      rulesContent: `这个世界里，身体状态是真的。

四条数值每过一回合都会往下走一点，只有吃、喝、休息、取暖能让它们回来。数值低的时候，先在身体上体现，再在判断上体现——一个饿了两天的人不会做出精明的决定。

不要在正文里念数字。让读者从 {{user}} 的手抖、呼吸、走路的样子里读出来。`,
    },
  },
  events: {
    name: "随机事件",
    description: "每回合按概率出一件小事，每隔几回合必出一件。一个 5% 下雨的块，是最便宜的「这个世界活着」。",
    gives: "3 行为 · 1 词条",
    events: {
      weatherName: "天气说变就变",
      weatherDirective: "这一回合天气变了。别让它只是背景——让它逼着场景里的人改变正在做的事。",
      passerbyName: "有人经过",
      passerbyDirective: "这一回合有一个不重要的人出现：路人、送货的、隔壁的邻居。给 ta 一句话的性格，然后让 ta 走。不要把 ta 变成新剧情线。",
      beatName: "该出点事了",
      beatDirective: "已经平静了几回合。这一回合引入一件小事打破节奏——不是危机，是一个具体的、会让人抬头的变化。",
      noteTitle: "随机事件的口径",
      noteContent: `这个故事里会时不时冒出一件没被计划的小事。

它们的作用是让世界显得在自己运转，不是围着 {{user}} 转。所以：小事要小，出现得突然，解决得快，而且大多数时候和主线无关。

不要把随机事件写成任务，也不要在事后解释它为什么发生。`,
    },
  },
  panel: {
    name: "状态面板（不用变量）",
    description: "只有一条行为：每回合末尾要求 AI 按固定格式附一小块状态。不精确，但零配置，先有个样子。",
    gives: "1 行为 · 不用变量",
    panel: {
      behaviorName: "每回合附一块状态",
      directive: `每次回复的最后，另起一段，用这个格式附一小块状态：

──────────
时间 ｜ 地点
心情 ｜ 身上带着什么
──────────

只填你在这一回合里真的确定的东西，不确定就写「—」。不要解释这块状态，也不要在正文里提到它。`,
    },
  },
};

const en: Record<string, PackStrings> = {
  affection: {
    name: "Affection",
    description: "Two numbers that move with the story; crossing a line changes her tone and opens new lore. The stages live in an always-on entry the AI reads every turn.",
    gives: "2 variables · 4 behaviours · 1 entry",
    affection: {
      varAffection: "Affection",
      varTrust: "Trust",
      affectionRules: "How this character feels about {{user}}, 0–100. The story moves it: being understood, remembered and treated well raises it; being brushed off, used or insulted lowers it. Never state the number in prose — show it in her manner and word choice.",
      trustRules: "How far this character trusts {{user}}, 0–100. Slower to move than affection: it comes from time, from promises kept, from not leaving when it got hard. Low trust holds the real answer back; high trust volunteers the thing she should not say.",
      warmWords: ["thank you", "thanks", "sorry", "i understand", "i'm here", "stay", "remember", "i care", "please", "are you okay"],
      coldWords: ["whatever", "don't care", "shut up", "go away", "leave me alone", "boring", "not my problem"],
      onWarm: "Player said something that lands",
      onCold: "Player brushed her off",
      onTime: "Time spent together",
      onThreshold: "Affection crossed a line",
      thresholdDirective: "The relationship between {{user}} and this character has crossed a line. She can take a little initiative, and say one thing she would not have said before — but do not announce that anything changed. Let it show in what she does.",
      stagesTitle: "Relationship stages",
      stagesContent: `How to read affection and trust:

- Affection 0–25: polite, at a distance. She answers, and not a word more.
- Affection 26–55: familiar. She brings up her own life, but stops at the surface.
- Affection 56–80: invested. She remembers details {{user}} mentioned and uses them later.
- Affection 81–100: close. She says the things people only say to one person.

Trust is a separate line. Low trust against high affection is a contradiction, not a bug — she likes {{user}} and still will not hand over the truth. Keep the contradiction.`,
    },
  },
  survival: {
    name: "Survival meters",
    description: "Hunger, thirst, stamina and warmth tick down every turn; crossing low gives a warning, hitting zero has consequences. The numbers always move, so the story carries pressure on its own.",
    gives: "4 variables · 3 behaviours · 1 entry",
    survival: {
      varHunger: "Hunger",
      varThirst: "Thirst",
      varStamina: "Stamina",
      varWarmth: "Warmth",
      hungerRules: "0–100, higher is better. Food restores it; long travel and hard effort drain it. Below 20 the body shakes and attention slips.",
      tickName: "Time passes",
      lowName: "Something is running out",
      criticalName: "Can't hold on",
      lowDirective: "One of {{user}}'s body meters is very low. Let this turn feel it physically — shaking hands, vision greying, footing going — rather than announcing \"you are hungry\".",
      criticalDirective: "One of {{user}}'s body meters has hit zero. This turn must carry a real consequence: collapse, a misjudgement, giving up what they were doing. Do not let willpower carry them through it.",
      rulesTitle: "Survival rules",
      rulesContent: `In this world the body is real.

Four meters slip a little every turn, and only eating, drinking, resting and getting warm bring them back. When a meter is low, show it in the body first and in judgement second — someone two days hungry does not make shrewd decisions.

Never read the numbers out. Let the reader find them in {{user}}'s hands, breathing, and the way they walk.`,
    },
  },
  events: {
    name: "Random events",
    description: "A small thing happens on a roll each turn, and something always happens every few turns. A 5% chance of rain is the cheapest way to make a world feel alive.",
    gives: "3 behaviours · 1 entry",
    events: {
      weatherName: "Weather turns",
      weatherDirective: "The weather changed this turn. Do not leave it as scenery — make it force whoever is in the scene to change what they were doing.",
      passerbyName: "Someone passes through",
      passerbyDirective: "An unimportant person appears this turn: a passer-by, a delivery, the neighbour. Give them one line of personality, then let them go. Do not turn them into a new thread.",
      beatName: "Time for something",
      beatDirective: "It has been quiet for several turns. Introduce one small thing this turn to break the rhythm — not a crisis, a specific change that makes people look up.",
      noteTitle: "How random events read",
      noteContent: `Small unplanned things happen in this story.

Their job is to make the world look like it runs on its own instead of orbiting {{user}}. So: keep them small, let them arrive abruptly, resolve them fast, and most of the time leave them unconnected to the main thread.

Do not write a random event as a quest, and never explain afterwards why it happened.`,
    },
  },
  panel: {
    name: "Status panel (no variables)",
    description: "One behaviour: ask the AI to append a small status block in a fixed format each turn. Not exact, but zero setup — something to look at on day one.",
    gives: "1 behaviour · no variables",
    panel: {
      behaviorName: "Append a status block each turn",
      directive: `At the end of every reply, on its own paragraph, append a small status block in this format:

──────────
Time | Place
Mood | Carrying
──────────

Fill in only what you actually established this turn; write "—" for anything you did not. Do not explain the block, and never refer to it in the prose.`,
    },
  },
};

const ja: Record<string, PackStrings> = {
  affection: {
    name: "好感度",
    description: "物語とともに動く二つの数値。一線を越えると口調が変わり、新しい設定が開きます。関係の段階は常駐の項目に書かれ、AI が毎ターン読みます。",
    gives: "2 変数 · 4 行動 · 1 項目",
    affection: {
      varAffection: "好感度",
      varTrust: "信頼",
      affectionRules: "このキャラクターが {{user}} に抱く好意、0–100。理解され、覚えていてもらい、大切にされると上がる。流され、利用され、傷つけられると下がる。数値を本文で口に出さず、態度と言葉選びで示すこと。",
      trustRules: "このキャラクターが {{user}} を信頼している度合い、0–100。好感度より動きが遅い。時間、守られた約束、苦しいときに離れなかったこと。信頼が低ければ本当のことは伏せ、高ければ言うべきでないことを自分から話す。",
      warmWords: ["ありがとう", "ごめん", "わかる", "そばに", "怖くない", "覚えてる", "好き", "大事", "大丈夫", "お疲れ"],
      coldWords: ["どうでもいい", "知らない", "うるさい", "黙れ", "あっち行って", "興味ない", "面倒"],
      onWarm: "プレイヤーの言葉が届いた",
      onCold: "プレイヤーが受け流した",
      onTime: "一緒に過ごした時間",
      onThreshold: "好感度が一線を越えた",
      thresholdDirective: "{{user}} とこのキャラクターの関係が一線を越えました。少しだけ自分から踏み込んでよく、以前なら言わなかったことを一つ話してよい。ただし「関係が良くなった」と宣言しないこと。行動で示すこと。",
      stagesTitle: "関係の段階",
      stagesContent: `好感度と信頼の読み方：

- 好感度 0–25：礼儀正しく、距離がある。訊かれたことに答え、それ以上は言わない。
- 好感度 26–55：顔見知り。自分の話もするが、表面で止まる。
- 好感度 56–80：気にかけている。{{user}} が話した細部を覚えていて、後で使う。
- 好感度 81–100：近い。一人にしか言わないことを言う。

信頼は別の線です。信頼が低いまま好感度が高いのは矛盾ではなく、そのままでよい——好きなのに、本当のことはまだ渡せない。その矛盾を均さないこと。`,
    },
  },
  survival: {
    name: "生存数値",
    description: "空腹・渇き・体力・暖かさが毎ターン減っていく。低くなれば警告、ゼロになれば結果が出る。数値が動き続けるだけで物語に圧がかかります。",
    gives: "4 変数 · 3 行動 · 1 項目",
    survival: {
      varHunger: "空腹",
      varThirst: "渇き",
      varStamina: "体力",
      varWarmth: "暖かさ",
      hungerRules: "0–100、高いほど良い。食べれば戻り、長い移動や激しい行動で減る。20 を下回ると手が震え、注意が散る。",
      tickName: "時間が経つ",
      lowName: "どれかが尽きかけている",
      criticalName: "もう保たない",
      lowDirective: "{{user}} の身体の数値が一つ、かなり低くなっています。「お腹が空いた」で済ませず、このターンで身体に出すこと——手の震え、視界の暗み、足元の不確かさ。",
      criticalDirective: "{{user}} の身体の数値が一つゼロになりました。このターンには必ず本当の結果を：倒れる、判断を誤る、やっていたことを諦める。気力で乗り切らせないこと。",
      rulesTitle: "生存のルール",
      rulesContent: `この世界では身体は本物です。

四つの数値は一ターンごとに少しずつ減り、食べる・飲む・休む・暖まることでしか戻りません。低いときはまず身体に、次に判断に出すこと——二日食べていない人間は賢い決断をしません。

数値を本文で読み上げないこと。{{user}} の手、呼吸、歩き方から読者に伝えること。`,
    },
  },
  events: {
    name: "ランダムイベント",
    description: "毎ターン確率で小さな出来事が起き、数ターンごとに必ず何かが起きます。5% の雨は、世界が生きて見える一番安い方法です。",
    gives: "3 行動 · 1 項目",
    events: {
      weatherName: "天気が変わる",
      weatherDirective: "このターンで天気が変わりました。背景で終わらせず、その場にいる人がやっていたことを変えざるを得ないようにすること。",
      passerbyName: "誰かが通りかかる",
      passerbyDirective: "このターンに重要でない人物が現れます：通行人、配達、隣人。一行分の人柄を与えて、去らせること。新しい筋にしないこと。",
      beatName: "そろそろ何か起きる",
      beatDirective: "数ターン静かでした。このターンでリズムを崩す小さな出来事を一つ——危機ではなく、顔を上げさせる具体的な変化を。",
      noteTitle: "ランダムイベントの扱い",
      noteContent: `この物語では、予定されていない小さな出来事が時々起こります。

役目は、世界が {{user}} を中心に回っているのではなく、自分で動いて見えるようにすることです。だから：小さく、突然に、早く片づき、たいていは本筋と関係のないままにすること。

ランダムイベントを任務として書かないこと。後から理由を説明しないこと。`,
    },
  },
  panel: {
    name: "ステータス表示（変数なし）",
    description: "行動は一つだけ：毎ターンの終わりに決まった形式で小さなステータスを添えるよう AI に求めます。正確ではありませんが、設定ゼロで初日から形になります。",
    gives: "1 行動 · 変数なし",
    panel: {
      behaviorName: "毎ターン、ステータスを添える",
      directive: `返信の最後に、段落を改めて、この形式で小さなステータスを添えてください：

──────────
時刻 ｜ 場所
気分 ｜ 持ち物
──────────

このターンで実際に確定したことだけを書き、不明なものは「—」とすること。この表示について説明せず、本文中で言及しないこと。`,
    },
  },
};

const zhHant: Record<string, PackStrings> = {
  affection: {
    name: "好感度",
    description: "兩條數值隨劇情漲落；到線了就換語氣、開新詞條。關係階段寫在一條常駐詞條裡，AI 每回合讀得到。",
    gives: "2 變數 · 4 行為 · 1 詞條",
    affection: {
      varAffection: "好感",
      varTrust: "信任",
      affectionRules: "這個角色對 {{user}} 的好感，0–100。它由劇情推動：被理解、被記住、被善待會漲；被敷衍、被利用、被冒犯會跌。不要在正文裡報數字，用態度和措辭體現它。",
      trustRules: "這個角色對 {{user}} 的信任，0–100。它比好感漲得慢：靠時間、靠兌現承諾、靠在難處沒走開。信任低時她保留真話，信任高時她主動說出不該說的。",
      warmWords: ["謝謝", "對不起", "我懂", "陪你", "別怕", "記得", "喜歡", "在乎", "抱歉", "辛苦"],
      coldWords: ["隨便", "無所謂", "關我什麼事", "煩", "閉嘴", "滾", "不想聽", "懶得"],
      onWarm: "玩家說了在意的話",
      onCold: "玩家敷衍或走開",
      onTime: "相處久了",
      onThreshold: "好感過線",
      thresholdDirective: "{{user}} 和這個角色的關係已經越過一道線。她可以主動一點，可以說一件以前不會說的事，但不要宣布「我們關係變好了」——讓它體現在她做什麼上。",
      stagesTitle: "關係階段",
      stagesContent: `好感與信任怎麼讀：

- 好感 0–25：禮貌但有距離。她回答問題，不多說一個字。
- 好感 26–55：熟人。她會主動提起自己的事，但停在表面。
- 好感 56–80：在乎。她會記住 {{user}} 說過的細節，並在後面用上。
- 好感 81–100：親近。她會說只對一個人說的話。

信任是另一條線，低信任會讓高好感顯得矛盾——她喜歡 {{user}}，但還是不敢把真話交出去。這種矛盾是好的，別把它磨平。`,
    },
  },
  survival: {
    name: "生存數值",
    description: "飢餓、口渴、體力、保暖每回合往下走；過線警告，歸零有後果。數值一直在動，故事自己就有壓力。",
    gives: "4 變數 · 3 行為 · 1 詞條",
    survival: {
      varHunger: "飢餓",
      varThirst: "口渴",
      varStamina: "體力",
      varWarmth: "保暖",
      hungerRules: "0–100，越高越好。吃東西回升，長時間趕路和劇烈活動下降。低於 20 時人會發抖、注意力渙散。",
      tickName: "時間在流逝",
      lowName: "有一項見底了",
      criticalName: "撐不住了",
      lowDirective: "{{user}} 的某項身體狀態已經很低。讓它在這一回合被身體感覺到——手抖、眼前發黑、腳步不穩——而不是用一句「你很餓」帶過。",
      criticalDirective: "{{user}} 有一項身體狀態已經歸零。這一回合必須有真實後果：倒下、判斷失誤、被迫放棄正在做的事。不要讓 ta 靠意志力硬撐過去。",
      rulesTitle: "生存規則",
      rulesContent: `這個世界裡，身體狀態是真的。

四條數值每過一回合都會往下走一點，只有吃、喝、休息、取暖能讓它們回來。數值低的時候，先在身體上體現，再在判斷上體現——一個餓了兩天的人不會做出精明的決定。

不要在正文裡念數字。讓讀者從 {{user}} 的手抖、呼吸、走路的樣子裡讀出來。`,
    },
  },
  events: {
    name: "隨機事件",
    description: "每回合按機率出一件小事，每隔幾回合必出一件。一個 5% 下雨的塊，是最便宜的「這個世界活著」。",
    gives: "3 行為 · 1 詞條",
    events: {
      weatherName: "天氣說變就變",
      weatherDirective: "這一回合天氣變了。別讓它只是背景——讓它逼著場景裡的人改變正在做的事。",
      passerbyName: "有人經過",
      passerbyDirective: "這一回合有一個不重要的人出現：路人、送貨的、隔壁的鄰居。給 ta 一句話的性格，然後讓 ta 走。不要把 ta 變成新劇情線。",
      beatName: "該出點事了",
      beatDirective: "已經平靜了幾回合。這一回合引入一件小事打破節奏——不是危機，是一個具體的、會讓人抬頭的變化。",
      noteTitle: "隨機事件的口徑",
      noteContent: `這個故事裡會時不時冒出一件沒被計劃的小事。

它們的作用是讓世界顯得在自己運轉，不是圍著 {{user}} 轉。所以：小事要小，出現得突然，解決得快，而且大多數時候和主線無關。

不要把隨機事件寫成任務，也不要在事後解釋它為什麼發生。`,
    },
  },
  panel: {
    name: "狀態面板（不用變數）",
    description: "只有一條行為：每回合末尾要求 AI 按固定格式附一小塊狀態。不精確，但零配置，先有個樣子。",
    gives: "1 行為 · 不用變數",
    panel: {
      behaviorName: "每回合附一塊狀態",
      directive: `每次回覆的最後，另起一段，用這個格式附一小塊狀態：

──────────
時間 ｜ 地點
心情 ｜ 身上帶著什麼
──────────

只填你在這一回合裡真的確定的東西，不確定就寫「—」。不要解釋這塊狀態，也不要在正文裡提到它。`,
    },
  },
};

/** Spanish packs are not authored yet; English is the honest fallback — a
 *  machine-converted pack would ship broken keyword lists that silently
 *  match nothing, which is worse than a language the author can read. */
const es: Record<string, PackStrings> = en;

const TABLES: Record<string, Record<string, PackStrings>> = {
  zh,
  "zh-Hant": zhHant,
  ja,
  en,
  es,
};

/** The pack's words in the author's language, falling back to English. Packs
 *  are installed as authored content, so this resolves once at install time
 *  and never again. */
export function packStrings(packId: string, language: string | undefined): PackStrings {
  const lang = language ?? "en";
  const table = TABLES[lang] ?? TABLES[lang.split("-")[0] ?? "en"] ?? en;
  return table[packId] ?? en[packId]!;
}

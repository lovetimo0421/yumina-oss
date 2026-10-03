import type { AppPackDef } from "../app-pack-types.js";

export const social: AppPackDef = {
  icon: "🔥",
  variableId: "app_social",
  defaultValue: { trending: [], posts: [] },
  sample: {
    zh: {
      trending: [
        { id: "t1", title: "陆衍深夜现身某小区", heat: "482万", tag: "hot" },
        { id: "t2", title: "陆衍新剧定档", heat: "311万", tag: "rising" },
        { id: "t3", title: "神秘女子同款围巾", heat: "97万", tag: "new" },
        { id: "t4", title: "赵姐回应恋情传闻", heat: "54万", tag: "" },
      ],
      posts: [
        { id: "p1", author: "陆衍工作室", handle: "luyan_studio", text: "今晚的直播推迟到周六，感谢大家的理解。", time: "21:02", likes: 38200, reposts: 5100, liked: false, reposted: false, comments: [{ author: "唯爱陆衍", text: "等你！！" }] },
        { id: "p2", author: "吃瓜前线", handle: "guaqianxian", text: "有人拍到陆衍的车停在城东某小区楼下，副驾有人……这个围巾是不是有点眼熟？", time: "23:15", likes: 12400, reposts: 3300, liked: true, reposted: false, comments: [{ author: "路人甲", text: "图糊成这样也能看出围巾？" }, { author: "林小瑜", text: "都散了吧，同款围巾满大街都是" }] },
      ],
    },
    en: {
      trending: [
        { id: "t1", title: "SakuraFestival", heat: "12.4k posts", tag: "hot" },
        { id: "t2", title: "RooftopConfession", heat: "3.1k posts", tag: "new" },
        { id: "t3", title: "ClassRepElection", heat: "980 posts", tag: "rising" },
      ],
      posts: [
        { id: "p1", author: "Rin", handle: "rin_top1", text: "Top of the class again. Some people should try harder.", time: "15:30", likes: 230, reposts: 12, liked: false, reposted: false, comments: [{ author: "Hina", text: "Be nice, Rin 😅" }] },
        { id: "p2", author: "School Gossip", handle: "sakura_whispers", text: "Someone saw Hina waiting on the rooftop after class… for who? 👀", time: "16:40", likes: 812, reposts: 95, liked: false, reposted: false, comments: [] },
      ],
    },
    es: {
      trending: [
        { id: "t1", title: "LunaLlena", heat: "8,2 mil publicaciones", tag: "hot" },
        { id: "t2", title: "AlfaDelBarrioNorte", heat: "2,4 mil publicaciones", tag: "rising" },
        { id: "t3", title: "AulladosEnElParque", heat: "610 publicaciones", tag: "new" },
      ],
      posts: [
        { id: "p1", author: "Haruo", handle: "haruo_chiba", text: "Luna llena otra vez. Cierren bien las ventanas.", time: "18:40", likes: 84, reposts: 6, liked: false, reposted: false, comments: [] },
        { id: "p2", author: "Noticias del Barrio", handle: "barrio_norte", text: "Vecinos reportan aullidos cerca del parque. ¿Alguien más los escuchó anoche?", time: "19:05", likes: 1250, reposts: 310, liked: false, reposted: false, comments: [{ author: "Daigo", text: "Perros callejeros. Nada más." }] },
      ],
    },
  },
  words: {
    zh: {
      name: "广场",
      description: "故事世界里的社交广场：大家发帖议论发生的事，热搜榜显示舆论风向（包括关于你的传闻）。点赞、转发、评论不花回合。",
      variableName: "App · 广场",
      rules: `"广场"App，是这个世界的公共社交平台。数据形状：{"trending": [{"id", "title": 话题, "heat": 热度（文字，如"482万"）, "tag": "hot"|"new"|"rising"|""}], "posts": [{"id", "author": 发帖人, "handle": 账号, "text", "time", "likes", "reposts", "liked", "reposted", "comments": [{"author", "text"}]}]}。
- 开场时按故事设定放几条帖子和 3-5 个热搜，让广场一打开就是活的。
- 故事里有公开的事发生时（被拍到、有人发声明、事情传开了），大多数回合改 1-3 处：NPC、路人、营销号发帖或评论，热搜的排序和热度跟着舆论变，传闻可以是半真半假。新帖用 push 加到 posts 末尾，最多保留 30 条，多了删最旧的。
- author 为 "me" 的帖子和评论，以及 "liked": true、"reposted": true，都是玩家自己的动作。让其他人注意到并回应它们。你自己永远不要写 author 为 "me" 的内容。
- 所有文字用故事的语言写。`,
    },
    en: {
      name: "Feed",
      description: "The story world's public square: people post about what happens, and a trending list shows where opinion is going, rumours about you included. Likes, reposts and comments cost no turn.",
      variableName: "App · Feed",
      rules: `A "Feed" app: this world's public social network. Shape: {"trending": [{"id", "title": topic, "heat": text such as "12.4k posts", "tag": "hot"|"new"|"rising"|""}], "posts": [{"id", "author", "handle", "text", "time", "likes", "reposts", "liked", "reposted", "comments": [{"author", "text"}]}]}.
- At the opening, seed a few posts and 3-5 trending topics that fit the story, so the feed is alive the first time it is opened.
- When something public happens in the story (someone is seen, a statement goes out, word spreads), change 1-3 things most turns: NPCs, bystanders and gossip accounts post or comment, and the trending order and heat follow public opinion. Rumours may be half true. Push new posts to the end of posts; keep at most 30 and delete the oldest.
- Posts and comments with author "me", and "liked": true or "reposted": true, are the player's own actions. Let others notice and react to them. Never write anything with author "me" yourself.
- Write all text in the story's language.`,
    },
    es: {
      name: "Tendencias",
      description: "La plaza pública del mundo de la historia: la gente comenta lo que pasa y las tendencias muestran hacia dónde va la opinión, rumores sobre ti incluidos. Los me gusta, compartidos y comentarios no gastan turno.",
      variableName: "App · Tendencias",
      rules: `Una app de "Tendencias": la red social pública de este mundo. Forma: {"trending": [{"id", "title": tema, "heat": texto como "8,2 mil publicaciones", "tag": "hot"|"new"|"rising"|""}], "posts": [{"id", "author", "handle", "text", "time", "likes", "reposts", "liked", "reposted", "comments": [{"author", "text"}]}]}.
- En la apertura, crea unas cuantas publicaciones y 3-5 tendencias que encajen con la historia, para que la app esté viva desde la primera vez.
- Cuando pase algo público en la historia (alguien es visto, sale un comunicado, se corre la voz), cambia 1-3 cosas en la mayoría de los turnos: personajes, curiosos y cuentas de chismes publican o comentan, y el orden y el calor de las tendencias siguen a la opinión pública. Los rumores pueden ser medio ciertos. Añade las publicaciones nuevas con push al final de posts; guarda como máximo 30 y borra las más antiguas.
- Las publicaciones y comentarios con author "me", y "liked": true o "reposted": true, son acciones del propio jugador. Haz que los demás las noten y reaccionen. Nunca escribas tú nada con author "me".
- Escribe todo el texto en el idioma de la historia.`,
    },
  },
};

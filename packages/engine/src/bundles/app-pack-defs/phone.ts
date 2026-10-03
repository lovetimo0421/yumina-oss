import type { AppPackDef } from "../app-pack-types.js";

export const phone: AppPackDef = {
  icon: "💬",
  variableId: "app_phone",
  defaultValue: { threads: {}, moments: [] },
  sample: {
    zh: {
      threads: {
        luyan: { name: "陆衍", unread: 2, messages: [
          { from: "them", text: "到家了。今天拍到腿软。", time: "23:40" },
          { from: "me", text: "早点睡，别刷热搜。" },
          { from: "them", text: "想你了。", time: "23:46" },
          { from: "them", text: "要是你在就好了。", time: "23:46" },
        ] },
        xiaoyu: { name: "林小瑜", unread: 0, messages: [{ from: "them", text: "姐妹！！你看热搜没？？他机场那身在榜三！", time: "22:31" }] },
        zhao: { name: "赵姐", unread: 0, messages: [{ from: "them", text: "明天的拍摄别来片场。", time: "19:02" }] },
      },
      moments: [
        { id: "m2", author: "林小瑜", text: "火锅局缺一个人，懂的来。", time: "20:02", likes: 12, liked: false, comments: [] },
        { id: "m1", author: "陆衍", text: "收工。今晚的月亮很像某个人。", time: "22:10", likes: 1203, liked: true, comments: [{ author: "林小瑜", text: "某个人是谁啊～" }] },
      ],
    },
    en: {
      threads: {
        hina: { name: "Hina", unread: 1, messages: [
          { from: "them", text: "Are you coming to the rooftop?", time: "16:05" },
          { from: "me", text: "Give me five minutes." },
          { from: "them", text: "I'll wait. Don't be late this time.", time: "16:18" },
        ] },
        rin: { name: "Rin", unread: 0, messages: [{ from: "them", text: "You still owe me those notes.", time: "12:40" }] },
      },
      moments: [{ id: "m1", author: "Rin", text: "Top of the class again. Some people should try harder.", time: "15:30", likes: 23, liked: false, comments: [] }],
    },
    es: {
      threads: {
        daigo: { name: "Daigo", unread: 2, messages: [
          { from: "them", text: "¿Dónde estás?", time: "19:12" },
          { from: "me", text: "Saliendo del trabajo." },
          { from: "them", text: "Te recojo. No discutas.", time: "19:25" },
          { from: "them", text: "Hay luna llena.", time: "19:25" },
        ] },
        haruo: { name: "Haruo", unread: 0, messages: [{ from: "them", text: "Dejé la cena en la nevera.", time: "18:03" }] },
      },
      moments: [{ id: "m1", author: "Haruo", text: "Luna llena otra vez. Cierren bien las ventanas.", time: "18:40", likes: 8, liked: false, comments: [] }],
    },
  },
  words: {
    zh: {
      name: "手机",
      description: "和角色发消息、看他们发的朋友圈，样子跟微信一样。角色会主动找你；你发的消息算一回合，点赞和评论不花回合。",
      variableName: "App · 手机",
      rules: `"手机"App。数据形状：{"threads": {"<id>": {"name": 名字, "unread": 未读数, "messages": [{"from": "them" 或 "me", "text", "time": "HH:MM"}]}}, "moments": [{"id", "author", "text", "time", "likes", "liked", "comments": [{"author", "text"}]}]}。
- 角色不在身边时，会用手机主动联系玩家：想念、吵架后的试探、通知、八卦、深夜的一句话。有这种时机就发，不要等玩家先开口。把消息 push 到 threads.<id>.messages，from 写 "them"，并把这条对话的 unread 加 1。对话不存在就先用 merge 建好，<id> 和你在别处用来指这个角色的键保持一致。
- 玩家以"（用手机发消息给某某）"开头的行动，是 TA 在手机上发出的消息，已经存进对话里了。回复写进对话，不要写成旁白，除非那个角色就在身边。
- 角色生活里有事发生时，偶尔发一条朋友圈（push 到 moments，最多保留 20 条，多了删最旧的）。
- "liked": true 和 author 为 "me" 的评论是玩家的反应，让角色注意到、回应。你自己永远不要写 from 或 author 为 "me" 的内容。
- 所有文字用故事的语言写。`,
    },
    en: {
      name: "Phone",
      description: "Text the characters and see what they post, in a messenger that looks like the one on your phone. Characters reach out first; a text you send is a turn, likes and comments are free.",
      variableName: "App · Phone",
      rules: `A "Phone" app. Shape: {"threads": {"<id>": {"name", "unread", "messages": [{"from": "them" or "me", "text", "time": "HH:MM"}]}}, "moments": [{"id", "author", "text", "time", "likes", "liked", "comments": [{"author", "text"}]}]}.
- Characters who are not with the player reach out by phone on their own: missing them, testing the water after a fight, news, gossip, a late-night line. When the moment is right, text first; don't wait for the player. Push the message to threads.<id>.messages with from "them" and add 1 to that thread's unread. If the thread does not exist yet, merge it in first, using the same key you use for that character elsewhere.
- Player actions that begin with "(texts NAME)" are texts the player sent from the phone; they are already saved in the thread. Answer inside the thread, not in narration, unless the character is physically there.
- Characters post to moments now and then when something happens in their life (push; keep at most 20, delete the oldest).
- "liked": true and comments with author "me" are the player's reactions; let the characters notice and respond. Never write anything with from or author "me" yourself.
- Write all text in the story's language.`,
    },
    es: {
      name: "Teléfono",
      description: "Escribe a los personajes y mira lo que publican, en un chat como el de tu móvil. Ellos también te escriben primero; enviar un mensaje es un turno, los me gusta y comentarios no.",
      variableName: "App · Teléfono",
      rules: `Una app de "Teléfono". Forma: {"threads": {"<id>": {"name", "unread", "messages": [{"from": "them" o "me", "text", "time": "HH:MM"}]}}, "moments": [{"id", "author", "text", "time", "likes", "liked", "comments": [{"author", "text"}]}]}.
- Los personajes que no están con el jugador le escriben por su cuenta: que lo extrañan, tanteos después de una pelea, noticias, chismes, una frase de madrugada. Cuando llegue el momento, escribe tú primero; no esperes al jugador. Haz push a threads.<id>.messages con from "them" y suma 1 al unread de esa conversación. Si la conversación no existe, créala primero con merge, usando la misma clave que usas para ese personaje en otros sitios.
- Las acciones del jugador que empiezan con "(le escribe a NOMBRE por el móvil)" son mensajes enviados desde el teléfono; ya están guardados en la conversación. Responde dentro de la conversación, no en la narración, salvo que el personaje esté presente.
- Los personajes publican en moments de vez en cuando, cuando les pasa algo (push; guarda como máximo 20 y borra el más antiguo).
- "liked": true y los comentarios con author "me" son reacciones del jugador; haz que los personajes las noten y respondan. Nunca escribas tú nada con from o author "me".
- Escribe todo el texto en el idioma de la historia.`,
    },
  },
};

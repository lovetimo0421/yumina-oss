// The host's own confirmation before the recap folds a long backlog on the
// player's mushies. Shown by the parent page, not the sandbox, so card code
// cannot start a paid run by calling the bridge (world-renderer recapBackfill).

type Copy = { title: string; description: string; confirm: string };

// The count is left out: the panel already shows how many the AI cannot see,
// and the backlog it prices can differ by the few that fold on their own.
export function recapBackfillConfirmCopy(language: string | undefined, credits: number | null): Copy {
  const c = credits == null ? null : credits.toLocaleString();
  const lang = (language ?? "en").toLowerCase();
  if (/^zh[-_](hant|tw|hk|mo)/.test(lang)) {
    return {
      title: "補上前情提要？",
      description: c
        ? `把看不到的舊劇情整理進前情提要，約 ${c} 蘑菇幣，一次性。`
        : `把看不到的舊劇情整理進前情提要，用你自己的 key 或會員額度。`,
      confirm: "補上",
    };
  }
  if (lang.startsWith("zh")) {
    return {
      title: "补上前情提要？",
      description: c
        ? `把看不到的旧剧情整理进前情提要，约 ${c} 蘑菇币，一次性。`
        : `把看不到的旧剧情整理进前情提要，用你自己的 key 或会员额度。`,
      confirm: "补上",
    };
  }
  if (lang.startsWith("ja")) {
    return {
      title: "あらすじに追加しますか？",
      description: c
        ? `見えていない古い場面をあらすじに追加。約 ${c} キノココイン（1 回のみ）。`
        : `見えていない古い場面をあらすじに追加。あなたのキーまたはプランで実行。`,
      confirm: "追加する",
    };
  }
  if (lang.startsWith("es")) {
    return {
      title: "¿Añadir al resumen?",
      description: c
        ? `Añade al resumen las escenas que la IA ya no ve. Unas ${c} setas, una vez.`
        : `Añade al resumen las escenas que la IA ya no ve, con tu clave o tu plan.`,
      confirm: "Añadir",
    };
  }
  return {
    title: "Add them to the recap?",
    description: c
      ? `Adds the scenes the AI no longer sees to the recap. About ${c} mushies, once.`
      : `Adds the scenes the AI no longer sees to the recap, on your own key or plan.`,
    confirm: "Add them",
  };
}

/** A fold this cheap runs without asking (the server holds the same line). */
export const RECAP_FOLD_FREE_CREDITS = 5;

type FoldCopy = Copy & { nothing: string };

// The host's confirmation before folding the oldest N messages the player
// picked in the memory panel, when it costs more than a few mushies.
export function recapFoldConfirmCopy(language: string | undefined, credits: number | null, messages: number): FoldCopy {
  const c = credits == null ? "" : credits.toLocaleString();
  const n = messages.toLocaleString();
  const lang = (language ?? "en").toLowerCase();
  if (/^zh[-_](hant|tw|hk|mo)/.test(lang)) {
    return { title: "整理進前情提要？", description: `把最早的 ${n} 條整理進前情提要，約 ${c} 蘑菇幣。`, confirm: "整理", nothing: "現在沒有可以整理的" };
  }
  if (lang.startsWith("zh")) {
    return { title: "整理进前情提要？", description: `把最早的 ${n} 条整理进前情提要，约 ${c} 蘑菇币。`, confirm: "整理", nothing: "现在没有可以整理的" };
  }
  if (lang.startsWith("ja")) {
    return { title: "あらすじにまとめますか？", description: `最も古い ${n} 件をあらすじにまとめます。約 ${c} キノココイン。`, confirm: "まとめる", nothing: "まとめられるものはまだありません" };
  }
  if (lang.startsWith("es")) {
    return { title: "¿Pasar al resumen?", description: `Pasa los ${n} mensajes más antiguos al resumen. Unas ${c} setas.`, confirm: "Resumir", nothing: "Aún no hay nada que resumir" };
  }
  return { title: "Fold into the recap?", description: `Folds the oldest ${n} messages into the recap. About ${c} mushies.`, confirm: "Fold", nothing: "Nothing to fold yet" };
}

import type { ToolDefinition } from "../llm/types.js";

/** Kept apart from lib/card-translate-job.ts so the tool lists can import it without the job's dependencies. */
const LANGS = ["en", "zh", "es", "ko", "id", "ru"] as const;
export const TRANSLATE_CARD_TOOL_NAME = "translate_card";
export const TRANSLATE_CARD_DEFINITION: ToolDefinition = {
  type: "function",
  function: {
    name: TRANSLATE_CARD_TOOL_NAME,
    description: "Make a version of this card in another language (en, zh, es, ko, id or ru) with AI: every text, keyword and interface label is translated, ids, directives and state values are kept, and the result is a DRAFT language version in the same group for the creator to check and publish. It COSTS the creator mushies. First call it with just `language`: you get the price. Tell the creator the price and run it (confirm: true) only after they agree. It takes a few minutes and returns a jobId: check it later with jobId alone. The creator can also do this from the language menu in the top bar (AI 翻译成其他语言).",
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", enum: [...LANGS], description: "Target language." },
        confirm: { type: "boolean", description: "true only after the creator agreed to the quoted price." },
        update: { type: "boolean", description: "The card already has a version in that language and the creator wants it refreshed from this card (after editing this one): re-translates into that version as a draft update. Same quote/confirm steps." },
        jobId: { type: "string", description: "Check a translation started earlier (pass it alone)." },
      },
    },
  },
};


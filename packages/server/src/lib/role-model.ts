import { sessionModelChoice, type PlayerTextAiRole } from "@yumina/shared";
import { DEFAULT_SESSION_MEMORY_MODEL, DEFAULT_STORY_SUMMARY_MODEL } from "./background-model-defaults.js";
import { applyModelRedirect } from "./llm/model-redirects.js";
import { loadPlayerRoleModel } from "./player-ai-config.js";

/**
 * Which model a background AI runs on. One order everywhere: the author's pick
 * for that AI (world AIs only), then this chat's own pick, then the player's
 * default for that kind of AI (Generation Config), then the platform default.
 *
 * Background jobs keep writing a model into the session's column, and their
 * claim guards compare against it, so a chat's "own pick" is any saved value
 * other than the platform default. The player's default is applied at run time
 * and never saved into a chat, so changing it reaches every chat that has not
 * picked its own.
 */

type ChatRole = Extract<PlayerTextAiRole, "memory" | "summary">;

function platformDefault(role: ChatRole): string {
  return role === "memory" ? DEFAULT_SESSION_MEMORY_MODEL : DEFAULT_STORY_SUMMARY_MODEL;
}

/** What a chat that has not picked its own model uses for this role. */
export async function followedModel(userId: string, role: PlayerTextAiRole, fallback: string): Promise<string> {
  const preferred = await loadPlayerRoleModel(userId, role);
  return preferred ? applyModelRedirect(preferred.trim()) : fallback;
}

/** The model a chat's memory or summary AI runs on right now. */
export async function chatRunModel(userId: string, role: ChatRole, saved: string | null | undefined): Promise<string> {
  const own = sessionModelChoice(saved ? applyModelRedirect(saved.trim()) : null, platformDefault(role));
  return own ?? followedModel(userId, role, platformDefault(role));
}

/**
 * A model a request names for one chat, if it is a real pick for that chat.
 * Panels send their current model with every save; when that is just what the
 * chat already follows, saving it would freeze the chat on today's default.
 * Once the chat has its own pick, any model sent is a change of pick, the
 * platform default included: dropping that one kept the old pick, so choosing
 * the default in the model menu snapped back.
 */
export async function chatModelPick(userId: string, role: ChatRole, sent: string | null | undefined, saved: string | null | undefined): Promise<string | null> {
  const model = sent?.trim() ? applyModelRedirect(sent.trim()) : null;
  if (!model) return null;
  if (sessionModelChoice(saved, platformDefault(role))) return model;
  const pick = sessionModelChoice(model, platformDefault(role));
  if (!pick) return null;
  return pick === await followedModel(userId, role, platformDefault(role)) ? null : pick;
}

/**
 * The model a story summary runs on (`run`), and the value the session's
 * summaryModel column keeps (`keep`). `requested` is a model this one request
 * names, such as a manual compaction from the memory panel.
 */
export async function storySummaryModels(userId: string, saved: string | null | undefined, requested?: string | null): Promise<{ run: string; keep: string }> {
  const pick = await chatModelPick(userId, "summary", requested, saved);
  const keep = applyModelRedirect((pick || saved?.trim() || DEFAULT_STORY_SUMMARY_MODEL).trim());
  return { run: pick ?? await chatRunModel(userId, "summary", saved), keep };
}

/** The model for an AI inside a card's situation that has no model in the request. */
export async function worldAiModel(userId: string, authorModel: string | null | undefined, sessionSummaryModel: string | null | undefined): Promise<string> {
  return (
    authorModel?.trim()
    || sessionModelChoice(sessionSummaryModel, DEFAULT_STORY_SUMMARY_MODEL)
    || (await followedModel(userId, "world", DEFAULT_STORY_SUMMARY_MODEL))
  ).trim();
}

import { DEFAULT_BACKGROUND_MODEL } from "@yumina/shared";

// Models for background AIs nobody picked a model for. Their own module so
// role-model.ts can read them without importing the jobs that use them.

// Cheap, fast, CJK-aware background summarizer. Aligns its tokenizer with the
// default CJK-aware play model (anthropic/claude-sonnet-4.6) so the compaction
// window and the prompt budget agree on Chinese token counts. (Was
// x-ai/grok-4.1-fast, now deprecated → silently redirected to the ~20x-pricier
// x-ai/grok-4.20; see DEPRECATED_MODEL_REDIRECTS in routes/messages.ts.)
export const DEFAULT_STORY_SUMMARY_MODEL = DEFAULT_BACKGROUND_MODEL;

// See DEFAULT_STORY_SUMMARY_MODEL: cheap, CJK-aware, and not the deprecated
// x-ai/grok-4.1-fast (which redirects to the ~20x-pricier x-ai/grok-4.20).
export const DEFAULT_SESSION_MEMORY_MODEL = DEFAULT_BACKGROUND_MODEL;

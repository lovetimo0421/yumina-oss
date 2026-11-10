import { z } from "zod";

export const MAX_DECISION_REQUEST_CHARS = 32_000;
const labelSchema = z.string().min(1).max(128).refine(value => !["__proto__", "constructor", "prototype"].includes(value));
const choiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string().min(1).max(4096),
  criteria: z.record(labelSchema, z.string().min(1).max(2048)).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 64),
}).strict();

/** A small JSON observation, including bounded nesting and individual strings.
 * Iterative inspection keeps deeply nested hostile input away from recursion. */
function boundedState(state: Record<string, unknown>): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value: state, depth: 0 }];
  const seen = new Set<object>();
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (depth > 12) return false;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "string") { if (value.length > 16_000) return false; continue; }
    if (typeof value === "number") { if (!Number.isFinite(value)) return false; continue; }
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    const entries = Object.entries(value);
    if (entries.length > 1024) return false;
    for (const [key, child] of entries) {
      if (key.length > 128 || ["__proto__", "constructor", "prototype"].includes(key)) return false;
      pending.push({ value: child, depth: depth + 1 });
    }
  }
  return true;
}

export const aiDecisionRequestSchema = z.object({
  state: z.record(z.unknown()).refine(boundedState),
  questions: z.record(labelSchema, choiceQuestionSchema).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 8),
}).strict();

export type AiDecisionRequest = z.infer<typeof aiDecisionRequestSchema>;
export type AiChoiceQuestion = AiDecisionRequest["questions"][string];
export interface AiChoiceAnswer {
  type?: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface AiDecisionResponse { answers: Record<string, AiChoiceAnswer> }

const probabilitySchema = z.number().finite().min(0).max(1);
const choiceAnswerSchema = z.object({
  type: z.literal("choice").optional(),
  choice: labelSchema,
  probabilities: z.record(labelSchema, probabilitySchema),
  confidence: probabilitySchema,
});

/** All requested questions and criteria must be present. Missing confidence or
 * probabilities is a failed decision, never synthesized certainty. Extra
 * provider metadata is stripped before reaching untrusted card code. */
export function parseAiDecisionResponse(value: unknown, questions: AiDecisionRequest["questions"]): AiDecisionResponse | null {
  const parsed = z.object({ answers: z.record(labelSchema, choiceAnswerSchema) }).safeParse(value);
  if (!parsed.success || Object.keys(parsed.data.answers).length !== Object.keys(questions).length) return null;
  for (const [id, question] of Object.entries(questions)) {
    const answer = parsed.data.answers[id];
    if (!answer || !Object.hasOwn(question.criteria, answer.choice)) return null;
    const labels = Object.keys(question.criteria);
    if (Object.keys(answer.probabilities).length !== labels.length || labels.some(label => !Object.hasOwn(answer.probabilities, label))) return null;
  }
  return parsed.data;
}

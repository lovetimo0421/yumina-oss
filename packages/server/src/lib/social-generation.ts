import { socialJobContext, socialResponseSchema, type SocialJob, type SocialState } from "@yumina/engine";
import { buildSocialReplyPrompt, renderSocialContext } from "./social-reply-prompt.js";

type PromptArgs = Parameters<typeof buildSocialReplyPrompt>;
export type SocialCompletionMessages = Array<{ role: "system" | "user"; content: string }>;

/** Only retrieve records safe for the destination audience. This stops a private
 *  exchange reaching an uninvolved character, including via an accidental public
 *  disclosure by its original recipient. No stored memory is erased.
 *  A one-to-one DM keeps the character's own cross-surface recall. */
function audienceState(state: SocialState, job: SocialJob): SocialState {
    if (job.kind !== "message") return { ...state, conversations: [] };
    const current = state.conversations.find(c => c.id === job.targetId);
    if (!current) throw new Error("Conversation not found");
    if (!current.channel && current.members.length === 1) return state;
    return { ...state, conversations: state.conversations.map(c => ({
        ...c,
        messages: c.messages.filter(m => current.members.every(id => (m.audience ?? c.members).includes(id))),
    })) };
}

/** The audience boundary is enforced before prompt assembly, not by asking the
 *  model to keep several private buckets separate. Everything sent to a group
 *  is known to the whole group, and public requests contain no private records.
 *  This lets the cast respond naturally in one billed call without per-character
 *  latency/cost or a forced reply from the first character in every batch. */
export async function generateSocialReplies(
    state: SocialState, job: SocialJob, lore: PromptArgs[1], persona: PromptArgs[2], guidance: PromptArgs[3],
    complete: (messages: SocialCompletionMessages) => Promise<unknown>,
) {
    const visibleState = audienceState(state, job);
    const result = await complete([
        { role: "system", content: buildSocialReplyPrompt(job, lore.filter(p => job.members.includes(p.id)), persona, guidance, state.selected) },
        { role: "user", content: renderSocialContext(socialJobContext(visibleState, job)) },
    ]);
    // The engine applies per-surface cardinality, member and replay checks again
    // under the session lock before anything is persisted.
    return socialResponseSchema.parse(result);
}

/** The completion owns its reader and cancellation listener. */
export async function readSocialCompletion(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? "Generation failed");
    }
    if (!response.body) throw new Error("Generation returned no response");
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
        let buffer = "", event = "", content: string | undefined;
        const decoder = new TextDecoder();
        while (!signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                if (line.startsWith("data:")) {
                    const data = JSON.parse(line.slice(5));
                    if (event === "error") throw new Error(data.error ?? "Generation failed");
                    if (event === "done") content = data.content;
                    event = "";
                }
            }
            if (content !== undefined) break;
        }
        if (signal.aborted || !content) throw new Error("Generation cancelled or timed out");
        return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    } finally {
        signal.removeEventListener("abort", abort);
        void reader.cancel().catch(() => {});
    }
}

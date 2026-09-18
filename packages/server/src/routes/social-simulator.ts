import { mutateSocialSession } from "../lib/social-simulator-state.js";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { applySocialAction, claimSocialJob, finishSocialJob, initialSocialState, socialConfigSchema, socialReplyBatch, type SocialState } from "@yumina/engine";
import { db } from "../db/index.js";
import { playSessions, worlds } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";
import { resolveSessionWorldSchema } from "../lib/pending-edit.js";
import { completionRoutes } from "./completions.js";
import { selectSocialGuidance, type SocialGuidanceEntry } from "../lib/social-reply-prompt.js";
import { generateSocialReplies, readSocialCompletion } from "../lib/social-generation.js";
import { resolvePersonaForSession } from "../lib/resolve-persona.js";
export const socialSimulatorRoutes = new Hono<AppEnv>();
socialSimulatorRoutes.use("/*", authMiddleware);
const running = new Map<string, AbortController>();
/** Also bounds provider preflight, before an SSE reader exists. */
function abortableResponse(work: Promise<Response> | Response, signal: AbortSignal): Promise<Response> {
    return new Promise((resolve, reject) => {
        const aborted = () => reject(new Error("Generation cancelled or timed out"));
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted)
            aborted();
        Promise.resolve(work).then(response => {
            if (signal.aborted)
                void response.body?.cancel().catch(() => { });
            else
                resolve(response);
        }, reject).finally(() => signal.removeEventListener("abort", aborted));
    });
}
async function context(sessionId: string, userId: string) {
    const [session] = await db.select().from(playSessions).where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)));
    if (!session)
        throw new Error("Session not found");
    const [world] = await db.select().from(worlds).where(eq(worlds.id, session.worldId));
    if (!world)
        throw new Error("World not found");
    const schema = await resolveSessionWorldSchema(world, userId) as {
        variables?: Array<{
            id: string;
            defaultValue?: unknown;
        }>;
        entries?: SocialGuidanceEntry[];
    };
    const config = socialConfigSchema.parse(schema.variables?.find(v => v.id === "social-config")?.defaultValue);
    return { session, config, schema };
}
socialSimulatorRoutes.get("/:sessionId/social", async (c) => {
    const ctx = await context(c.req.param("sessionId"), c.get("user").id);
    const state = await mutateSocialSession(c.req.param("sessionId"), c.get("user").id, initialSocialState(ctx.config), previous => previous);
    return c.json({ state, profiles: ctx.config.profiles, replyCounts: ctx.config.replyCounts ?? {} });
});
socialSimulatorRoutes.post("/:sessionId/social/action", async (c) => {
    const userId = c.get("user").id, sessionId = c.req.param("sessionId");
    const ctx = await context(sessionId, userId), action = await c.req.json();
    const state = await mutateSocialSession(sessionId, userId, initialSocialState(ctx.config), previous => applySocialAction(previous, action, ctx.config, new Date().toISOString()));
    return c.json({ state });
});
const generationInput = z.object({ jobId: z.string().min(1).max(100), attempt: z.string().uuid(), model: z.string().min(1).max(200), cancel: z.boolean().optional() });
socialSimulatorRoutes.post("/:sessionId/social/generate", async (c) => {
    const userId = c.get("user").id, sessionId = c.req.param("sessionId");
    const input = generationInput.parse(await c.req.json());
    const ctx = await context(sessionId, userId);
    let claimed = false;
    const key = `${sessionId}:${input.jobId}`;
    const state = await mutateSocialSession(sessionId, userId, initialSocialState(ctx.config), previous => {
        const result = claimSocialJob(previous, input, Date.now());
        claimed = result.claimed;
        return result.state;
    });
    if (input.cancel) {
        running.get(key)?.abort();
        return c.json({ state });
    }
    if (!claimed)
        return c.json({ state });
    const job = socialReplyBatch(state.jobs.find(j => j.id === input.jobId)!);
    const batchOffset = job.completedCount ?? 0;
    const controller = new AbortController();
    running.set(key, controller);
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
        const lore = ctx.config.profiles.filter(p => job.members.includes(p.id)).map(p => ({
            id: p.id, name: p.name, lore: ctx.schema.entries?.find(e => e.id === p.loreEntryId)?.content?.slice(0, 6000) ?? "",
        }));
        const persona = await resolvePersonaForSession(ctx.session);
        // The creator's Task/Style/world entries ride along with the character
        // sheets; only per-profile lore was forwarded before, so authors could
        // not shape the register at all.
        const guidance = selectSocialGuidance(ctx.schema.entries, ctx.config.profiles.map(p => p.loreEntryId), persona?.name);
        // Filter memory by destination audience before using the existing
        // billed/rate-limited completion path.
        const headers = new Headers(c.req.raw.headers);
        headers.set("Content-Type", "application/json");
        headers.delete("content-length");
        const json = await generateSocialReplies(state, job, lore, persona, guidance, async messages => {
            if (controller.signal.aborted) throw new Error("Generation cancelled or timed out");
            const response = await abortableResponse(completionRoutes.request(`http://internal/sessions/${sessionId}/completions`, {
                method: "POST", headers, signal: controller.signal,
                body: JSON.stringify({ model: input.model, maxTokens: Math.max(1400, job.members.length * 500), temperature: 0.9, messages }),
            }), controller.signal);
            return readSocialCompletion(response, controller.signal);
        });
        const next = await mutateSocialSession(sessionId, userId, initialSocialState(ctx.config), s => s.epoch === state.epoch ? finishSocialJob(s, input.jobId, input.attempt, json, new Date().toISOString(), batchOffset) : s);
        return c.json({ state: next });
    }
    catch (error) {
        controller.abort();
        const next = await mutateSocialSession(sessionId, userId, initialSocialState(ctx.config), s => {
            const next = structuredClone(s), j = next.jobs.find(j => j.id === input.jobId);
            if (s.epoch !== state.epoch || !j || j.status !== "running" || j.attempt !== input.attempt || (j.completedCount ?? 0) !== batchOffset)
                return s;
            j.status = "error";
            j.error = error instanceof Error ? error.message.slice(0, 300) : "Generation failed";
            next.revision++;
            return next;
        });
        return c.json({ state: next });
    }
    finally {
        clearTimeout(timer);
        if (running.get(key) === controller)
            running.delete(key);
    }
});
socialSimulatorRoutes.onError((error, c) => c.json({ error: error instanceof z.ZodError ? "Invalid social action or card configuration" : error.message }, error.message.includes("not found") ? 404 : 400));

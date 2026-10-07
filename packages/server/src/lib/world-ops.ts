import { and, eq } from "drizzle-orm";
import { migrateWorldDefinition, resolveStation, type WorldDefinition } from "@yumina/engine";
import { readOwn } from "../db/index.js";
import { worlds } from "../db/schema.js";
import type { ToolDefinition } from "./llm/types.js";
import { resolveWorkingSchema, writeStudioWorldSchema } from "./pending-edit.js";
import { getSkillContent } from "./studio-skills/index.js";
import { outsideCorePrompt } from "./studio-tools/system-prompt.js";
import { loadAssetCatalog } from "./studio-tools/asset-catalog.js";
import { parseToolArgs } from "./studio-tools/parse-tool-args.js";
import { runPlaytest } from "./studio-tools/playtest-runner.js";
import {
  executeAnalyzeTokenCost,
  executeApplyChanges,
  executeGrepWorld,
  executeReadEntities,
  executeValidateWorld,
  toolCallsToSchemaChanges,
} from "./studio-tools/tool-executor.js";
import { STUDIO_TOOLS } from "./studio-tools/tools.js";
import { executeReadUiDoc } from "./studio-tools/ui-doc-tools.js";
import { publishWorldEvent } from "./world-events.js";
import { PLAYTEST_TURNS_PER_HOUR, snapshotBeforeOutsideWrite, takePlaytestTurns } from "./outside-ai-guards.js";
import { GENERATE_IMAGE, SET_COVER, runGenerateImage, runSetCover } from "./outside-ai-media.js";
import { SCREENSHOT_UI, isScreenshotEnabled, runScreenshot } from "./outside-ai-screenshot.js";
import { stickyNotes } from "./studio-tools/sticky-notes.js";

/**
 * World ops — one set of operations on a card, for any AI that is not ours.
 *
 * These ARE the Studio assistant's tools: the same names, schemas and
 * executor, so an outside agent and the in-editor assistant cannot drift
 * apart. Served by /api/agent/v1 as REST and as a remote MCP server. Writes go
 * through the same save path as the assistant's (a published card's edit is
 * held, a concurrent editor save is merged), and every write is pushed to the
 * open editor.
 */

/** Read-only overview — the assistant gets this as its system prompt; an
 *  outside agent asks for it first. */
const GET_WORLD: ToolDefinition = {
  type: "function",
  function: {
    name: "get_world",
    description:
      "Start here. The card's directory: every entry, variable, behavior, situation (worldbook) and interface file, by id and name, plus how each situation's AI is woken. Read an item in full with read_entities; learn how Yumina cards are written with load_skill.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

/** The assistant's load_skill says the core skills are already in its prompt;
 *  an outside agent has none of them, and a long skill must come in pages
 *  that fit a tool result (Claude Code caps one at ~25k tokens). */
const SKILL_NAMES = ["core", "entries", "variables", "rules", "tsx", "front-ui", "world-design", "lore", "audio", "slim", "ui-doc"];
const SKILL_PAGE_CHARS = 24_000;
/** Tools a skill may name that only the Studio assistant has (it talks to the creator in Studio). */
const STUDIO_ONLY_TOOLS = ["ask_user", "propose_job"];
const LOAD_SKILL: ToolDefinition = {
  type: "function",
  function: {
    name: "load_skill",
    description:
      "How Yumina cards are written. Load core once before your first write in a conversation (how to plan, write and check a card), and a kind's skill before writing that kind of thing: entries (lore & characters), variables, rules (behaviors), tsx (the card's interface code), front-ui (interface design), world-design (structuring a whole card), lore, audio, ui-doc (editing a card's ready-made interface: parts, knobs, openings), slim (cutting what a card sends every turn). Long skills come in pages: the first page says how many; ask for the next with page.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", enum: SKILL_NAMES },
        page: { type: "number", description: "1-based page, default 1." },
      },
      required: ["name"],
    },
  },
};

const SET_CARD_NAME: ToolDefinition = {
  type: "function",
  function: {
    name: "set_card_name",
    description: "Rename the card (the title players see).",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
};

/** Split a skill at its "## " headings into pages of at most SKILL_PAGE_CHARS. */
function skillPages(content: string): string[] {
  const parts = content.split(/\n(?=## )/);
  const pages: string[] = [];
  let cur = "";
  for (const part of parts) {
    const piece = cur ? "\n" + part : part;
    if (cur && cur.length + piece.length > SKILL_PAGE_CHARS) { pages.push(cur); cur = part; } else cur += piece;
  }
  if (cur) pages.push(cur);
  // A single section longer than a page is cut at the page size.
  return pages.flatMap((p) => {
    const out: string[] = [];
    for (let i = 0; i < p.length; i += SKILL_PAGE_CHARS) out.push(p.slice(i, i + SKILL_PAGE_CHARS));
    return out;
  });
}

const PICKED_READS = ["read_entities", "grep_world", "load_skill", "list_assets", "read_ui_doc", "validate_world", "analyze_token_cost"];
const PICKED_WRITES = [
  "write_entry", "write_variable", "write_behavior", "write_worldbook", "write_custom_ui", "edit_custom_ui",
  "edit_ui_doc", "set_ui_knobs", "write_ui_knob_groups", "write_audio", "write_scene_image", "update_settings",
  "write_lore_binding", "delete_entities",
];
const byName = new Map(STUDIO_TOOLS.map((t) => [t.function.name, t]));

/** Tools whose new things get an id minted when the caller gives none: the
 *  schema an outside agent sees must not demand one (MCP validates it). */
const ID_MINTED = new Set(["write_entry", "write_variable", "write_behavior", "write_worldbook"]);
function idOptional(tool: ToolDefinition): ToolDefinition {
  if (!ID_MINTED.has(tool.function.name)) return tool;
  const params = tool.function.parameters as { required?: string[] };
  if (!params.required?.includes("id")) return tool;
  return { ...tool, function: { ...tool.function, parameters: { ...params, required: params.required.filter((r) => r !== "id") } } };
}

/** What an outside agent may call. Jobs and questions to the creator stay with
 *  the in-editor assistant: they need the creator present. Images are
 *  generated directly (lib/outside-ai-media.ts), capped and billed as usual. */
export const WORLD_OPS: ToolDefinition[] = [
  GET_WORLD,
  ...PICKED_READS.map((n) => n === "load_skill" ? LOAD_SKILL : byName.get(n)!).filter(Boolean),
  SET_CARD_NAME,
  ...PICKED_WRITES.map((n) => byName.get(n)!).filter(Boolean).map(idOptional),
  byName.get("playtest")!,
  GENERATE_IMAGE,
  SET_COVER,
  ...(isScreenshotEnabled() ? [SCREENSHOT_UI] : []),
].filter(Boolean);

const WRITE_SET = new Set([...PICKED_WRITES, "set_card_name", "set_cover"]);
const MINTS_ID = new Set(["write_entry", "write_variable", "write_behavior", "write_worldbook"]);
const READ_SET = new Set(["get_world", ...PICKED_READS, "playtest", "generate_image", "screenshot_ui"]);

/** How an op touches the card, for MCP tool annotations. */
export function worldOpKind(name: string): "read" | "write" | "delete" | "run" {
  if (name === "delete_entities") return "delete";
  // A playtest or a picture changes nothing on the card but costs the creator.
  if (name === "playtest" || name === "generate_image" || name === "screenshot_ui") return "run";
  return WRITE_SET.has(name) ? "write" : "read";
}

export function isWorldOp(name: string): boolean {
  return WRITE_SET.has(name) || READ_SET.has(name);
}

async function loadWorking(worldId: string, userId: string): Promise<{ world: WorldDefinition; raw: Record<string, unknown>; updatedAt: number | null } | null> {
  const [row] = await (await readOwn(userId))
    .select({ schema: worlds.schema, status: worlds.status, updatedAt: worlds.updatedAt })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId)))
    .limit(1);
  if (!row) return null;
  const raw = await resolveWorkingSchema(worldId, row.status ?? "draft", (row.schema ?? {}) as Record<string, unknown>);
  return { world: migrateWorldDefinition(raw as unknown as WorldDefinition), raw, updatedAt: row.updatedAt?.getTime() ?? null };
}

function overview(world: WorldDefinition) {
  return {
    name: world.name,
    description: world.description,
    entries: (world.entries ?? []).map((e) => ({
      id: e.id, name: e.name, role: e.role, situation: e.worldbookId ?? null,
      sent: e.alwaysSend ? "every turn" : e.keywords?.length ? `on keywords: ${e.keywords.slice(0, 6).join(", ")}` : "conditions",
      chars: e.content?.length ?? 0,
    })),
    variables: (world.variables ?? []).map((v) => ({ id: v.id, name: v.name, type: v.type, default: v.defaultValue, situation: v.worldbookId ?? null })),
    behaviors: [...(world.rules ?? []).map((r) => ({ id: r.id, name: r.name })), ...(world.reactions ?? []).map((r) => ({ id: r.id, name: r.name }))],
    situations: (world.worldbooks ?? []).map((b) => {
      const st = resolveStation(b);
      return {
        id: b.id, name: b.name, activation: b.activation,
        ai: !st ? "none (its content joins whichever AI is speaking)"
          : st.kind === "narrator" ? "narrator (answers the player while active)"
          : `worker — wakes ${st.trigger ? JSON.stringify(st.trigger) : "never (no trigger)"}`,
      };
    }),
    interface: world.rootComponent ? { entryFile: world.rootComponent.entryFile, files: Object.keys(world.rootComponent.files ?? {}) } : null,
    // The creator's sticky notes: what a part is for, what to do with it.
    stickyNotes: stickyNotes(world),
  };
}

export interface OpResult { ok: boolean; result?: unknown; error?: string; image?: { data: string; mimeType: string } }

/** Run one op as `userId` on `worldId`. `actor` names the caller to the editor. */
export async function runWorldOp(args: { userId: string; worldId: string; name: string; args: unknown; actor: string }): Promise<OpResult> {
  const { userId, worldId, name, actor } = args;
  if (!isWorldOp(name)) return { ok: false, error: `Unknown tool "${name}". Call get_world, or list tools.` };
  const input = (typeof args.args === "string" ? parseToolArgs(args.args) : (args.args ?? {})) as Record<string, unknown>;

  if (name === "load_skill") {
    const content = input.name === "core" ? outsideCorePrompt() : getSkillContent(input.name as string);
    if (!content) return { ok: false, error: `No skill "${String(input.name)}". Names: ${SKILL_NAMES.join(", ")}.` };
    const pages = skillPages(content);
    const page = Math.min(Math.max(1, Math.floor(Number(input.page) || 1)), pages.length);
    const header = pages.length > 1 ? `[${String(input.name)} — page ${page} of ${pages.length}${page < pages.length ? `; next: load_skill with page ${page + 1}` : ""}]\n\n` : "";
    const text = pages[page - 1] ?? "";
    // core carries its own note about the Studio-only tools.
    const studioOnly = input.name === "core" ? [] : STUDIO_ONLY_TOOLS.filter((t) => new RegExp(`\\b${t}\\b`).test(text));
    const note = studioOnly.length ? `[Where this mentions ${studioOnly.join(" or ")}: that tool belongs to Yumina's built-in assistant. Ask the creator in your own chat instead.]\n\n` : "";
    return { ok: true, result: header + note + text };
  }

  // Every card op checks the card is the caller's own first. A signed-in
  // (OAuth) caller names the card itself, so nothing below may act on a
  // worldId before this.
  const loaded = await loadWorking(worldId, userId);
  if (!loaded) return { ok: false, error: "Card not found." };
  const { world } = loaded;

  if (name === "playtest") {
    const moves = (Array.isArray(input.moves) ? input.moves : [])
      .filter((m): m is string => typeof m === "string" && m.trim().length > 0)
      .map((m) => m.trim().slice(0, 2000)).slice(0, 10);
    if (moves.length === 0) return { ok: false, error: "Give 1-10 moves: what a player would type." };
    const allowed = takePlaytestTurns(userId, moves.length);
    if (allowed === 0) {
      return { ok: false, error: `Playtest limit reached: ${PLAYTEST_TURNS_PER_HOUR} turns per hour (each turn costs the creator what a real turn costs). Try again later.` };
    }
    try {
      const result = await runPlaytest({ userId, worldId, moves: moves.slice(0, allowed) });
      return { ok: true, result: allowed < moves.length ? { ...result, note: `Only ${allowed} of ${moves.length} moves were played: ${PLAYTEST_TURNS_PER_HOUR} playtest turns per hour.` } : result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (name === "generate_image") return runGenerateImage({ userId, worldId, input });
  if (name === "screenshot_ui") return runScreenshot({ userId, worldId, input });
  if (name === "set_cover") {
    const r = await runSetCover({ userId, worldId, input });
    if (r.ok) publishWorldEvent(worldId, { kind: "external-write", actor, tool: name, args: {}, ok: true, at: new Date().toISOString() });
    return r;
  }

  switch (name) {
    case "get_world": return { ok: true, result: overview(world) };
    case "list_assets": return { ok: true, result: await loadAssetCatalog(userId, worldId, input) };
    case "read_entities": return { ok: true, result: executeReadEntities(world, (input.ids as string[]) ?? [], { offset_lines: input.offset_lines as number | undefined, limit_lines: input.limit_lines as number | undefined }).results };
    case "grep_world": {
      const r = executeGrepWorld(world, { query: input.query as string, scope: input.scope as never, id: input.id as string | undefined, context_lines: input.context_lines as number | undefined });
      return r.error ? { ok: false, error: r.error } : { ok: true, result: r };
    }
    case "read_ui_doc": return { ok: true, result: executeReadUiDoc(world, { page: input.page as never, parts: input.parts as never }) };
    case "validate_world": return { ok: true, result: executeValidateWorld(world) };
    case "analyze_token_cost": return { ok: true, result: executeAnalyzeTokenCost(world) };
  }

  if (name === "set_card_name") {
    const next = typeof input.name === "string" ? input.name.trim().slice(0, 120) : "";
    if (!next) return { ok: false, error: "Give the new name." };
    await snapshotBeforeOutsideWrite({ worldId, userId, actor, schema: loaded.raw });
    const saved = await writeStudioWorldSchema({ worldId, creatorId: userId, schema: { ...loaded.raw, name: next } });
    publishWorldEvent(worldId, { kind: "external-write", actor, tool: name, args: { name: next }, ok: true, at: new Date().toISOString() });
    return { ok: true, result: { name: next, ...(saved.held ? { held: "The card is published: the new name waits with its other held changes." } : {}) } };
  }

  // A new thing without an id gets one: our assistant invents ids out of
  // habit, an outside agent should not have to know it must.
  const minted = MINTS_ID.has(name) && (typeof input.id !== "string" || !input.id.trim());
  if (minted) input.id = crypto.randomUUID();

  // A write: the assistant's own path, one call.
  const [parsed] =toolCallsToSchemaChanges([{ id: "op", function: { name, arguments: JSON.stringify(input) } }], world);
  if (!parsed || parsed.error || !parsed.change) return { ok: false, error: parsed?.error ?? "Could not read the arguments." };
  const applied = executeApplyChanges(world, [parsed.change]);
  if (!applied.success) return { ok: false, error: applied.summary };
  // The card as it was, in 改动记录, before this AI's first write of a task.
  await snapshotBeforeOutsideWrite({ worldId, userId, actor, schema: loaded.raw });
  const saved = await writeStudioWorldSchema({
    worldId, creatorId: userId, schema: applied.world as unknown as Record<string, unknown>,
    base: { schema: loaded.raw, updatedAt: loaded.updatedAt },
  });
  const conflicts = saved.rebased?.conflicts ?? [];
  publishWorldEvent(worldId, {
    kind: "external-write", actor, tool: name,
    args: Object.fromEntries(Object.entries(input).filter(([k]) => ["id", "name", "ids", "path", "file"].includes(k))),
    ok: true, at: new Date().toISOString(),
  });
  return {
    ok: true,
    result: {
      ...(applied.results[0] ?? {}),
      ...(minted ? { id: input.id } : {}),
      ...(saved.held ? { held: "The card is published: this edit waits with its other held changes until the creator submits them." } : {}),
      ...(conflicts.length ? { merged: `The creator saved in the editor meanwhile; ${conflicts.length} field(s) kept their version.` } : {}),
    },
  };
}

/**
 * Phase 7 — content-embedding service.
 *
 * Single entry point: `embedText(input)` returns a 1536-dim Float32 vector
 * suitable for direct insertion into `worlds.embedding` (pgvector
 * `vector(1536)`).
 *
 * Provider is selected by env: OPENAI_EMBEDDING_MODEL (default
 * `text-embedding-3-small`) drives the OpenAI path. Future providers
 * (BGE-m3 via HuggingFace, etc.) can implement the same interface and
 * be selected by env without callers changing.
 *
 * Cost ballpark for OpenAI text-embedding-3-small at 2026 prices:
 *   ~$0.02 per 1M input tokens. Average world embedding input ≈ 2k
 *   tokens (name + description + tags + first message + author note).
 *   Full catalog backfill of 1000 worlds ≈ $0.04.
 *
 * Deterministic-ish: OpenAI's API is technically not bitwise stable,
 * but for the same input + model the embedding distance to itself is
 * effectively zero. Don't rely on bitwise equality across re-embeds;
 * do rely on cosine similarity ≥ 0.999 across re-embeds.
 */

import { env } from "./env.js";

export const EMBEDDING_DIMENSIONS = 1536;

/** Build the canonical text input that gets fed to the embedding model. */
export function buildWorldEmbeddingText(world: {
  name: string;
  description?: string | null;
  tags?: string[] | null;
  announcement?: string | null;
  /** First-message preview if available; trimmed below to keep token cost
   * predictable. Pass the same field the hub card shows so the embedding
   * matches "what the user sees when they preview." */
  firstMessage?: string | null;
}): string {
  const parts: string[] = [];
  parts.push(`Title: ${world.name.trim()}`);
  if (world.description?.trim()) {
    parts.push(`Description: ${world.description.trim()}`);
  }
  if (world.tags && world.tags.length > 0) {
    parts.push(`Tags: ${world.tags.join(", ")}`);
  }
  if (world.announcement?.trim()) {
    parts.push(`Announcement: ${world.announcement.trim()}`);
  }
  if (world.firstMessage?.trim()) {
    // Cap to ~2000 chars so a single long opening doesn't blow the budget.
    // Most worlds' first messages are 200–800 chars; the cap mostly trims
    // outliers that pasted entire chapters into the opening.
    const trimmed = world.firstMessage.trim().slice(0, 2000);
    parts.push(`Opening: ${trimmed}`);
  }
  return parts.join("\n\n");
}

interface EmbeddingProvider {
  embed(input: string): Promise<number[]>;
  embedBatch(inputs: string[]): Promise<number[][]>;
}

/** OpenAI text-embedding-3-small. Native batch endpoint accepts up to 2048
 * inputs per request — we batch at 64 to stay well under any single-request
 * timeout (worst-case 64 × 8k tokens ≈ 500KB upload). */
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private apiKey: string,
    private model: string = "text-embedding-3-small",
  ) {}

  async embed(input: string): Promise<number[]> {
    const [vec] = await this.embedBatch([input]);
    if (!vec) throw new Error("OpenAI returned no embedding");
    return vec;
  }

  async embedBatch(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: inputs,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable body)");
      throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json() as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    // Ensure ordering matches input — OpenAI guarantees this but defensive
    // sort is cheap and lets future providers be flakier.
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

let providerInstance: EmbeddingProvider | null = null;

function getProvider(): EmbeddingProvider {
  if (providerInstance) return providerInstance;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY not set — embeddings unavailable. Set it in env, or " +
      "swap to a different provider in lib/embeddings.ts.",
    );
  }
  providerInstance = new OpenAIEmbeddingProvider(apiKey);
  return providerInstance;
}

/** Single-shot embedding. Convenience wrapper over embedBatch. */
export async function embedText(input: string): Promise<number[]> {
  return getProvider().embed(input);
}

/** Batch embed. Use for backfill scripts and any path where you have
 * multiple inputs ready — saves both wall-clock time (one HTTP round
 * trip) and per-request overhead. */
export async function embedTexts(inputs: string[]): Promise<number[][]> {
  return getProvider().embedBatch(inputs);
}

/** Test helper for swapping in a fake provider. Calls reset() in afterEach. */
export function __setEmbeddingProviderForTests(provider: EmbeddingProvider | null): void {
  providerInstance = provider;
}

/** Fire-and-forget: embed a world and write the result to worlds.embedding.
 *
 * Wired into the publish handler (fire-and-forget) so that whenever a
 * world's content changes meaningfully, its embedding refreshes within
 * seconds. Failure is logged but never throws — recommendation degrades
 * to the pre-Phase-7 score path if this row's embedding is stale.
 *
 * Skipped silently when OPENAI_API_KEY is unset.
 *
 * The caller passes the world's content fields directly so this function
 * doesn't have to re-query the DB. If you only have an id, query the
 * row first or run scripts/embed-worlds.ts.
 */
export async function embedAndStoreWorld(args: {
  worldId: string;
  name: string;
  description?: string | null;
  tags?: string[] | null;
  announcement?: string | null;
  firstMessage?: string | null;
}): Promise<void> {
  if (!env.OPENAI_API_KEY) return;
  try {
    const text = buildWorldEmbeddingText(args);
    const vec = await embedText(text);
    if (vec.length !== EMBEDDING_DIMENSIONS) {
      console.warn(`[embeddings] dim mismatch on ${args.worldId}: got ${vec.length}`);
      return;
    }
    const { db } = await import("../db/index.js");
    const { worlds } = await import("../db/schema.js");
    const { eq, sql } = await import("drizzle-orm");
    const vecLiteral = `[${vec.join(",")}]`;
    await db.execute(sql`
      UPDATE ${worlds}
      SET embedding = ${vecLiteral}::vector,
          embedding_updated_at = now()
      WHERE id = ${args.worldId}
    `);
    void eq; // satisfy unused-import on type-only import
  } catch (err) {
    console.warn(
      `[embeddings] failed to embed ${args.worldId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

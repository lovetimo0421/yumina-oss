/**
 * Phase 7 — content-embedding service.
 *
 * Single entry point: `embedText(input)` returns a 1536-dim Float32 vector
 * suitable for direct insertion into `worlds.embedding` (pgvector
 * `vector(1536)`).
 *
 * The current provider is OpenAI text-embedding-3-small, using OPENAI_API_KEY.
 *
 * Input is versioned and bounded by embedding-content.ts, including enabled
 * published greeting entries. Hooks log identifiers/hashes, never story bodies.
 *
 * The hash identifies the exact versioned input, not the returned vector.
 */

import { env } from "./env.js";
import { buildWorldEmbeddingInput, type WorldEmbeddingContent } from "./embedding-content.js";
export { buildWorldEmbeddingInput, buildWorldEmbeddingText } from "./embedding-content.js";

export const EMBEDDING_DIMENSIONS = 1536;

interface EmbeddingProvider {
  embed(input: string): Promise<number[]>;
  embedBatch(inputs: string[]): Promise<number[][]>;
}

/** OpenAI text-embedding-3-small. The backfill batches at 64 inputs. */
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
      // A provider error can echo its input. Do not expose response bodies.
      throw new Error(`OpenAI embeddings HTTP ${res.status}`);
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
 * Pass the row actually committed live, after the transaction commits. The
 * conditional write discards results if publication/content changed in flight.
 * No DB schema metadata is added: input version/hash are emitted for audits.
 */
export async function embedAndStoreWorld(args: WorldEmbeddingContent & {
  worldId: string;
}): Promise<void> {
  if (!env.OPENAI_API_KEY) return;
  let input: ReturnType<typeof buildWorldEmbeddingInput> | undefined;
  try {
    input = buildWorldEmbeddingInput(args);
    const vec = await embedText(input.text);
    if (vec.length !== EMBEDDING_DIMENSIONS || !vec.every(Number.isFinite)) {
      console.warn(`[embeddings] invalid vector on ${args.worldId}`);
      return;
    }
    const { db } = await import("../db/index.js");
    const { worlds } = await import("../db/schema.js");
    const { sql } = await import("drizzle-orm");
    const vecLiteral = `[${vec.join(",")}]`;
    const result = await db.execute(sql`
      UPDATE ${worlds}
      SET embedding = ${vecLiteral}::vector,
          embedding_updated_at = now()
      WHERE id = ${args.worldId}
        AND is_published = true AND status = 'published'
        AND schema IS NOT DISTINCT FROM ${JSON.stringify(args.schema ?? null)}::jsonb
        AND name IS NOT DISTINCT FROM ${args.name}
        AND description IS NOT DISTINCT FROM ${args.description ?? null}
        AND tags IS NOT DISTINCT FROM ${JSON.stringify(args.tags ?? null)}::jsonb
        AND announcement IS NOT DISTINCT FROM ${args.announcement ?? null}
      RETURNING id
    `);
    const stored = (result as { rows: unknown[] }).rows.length > 0;
    console.info(`[embeddings] ${stored ? "stored" : "superseded"} world=${args.worldId} version=${input.version} hash=${input.hash}`);
  } catch {
    // Both provider and SQL errors may include submitted story bodies.
    console.warn(`[embeddings] failed world=${args.worldId} version=${input?.version ?? "unknown"} hash=${input?.hash ?? "unknown"}`);
  }
}

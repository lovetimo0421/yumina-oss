import { usageObservation } from "./usage-observation.js";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, worldMemories } from "../db/schema.js";
import { recordUsageLog } from "./usage-log.js";
import { createProvider, inferProvider } from "./llm/provider-factory.js";
import type { ProviderName } from "./llm/provider-factory.js";
import { getModelContextWindow } from "./llm/context-window.js";
import { estimateTokens } from "@yumina/engine";

const EXTRACTION_MODEL = "openai/gpt-4o-mini";
const MAX_MEMORIES_PER_WORLD = 100;

const EXTRACTION_PROMPT = `You are a memory extractor for an interactive fiction game. Analyze the conversation and extract key facts that should persist across play sessions.

Respond with a JSON array of memory objects:
[
  {
    "content": "concise description of the fact/event/decision",
    "category": "event" | "relationship" | "fact" | "decision" | "item" | "location" | "agreement" | "world_state",
    "importance": 1-10
  }
]

Categories:
- "event": Something that happened (e.g., "Player defeated the dragon")
- "relationship": How the player relates to NPCs (e.g., "Mira considers the player a trusted friend")
- "fact": World state facts (e.g., "The merchant's chest was found empty")
- "decision": Choices the player made (e.g., "Player chose to spare the thief")
- "item": Item acquisition or loss (e.g., "Player obtained the Enchanted Sword")
- "location": Location discoveries or changes (e.g., "Player discovered the hidden cave behind the waterfall")
- "agreement": Promises, contracts, deals (e.g., "Player agreed to deliver the package by dawn")
- "world_state": Persistent world changes (e.g., "The bridge was destroyed in the flood")

Rules:
- Extract 3-10 memories per session
- Higher importance = more narratively significant (10 = life-changing, 1 = minor detail)
- Be concise — each memory should be one sentence
- Focus on facts that would affect future interactions
- Respond ONLY with the JSON array`;

interface ExtractedMemory {
  content: string;
  category: "event" | "relationship" | "fact" | "decision" | "item" | "location" | "agreement" | "world_state";
  importance: number;
}

/**
 * Extract persistent memories from a session's conversation.
 * Called when a session ends or on explicit save.
 */
export async function extractMemories(
  sessionId: string,
  worldId: string,
  userId: string,
  apiKey: string
): Promise<ExtractedMemory[]> {
  // Load recent messages from this session
  const sessionMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(messages.createdAt);

  if (sessionMessages.length < 3) {
    return []; // too few messages to extract anything useful
  }

  // Cap the transcript to the extraction model's window. A long session (100+
  // messages) otherwise concatenates well past gpt-4o-mini's 128K and the call
  // silently 400s, so no memories get extracted. Keep the most recent messages
  // (newest events are the likeliest "memories") that fit the input budget,
  // then restore chronological order. EXTRACTION_PROMPT + 1024 output reserved;
  // 0.85 absorbs framing/estimate drift (same rationale as clampMaxContextToModel).
  const extractionWindow = getModelContextWindow(EXTRACTION_MODEL);
  const inputBudget = Number.isFinite(extractionWindow)
    ? Math.floor((extractionWindow - 1024 - estimateTokens(EXTRACTION_PROMPT, EXTRACTION_MODEL)) * 0.85)
    : Number.POSITIVE_INFINITY;
  const keptLines: string[] = [];
  let usedTokens = 0;
  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    const line = `${sessionMessages[i]!.role.toUpperCase()}: ${sessionMessages[i]!.content}`;
    const lineTokens = estimateTokens(line, EXTRACTION_MODEL);
    if (keptLines.length > 0 && usedTokens + lineTokens > inputBudget) break;
    keptLines.push(line);
    usedTokens += lineTokens;
  }
  keptLines.reverse();
  const messageText = keptLines.join("\n\n");

  try {
    const providerName = inferProvider(EXTRACTION_MODEL);
    const provider = createProvider(providerName as ProviderName, apiKey);
    const startTime = Date.now();

    let response = "";
    let observation = usageObservation();
    let promptTokens = 0;
    let completionTokens = 0;
    for await (const chunk of provider.generateStream({
      model: EXTRACTION_MODEL,
      messages: [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: messageText },
      ],
      maxTokens: 1024,
      temperature: 0.3,
      responseFormat: { type: "json_object" },
    })) {
      if (chunk.type === "text") {
        response += chunk.content;
      }
      if (chunk.type === "done") {
        observation = usageObservation(chunk.usage);
        promptTokens = chunk.usage?.promptTokens ?? 0;
        completionTokens = chunk.usage?.completionTokens ?? 0;
      }
    }

    // Log extraction usage. Caller passes the user's API key (BYOK), so we mark
    // tier as "byok" — the user pays their provider directly, no credit deduction.
    // Logging here gives admins visibility into how much extraction happens per user.
    if (promptTokens || completionTokens) {
      await recordUsageLog({
        ...observation,
        userId,
        sessionId,
        model: EXTRACTION_MODEL,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        endpoint: "memory-extract",
        apiKeyTier: "byok",
        generationTimeMs: Date.now() - startTime,
      });
    }

    // Parse the response
    let memories: ExtractedMemory[];
    try {
      const parsed = JSON.parse(response);
      memories = Array.isArray(parsed) ? parsed : parsed.memories ?? [];
    } catch {
      return [];
    }

    // Validate and clamp importance
    const valid = memories
      .filter(
        (m) =>
          m.content &&
          ["event", "relationship", "fact", "decision", "item", "location", "agreement", "world_state"].includes(m.category)
      )
      .map((m) => ({
        ...m,
        importance: Math.max(1, Math.min(10, m.importance ?? 5)),
      }));

    // Store in DB
    for (const memory of valid) {
      await db.insert(worldMemories).values({
        worldId,
        userId,
        content: memory.content,
        category: memory.category,
        importance: memory.importance,
        sessionId,
      });
    }

    // Prune old low-importance memories if over limit
    const allMemories = await db
      .select()
      .from(worldMemories)
      .where(
        and(eq(worldMemories.worldId, worldId), eq(worldMemories.userId, userId))
      )
      .orderBy(desc(worldMemories.importance));

    if (allMemories.length > MAX_MEMORIES_PER_WORLD) {
      const toDelete = allMemories.slice(MAX_MEMORIES_PER_WORLD);
      for (const mem of toDelete) {
        await db.delete(worldMemories).where(eq(worldMemories.id, mem.id));
      }
    }

    return valid;
  } catch {
    return [];
  }
}

/**
 * Load persistent memories for a world+user pair.
 * Returns memories sorted by importance (highest first).
 */
export async function loadWorldMemories(
  worldId: string,
  userId: string
): Promise<Array<{ content: string; category: string; importance: number }>> {
  const rows = await db
    .select()
    .from(worldMemories)
    .where(
      and(eq(worldMemories.worldId, worldId), eq(worldMemories.userId, userId))
    )
    .orderBy(desc(worldMemories.importance));

  return rows.map((r) => ({
    content: r.content,
    category: r.category,
    importance: r.importance,
  }));
}

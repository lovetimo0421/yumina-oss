import { playtimeDecision } from "../lib/playtime-policy.js";
import { deleteSessionsKeepingUsage } from "../lib/delete-sessions.js";
import { PLAY_ENGAGEMENT_LUA } from "../lib/play-engagement.js";
import { redis } from "../lib/redis.js";
import { captureServerError } from "../lib/posthog.js";
import { Hono } from "hono";
import { eq, and, ne, desc, asc, sql, count, inArray } from "drizzle-orm";
import { db, readOwn } from "../db/index.js";
import { createHash, randomUUID } from "node:crypto";
import { playSessions, worlds, messages, apiKeys, worldMemories, checkpoints, userLibrary, user, summaryceptionSnippets } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { decryptApiKey } from "../lib/crypto.js";
import { extractMemories, loadWorldMemories } from "../lib/memory-extractor.js";
import { MAX_SESSION_NAME } from "@yumina/shared";
import type { AppEnv } from "../lib/types.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { scanAssets } from "../lib/asset-scanner.js";
import { captureSessionPersona } from "../lib/session-persona.js";
import { applyPersonaMetadata, applyPersonaMetadataToState } from "../lib/persona-metadata.js";
import { resolvePersonaForWorld, resolvePersonaForSession, setSessionPersona, setSessionPersonaLock } from "../lib/resolve-persona.js";
import { getPendingEdit, resolveSessionWorldSchema } from "../lib/pending-edit.js";
import { viewerSeesWorkingCopy } from "../lib/working-copy.js";
import { loadSessionWorldDef } from "../lib/world-def-cache.js";
import { SESSION_NOT_FOUND, SessionBusyError, withSessionRowLock } from "../lib/session-lock.js";
import { enqueueLifetimePlaytime } from "../lib/lifetime-playtime-sql.js";
import type { GameState, WorldDefinition, WorldEntry } from "@yumina/engine";
import { GameStateManager, PromptBuilder, migrateWorldDefinition, ReactionEvaluator, runReactionChain, buildActionFiredEvent, preserveSetupScopedVariables, renewSocialEpoch } from "@yumina/engine";
import { mergeGameStatePatch, normalizeGameState } from "../lib/game-state.js";
import { hasStorySummary } from "../lib/session-compaction.js";
import { collectExtensionInvalidation } from "../lib/extension-hooks.js";
import { regenerateDroppedMemoryTiers } from "../extensions/session-memory/hooks.js";

const sessionRoutes = new Hono<AppEnv>();

sessionRoutes.use("/*", authMiddleware);

/** Newest messages returned inline by GET /sessions/:id. Older pages load via
 *  GET /sessions/:id/messages?before=… — never grow this past a few hundred:
 *  unbounded history serialization froze the event loop (2026-08-11 outage). */
export const SESSION_MESSAGES_WINDOW = 200;

const reactionEvaluator = new ReactionEvaluator();

async function touchLibraryLastPlayed(userId: string, worldId: string, playedAt: Date) {
  // Update lastPlayedAt on the exact variant's library entry
  await db
    .update(userLibrary)
    .set({ lastPlayedAt: playedAt })
    .where(and(eq(userLibrary.userId, userId), eq(userLibrary.worldId, worldId)));
}

// POST /api/sessions — create session
sessionRoutes.post("/", async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json<{ worldId: string; name?: string; ephemeral?: boolean; adminPreview?: boolean }>();

  if (!body.worldId) {
    return c.json({ error: "worldId is required" }, 400);
  }
  if (body.name && body.name.length > MAX_SESSION_NAME) {
    return c.json({ error: `Session name must be ${MAX_SESSION_NAME} characters or fewer` }, 400);
  }

  // Load the world
  const worldRows = await db
    .select()
    .from(worlds)
    .where(eq(worlds.id, body.worldId));

  if (worldRows.length === 0) {
    return c.json({ error: "World not found" }, 404);
  }

  const world = worldRows[0]!;

  // Access control: only published worlds or the creator's own worlds (#29).
  // Moderation exception: admins can play any world when adminPreview=true so
  // they can audit a pending submission. Forced ephemeral so it doesn't
  // pollute the admin's library or the world's play counters.
  let isAdminPreview = false;
  if (world.status !== "published" && world.creatorId !== currentUser.id) {
    if (body.adminPreview) {
      const [roleRow] = await db
        .select({ role: user.role })
        .from(user)
        .where(eq(user.id, currentUser.id));
      if (roleRow?.role === "admin") {
        isAdminPreview = true;
      } else {
        return c.json({ error: "This world is not available" }, 403);
      }
    } else {
      return c.json({ error: "This world is not available" }, 403);
    }
  }
  if (isAdminPreview) {
    body.ephemeral = true;
  }

  // Multiplayer worlds get ONE session per user (a persistent entry point, not
  // a narrative timeline — world state lives on the game server, progression on
  // the account). Reuse the existing session instead of stacking meaningless
  // rows in the session manager. Spec: game-room-primitives §"sessions".
  const multiplayerSettings = (world.schema as { settings?: { multiplayer?: unknown } })?.settings?.multiplayer;
  if (multiplayerSettings && !body.ephemeral) {
    const [existing] = await db
      .select()
      .from(playSessions)
      .where(and(eq(playSessions.userId, currentUser.id), eq(playSessions.worldId, body.worldId)))
      .orderBy(desc(playSessions.updatedAt))
      .limit(1);
    if (existing) {
      return c.json({ data: existing });
    }
  }

  // Library bookkeeping runs only after session initialization commits.
  let addedToLibrary = false;

  let worldDef: WorldDefinition;
  let initialState: GameState;
  let session: typeof playSessions.$inferSelect;

  // Creator playing/previewing their OWN published world: if a material edit is
  // held for review, the live `worlds.schema` still serves the last-approved
  // content — but the author's own edits take effect immediately for the author,
  // so seed session state from the in-progress pending copy instead. Applies to
  // both Studio playtest (ephemeral) and the creator's normal sessions. Players
  // and non-creators always get the live schema; admin-preview sessions hit
  // non-published worlds and so never reach this branch.
  let playSchema = world.schema as unknown as WorldDefinition;
  if (viewerSeesWorkingCopy(world.status, world.creatorId, currentUser.id)) {
    const pend = await getPendingEdit(body.worldId);
    if (pend?.schema) {
      playSchema = pend.schema as unknown as WorldDefinition;
    }
  }

  try {
    const rawWorldDef = playSchema;
    worldDef = migrateWorldDefinition(rawWorldDef);

    // Load persona in parallel with state initialization (no dependency).
    // New chats start unlocked and follow the current profile persona.
    const personaPromise = resolvePersonaForWorld(currentUser.id, body.worldId);

    const stateManager = new GameStateManager(worldDef);
    const activePersona = await personaPromise;
    applyPersonaMetadata(stateManager, activePersona ?? null, {
      username: currentUser.username,
      displayUsername: currentUser.displayUsername,
      name: currentUser.name,
      image: currentUser.image,
    });
    const baseInitialState = stateManager.getSnapshot();

    // Greeting "scenario presets": a greeting may carry initialVariables that
    // seed session state when that opening is chosen. Greetings render as swipes
    // of the first message, so each swipe gets its OWN snapshot; the active
    // (first) greeting's snapshot also becomes the session's live state. Applied
    // via GameStateManager.set so keys resolve by id-or-name and validate.
    const greetingBuilder = new PromptBuilder();
    const greetingEntries = greetingBuilder.buildGreetingEntries(worldDef);
    const snapshotForGreeting = (g: WorldEntry | undefined): GameState => {
      if (!g) return baseInitialState;
      const sm = new GameStateManager(worldDef);
      applyPersonaMetadata(sm, activePersona ?? null, {
        username: currentUser.username,
        displayUsername: currentUser.displayUsername,
        name: currentUser.name,
        image: currentUser.image,
      });
      for (const [k, v] of Object.entries(g.initialVariables ?? {})) sm.set(k, v);
      const snap = sm.getSnapshot();
      // Stamp the active greeting ID so worldbooks with mode:"greeting" can
      // activate as a pure function of game state (revert/branch safe). Stored as
      // a first-class field (NOT in variables) so it survives normalization.
      snap.activeGreetingId = g.id;
      return snap;
    };
    initialState = snapshotForGreeting(greetingEntries[0]);

    // Insert greeting message if the world has greeting entries. Each greeting
    // swipe carries its OWN stateSnapshot (base + that greeting's
    // initialVariables) so switching openings applies that route's variables.
    const greetings = greetingBuilder.buildGreetings(worldDef, baseInitialState);
    const swipes = greetings.map((content, i) => ({
      content,
      stateSnapshot: snapshotForGreeting(greetingEntries[i]) as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    }));

    // A session and its opening message are one logical record. Previously the
    // session committed first, so a greeting insert failure left an orphan chat
    // in the session list while the API returned 500.
    session = await db.transaction(async (tx) => {
      const [createdSession] = await tx
        .insert(playSessions)
        .values({
          userId: currentUser.id,
          worldId: body.worldId,
          sessionPersona: captureSessionPersona(activePersona),
          state: initialState as unknown as Record<string, unknown>,
          ...(body.name !== undefined ? { name: body.name } : {}),
          // Studio playtest passes ephemeral=true so the session is hidden from
          // the user's session list and gets swept up by the cleanup cron.
          ...(body.ephemeral ? { ephemeral: true } : {}),
        })
        .returning();

      if (!createdSession) throw new Error("Session insert returned no row");

      if (greetings.length > 0) {
        await tx.insert(messages).values({
          sessionId: createdSession.id,
          role: "assistant",
          content: greetings[0]!,
          stateSnapshot: initialState as unknown as Record<string, unknown>,
          swipes,
          activeSwipeIndex: 0,
        });
      }

      return createdSession;
    });
  } catch (err) {
    console.error("[SESSION] Failed to create session for world", body.worldId, err);
    return c.json({ error: "Failed to initialize session — this world may have invalid data" }, 500);
  }

  // This remains best-effort, but cannot record a play for a session that
  // failed to initialize because it starts only after the transaction above.
  if (world.status === "published") {
    db.insert(userLibrary)
      .values({ userId: currentUser.id, worldId: body.worldId, lastPlayedAt: new Date() })
      .onConflictDoNothing()
      .returning()
      .then((libResult) => {
        if (libResult.length > 0) {
          db.update(worlds)
            .set({ downloadCount: sql`${worlds.downloadCount} + 1` })
            .where(eq(worlds.id, body.worldId))
            .catch(() => {});
        } else {
          touchLibraryLastPlayed(currentUser.id, body.worldId, new Date()).catch(() => {});
        }
      })
      .catch(() => {});
    addedToLibrary = true; // optimistic — worst case library refresh corrects
  }

  return c.json({ data: { ...session, addedToLibrary } }, 201);
});

// GET /api/sessions — list user's sessions (optional ?worldId= filter)
sessionRoutes.get("/", async (c) => {
  const currentUser = c.get("user");
  const rd = await readOwn(currentUser.id);
  const worldIdFilter = c.req.query("worldId");
  const languageGroupFilter = c.req.query("languageGroupId");

  const conditions = [eq(playSessions.userId, currentUser.id)];
  if (worldIdFilter) {
    conditions.push(eq(playSessions.worldId, worldIdFilter));
  }
  if (languageGroupFilter) {
    conditions.push(eq(worlds.languageGroupId, languageGroupFilter));
  }
  // Hide studio playtest sessions from the user's library. Playtest sessions
  // are short-lived (deleted on panel unmount, fallback cron cleanup) — they
  // should never appear in the session picker even if one briefly leaks.
  conditions.push(eq(playSessions.ephemeral, false));

  const result = await rd
    .select({
      id: playSessions.id,
      name: playSessions.name,
      worldId: playSessions.worldId,
      worldName: worlds.name,
      worldStatus: worlds.status,
      worldLanguage: worlds.language,
      worldThumbnailUrl: worlds.thumbnailUrl,
      playtimeSeconds: playSessions.playtimeSeconds,
      parentSessionId: playSessions.parentSessionId,
      branchedFromMessageId: playSessions.branchedFromMessageId,
      createdAt: playSessions.createdAt,
      updatedAt: playSessions.updatedAt,
    })
    .from(playSessions)
    .leftJoin(worlds, eq(playSessions.worldId, worlds.id))
    .where(and(...conditions))
    .orderBy(desc(playSessions.updatedAt));

  // Enrich with last message preview and message count
  const sessionIds = result.map((r) => r.id);

  // Fetch message stats AND child branch counts in parallel — one round-trip
  const [messageCounts, lastMessages, childCounts] = sessionIds.length > 0
    ? await Promise.all([
        rd
          .select({
            sessionId: messages.sessionId,
            messageCount: count(),
          })
          .from(messages)
          .where(inArray(messages.sessionId, sessionIds))
          .groupBy(messages.sessionId),
        rd
          .selectDistinctOn([messages.sessionId], {
            sessionId: messages.sessionId,
            content: messages.content,
          })
          .from(messages)
          .where(inArray(messages.sessionId, sessionIds))
          .orderBy(messages.sessionId, desc(messages.createdAt)),
        // Count direct children per session for the tree UI. The userId
        // filter is defense-in-depth: sessionIds are already user-scoped
        // upstream, but keeping it here prevents a leak if that ever changes.
        rd
          .select({
            parentId: playSessions.parentSessionId,
            branchCount: count(),
          })
          .from(playSessions)
          .where(and(
            eq(playSessions.userId, currentUser.id),
            inArray(playSessions.parentSessionId, sessionIds),
          ))
          .groupBy(playSessions.parentSessionId),
      ])
    : [[], [], []];

  const countMap = new Map(messageCounts.map((s) => [s.sessionId, Number(s.messageCount)]));
  const previewMap = new Map(lastMessages.map((s) => [s.sessionId, s.content]));
  const childCountMap = new Map(childCounts.map((r) => [r.parentId, Number(r.branchCount)]));

  const statsMap = new Map(
    sessionIds.map((id) => [id, {
      messageCount: countMap.get(id) ?? 0,
      lastMessagePreview: previewMap.get(id) ?? null,
    }])
  );

  const resolved = result.map((r) => {
    const stats = statsMap.get(r.id);
    return {
      ...r,
      worldThumbnailUrl: resolveImageCdn(r.worldThumbnailUrl),
      messageCount: stats?.messageCount ?? 0,
      lastMessagePreview: stats?.lastMessagePreview
        ? stats.lastMessagePreview.slice(0, 80)
        : null,
      childBranchCount: childCountMap.get(r.id) ?? 0,
    };
  });

  return c.json({ data: resolved });
});

// GET /api/sessions/:id — get session with messages
sessionRoutes.get("/:id", async (c) => {
  const currentUser = c.get("user");
  // Play entry is latency-sensitive and should prefer consistent primary reads.
  const rd = db;
  const sessionId = c.req.param("id");

  const sessionRows = await rd
    .select()
    .from(playSessions)
    .where(
      and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id))
    );

  if (sessionRows.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Fetch messages, world info, and branching context in a single round-trip.
  // All queries depend only on sessionRows[0], which is already loaded.
  //
  // The message load is a bounded recent window, NOT the full history. Mega
  // sessions (12k+ messages, 38MB of rows) made this endpoint serialize tens
  // of MB of JSON synchronously on the event loop — freezing BOTH replicas,
  // failing health checks, and taking the whole site down in waves (the
  // 2026-08-11 502/524 outage). The client pages older history on demand via
  // GET /sessions/:id/messages?before=…. `messageTotal` below tells it whether
  // earlier pages exist.
  const [sessionMessagesDesc, messageTotalRows, worldRows, parentRows, childBranchRows] = await Promise.all([
    rd
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(SESSION_MESSAGES_WINDOW),
    rd
      .select({ value: count() })
      .from(messages)
      .where(eq(messages.sessionId, sessionId)),
    rd
      .select()
      .from(worlds)
      .where(eq(worlds.id, sessionRows[0]!.worldId)),
    // Parent name (only if this session is itself a branch)
    sessionRows[0]!.parentSessionId
      ? rd
          .select({ id: playSessions.id, name: playSessions.name })
          .from(playSessions)
          .where(eq(playSessions.id, sessionRows[0]!.parentSessionId))
      : Promise.resolve([] as Array<{ id: string; name: string | null }>),
    // Direct children (other timelines forked off this session), oldest first
    rd
      .select({
        id: playSessions.id,
        name: playSessions.name,
        branchedFromMessageId: playSessions.branchedFromMessageId,
      })
      .from(playSessions)
      .where(eq(playSessions.parentSessionId, sessionId))
      .orderBy(asc(playSessions.createdAt)),
  ]);

  const sessionMessages = sessionMessagesDesc.slice().reverse();
  const messageTotal = messageTotalRows[0]?.value ?? sessionMessages.length;

  const world = worldRows[0] ?? null;
  const parentSessionName = parentRows[0]?.name ?? null;
  const childBranches = childBranchRows;

  const sessionPersona = captureSessionPersona(await resolvePersonaForSession(sessionRows[0]!));

  // Determine if this session should be read-only (unpublished world, non-creator)
  const isCreator = world ? world.creatorId === currentUser.id : false;
  const isReadOnly = world ? world.status === "unpublished" && !isCreator : false;

  // Creator-only preview parity: when the creator plays/previews their OWN
  // published world and a material edit is held for review, the live
  // `worlds.schema` still serves the last-approved content. But the author's own
  // edits should take effect immediately for the author, so render the held
  // working copy here — mirroring the state-seed overlay at session creation
  // (see POST /api/sessions) and the prompt overlay in messages.ts. Without this
  // the rootComponent/entries render from the approved schema, so held edits
  // look like no-ops and the creator thinks their Studio edits silently failed.
  // Players and non-creators never hit this branch, so they keep getting the
  // live approved schema until an admin approves.
  let renderSchema = (world?.schema ?? null) as unknown as WorldDefinition | null;
  if (world && viewerSeesWorkingCopy(world.status, world.creatorId, currentUser.id)) {
    const pend = await getPendingEdit(world.id);
    if (pend?.schema) renderSchema = pend.schema as unknown as WorldDefinition;
  }

  const normalizedState = world && renderSchema
    ? normalizeGameState(
        migrateWorldDefinition(renderSchema as unknown as WorldDefinition),
        sessionRows[0]!.state
      )
    : (sessionRows[0]!.state as unknown as GameState);

  // If read-only, return a tombstone world (just metadata, no full schema).
  // Otherwise return the live row, overlaying the held working copy onto its
  // `schema` when the playtest-preview branch above chose the pending copy.
  const worldData = isReadOnly && world
    ? { id: world.id, name: world.name, status: world.status, thumbnailUrl: world.thumbnailUrl }
    : world && renderSchema && renderSchema !== (world.schema as unknown as WorldDefinition)
      ? { ...world, schema: renderSchema as unknown as typeof world.schema }
      : world;
  // Asset preload manifest — client emits <link rel="preload"> for priority,
  // <link rel="prefetch"> for deferred, BEFORE the sandbox iframe mounts. This
  // parallelizes CDN fetches with the iframe boot instead of serializing them
  // behind the MutationObserver pass. Suppressed for read-only tombstones
  // (we don't ship the schema in that case).
  const assetManifest = (!isReadOnly && world && renderSchema)
    ? scanAssets(
        migrateWorldDefinition(renderSchema as unknown as WorldDefinition),
        sessionMessages,
      )
    : { priority: [], deferred: [] };

  applyPersonaMetadataToState(normalizedState, sessionPersona.persona, currentUser);
  return c.json({
    data: {
      ...sessionRows[0]!,
      sessionPersona,
      currentUser: {
        id: currentUser.id,
        name: currentUser.name,
        username: currentUser.username,
        displayUsername: currentUser.displayUsername,
        image: currentUser.image,
      },
      readOnly: isReadOnly,
      state: normalizedState as unknown as Record<string, unknown>,
      world: worldData,
      messages: sessionMessages,
      // Full history size — larger than messages.length when the inline window
      // was capped. The client uses it for turn counts and to decide whether a
      // "load earlier" affordance is needed.
      messageTotal,
      parentSessionName,
      childBranches,
      assetManifest,
    },
  });
});

// DELETE /api/sessions/:id
sessionRoutes.delete("/:id", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");

  const result = await db.transaction(tx => deleteSessionsKeepingUsage(
    statement => tx.execute(statement), currentUser.id, { sessionId },
  ));

  if (result.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({ data: { deleted: true } });
});

// PUT /api/sessions/:id/persona — unlocked in-chat selection updates the shared profile persona.
sessionRoutes.put("/:id/persona", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || !(body.personaId === null || typeof body.personaId === "string")) {
    return c.json({ error: "personaId must be a string or null" }, 400);
  }
  const result = await setSessionPersona(currentUser.id, sessionId, body.personaId);
  if ("error" in result) return c.json({ error: result.error }, 404);
  return c.json(result);

});

// PUT /api/sessions/:id/persona-lock — opt one session into or out of a fixed persona.
sessionRoutes.put("/:id/persona-lock", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.locked !== "boolean") {
    return c.json({ error: "locked must be a boolean" }, 400);
  }
  if (body.locked && !(body.personaId === null || typeof body.personaId === "string")) {
    return c.json({ error: "personaId must be a string or null when locking" }, 400);
  }
  const result = await setSessionPersonaLock(currentUser.id, sessionId, body.locked, body.personaId);
  if ("error" in result) return c.json({ error: result.error }, 404);
  return c.json(result);
});

// PATCH /api/sessions/:id/state — update session state
sessionRoutes.patch("/:id/state", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");
  const body = await c.req.json<{ state: Record<string, unknown> }>();

  // Build the world definition BEFORE taking the row lock. The world schema is
  // stable for the request, so fetching + migrating it (a multi-MB JSONB detoast
  // + CPU) INSIDE the FOR UPDATE would pin the connection + row lock across slow
  // work — a primary-pool-saturation driver. Only the state read-modify-write
  // below needs the lock. user_id is immutable, so checking ownership here is
  // equivalent to checking it inside the lock.
  const [meta] = await db
    .select({ worldId: playSessions.worldId, userId: playSessions.userId })
    .from(playSessions)
    .where(eq(playSessions.id, sessionId))
    .limit(1);
  if (!meta || meta.userId !== currentUser.id) {
    return c.json({ error: "Session not found" }, 404);
  }
  // Version-stamped cache of the parsed definition (lib/world-def-cache.ts):
  // this path ran ~1M times a week and each call detoasted the multi-MB world
  // schema. A creator playtesting their own published world still gets the held
  // WORKING COPY (see resolveSessionWorldSchema for why that matters).
  const worldDef = await loadSessionWorldDef(meta.worldId, currentUser.id);
  if (!worldDef) {
    return c.json({ error: "World not found" }, 404);
  }

  // Row-level lock so a concurrent execute-action / message-turn / state-patch
  // can't read-modify-write the same session state and lose updates. The lock is
  // taken NOWAIT and retried from Node (lib/session-lock.ts) so a patch that
  // lands mid-turn never pins a database connection while it waits.
  let result;
  try {
    result = await withSessionRowLock(sessionId, async (tx, row) => {
      const mergedState = mergeGameStatePatch(worldDef, row.state, body.state);
      const updated = await tx
        .update(playSessions)
        .set({
          state: mergedState as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(playSessions.id, sessionId))
        .returning();
      return { data: updated[0] };
    });
  } catch (err) {
    if (err instanceof SessionBusyError) {
      c.header("Retry-After", "2");
      return c.json({ error: "session_busy", retryAfterMs: err.retryAfterMs }, 409);
    }
    throw err;
  }

  if (result === SESSION_NOT_FOUND) return c.json({ error: "Session not found" }, 404);
  return c.json({ data: result.data });
});

// POST /api/sessions/:id/context — inject one-shot context for next AI turn
sessionRoutes.post("/:id/context", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");
  const body = await c.req.json<{ message: string; role?: string }>();

  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "message is required" }, 400);
  }

  // Row-level lock so a concurrent execute-action / message-turn can't clobber
  // the pendingContext we append here. NOWAIT + retry from Node (see
  // lib/session-lock.ts) — never pins a connection while the row is held.
  let result;
  try {
    result = await withSessionRowLock(sessionId, async (tx, row) => {
      if (row.userId !== currentUser.id) return { notOwner: true as const };

      // Append to metadata.pendingContext in session state
      const state = row.state;
      const metadata = (state.metadata ?? {}) as Record<string, unknown>;
      const existing = (metadata.pendingContext ?? []) as Array<{ message: string; role: string }>;
      const updated = [...existing, { message: body.message, role: body.role ?? "system" }];

      await tx
        .update(playSessions)
        .set({
          state: {
            ...state,
            metadata: { ...metadata, pendingContext: updated },
          } as unknown as Record<string, unknown>,
          updatedAt: new Date(),
        })
        .where(eq(playSessions.id, sessionId));
      return { ok: true as const };
    });
  } catch (err) {
    if (err instanceof SessionBusyError) {
      c.header("Retry-After", "2");
      return c.json({ error: "session_busy", retryAfterMs: err.retryAfterMs }, 409);
    }
    throw err;
  }

  if (result === SESSION_NOT_FOUND || "notOwner" in result) return c.json({ error: "Session not found" }, 404);
  return c.json({ ok: true });
});

// POST /api/sessions/:id/execute-action — fire an action:fired event from a
// custom-UI action button. Server-authoritative: evaluates reactions with the
// real ruleState (cooldowns / max-fire), applies + chains effects, persists.
// Silent state mutation only — returns updated variables / notifications / audio.
sessionRoutes.post("/:id/execute-action", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");
  const body = await c.req.json<{ actionId: string }>().catch(() => null);
  if (!body || typeof body.actionId !== "string" || !body.actionId) {
    return c.json({ error: "actionId is required" }, 400);
  }

  // Build the world definition BEFORE the row lock (see /state note above): the
  // world detoast + migrate is slow and stable, so keeping it out of the FOR
  // UPDATE avoids pinning the connection + row lock across it. Only the
  // reaction-chain state read-modify-write needs the lock.
  const [meta] = await db
    .select({ worldId: playSessions.worldId, userId: playSessions.userId })
    .from(playSessions)
    .where(eq(playSessions.id, sessionId))
    .limit(1);
  if (!meta || meta.userId !== currentUser.id) {
    return c.json({ error: "Session not found" }, 404);
  }
  // Cached parsed definition — see the /state handler above.
  const worldDef = await loadSessionWorldDef(meta.worldId, currentUser.id);
  if (!worldDef) {
    return c.json({ error: "World not found" }, 404);
  }

  let result;
  try {
    // Row-level lock so concurrent actions / messages don't clobber state.
    // NOWAIT + retry from Node (lib/session-lock.ts).
    result = await withSessionRowLock(sessionId, async (tx, row) => {
      const gameState = normalizeGameState(worldDef, row.state);

      const stateManager = new GameStateManager(worldDef, gameState);
      const runResult = runReactionChain(
        reactionEvaluator,
        stateManager,
        [buildActionFiredEvent(body.actionId)],
        worldDef.reactions ?? [],
        worldDef.rules ?? [],
      );

      // A fired reaction may stash one-shot context (tell-ai) for the AI to read
      // on the player's NEXT message — it does not start a turn on its own.
      if (runResult.contextMessages.length > 0) {
        stateManager.setMetadata("pendingContext", runResult.contextMessages);
      }

      const finalState = stateManager.getSnapshot();
      await tx
        .update(playSessions)
        .set({ state: finalState as unknown as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(playSessions.id, sessionId));

      return {
        data: {
          variables: finalState.variables,
          changes: runResult.changes,
          notifications: runResult.notifications,
          audio: runResult.audioEffects,
          firedIds: runResult.firedIds,
        },
      };
    });
  } catch (err) {
    if (err instanceof SessionBusyError) {
      c.header("Retry-After", "2");
      return c.json({ error: "session_busy", retryAfterMs: err.retryAfterMs }, 409);
    }
    throw err;
  }
  if (result === SESSION_NOT_FOUND) return c.json({ error: "Session not found" }, 404);
  return c.json(result);
});

// POST /api/sessions/:id/extract-memories — extract persistent memories from session
sessionRoutes.post("/:id/extract-memories", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");

  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(
      and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id))
    );

  if (sessionRows.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  const session = sessionRows[0]!;
  await resolvePersonaForSession(session);

  // Need an OpenAI key for the extraction model
  const keyRows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, currentUser.id), eq(apiKeys.provider, "openai")));

  if (keyRows.length === 0) {
    // Try openrouter as fallback
    const orKeys = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, currentUser.id), eq(apiKeys.provider, "openrouter")));

    if (orKeys.length === 0) {
      return c.json({ error: "API key required for memory extraction" }, 400);
    }

    const apiKey = decryptApiKey(orKeys[0]!.encryptedKey, orKeys[0]!.keyIv, orKeys[0]!.keyTag);
    if (!apiKey) return c.json({ error: "Failed to decrypt API key" }, 500);
    const memories = await extractMemories(sessionId, session.worldId, currentUser.id, apiKey);
    return c.json({ data: { extracted: memories.length, memories } });
  }

  const apiKey = decryptApiKey(keyRows[0]!.encryptedKey, keyRows[0]!.keyIv, keyRows[0]!.keyTag);
  if (!apiKey) return c.json({ error: "Failed to decrypt API key" }, 500);
  const memories = await extractMemories(sessionId, session.worldId, currentUser.id, apiKey);
  return c.json({ data: { extracted: memories.length, memories } });
});

// GET /api/sessions/:id/memories — get persistent memories for this world+user
sessionRoutes.get("/:id/memories", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");

  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(
      and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id))
    );

  if (sessionRows.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  const memories = await loadWorldMemories(sessionRows[0]!.worldId, currentUser.id);
  return c.json({ data: memories });
});

// PATCH /api/sessions/:id — rename session
sessionRoutes.patch("/:id", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");
  const body = await c.req.json<{ name?: string }>();

  if (body.name && body.name.length > MAX_SESSION_NAME) {
    return c.json({ error: `Session name must be ${MAX_SESSION_NAME} characters or fewer` }, 400);
  }
  const trimmed = body.name?.trim().slice(0, MAX_SESSION_NAME) || null;

  const result = await db
    .update(playSessions)
    .set({ name: trimmed, updatedAt: new Date() })
    .where(
      and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id))
    )
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  return c.json({ data: result[0] });
});

// Revert a session to a specific message (delete everything after it).
// Extracted from the Hono route so it can be unit-tested directly, exactly
// like branchSession. The route below is a thin wrapper.
//   messageId omitted → revert the last assistant+user exchange.
export async function revertSession(args: {
  userId: string;
  sessionId: string;
  messageId?: string;
}): Promise<{
  status: number;
  body: {
    data?: { state: Record<string, unknown>; messages: unknown[] };
    error?: string;
  };
}> {
  const { userId, sessionId } = args;

  // Verify ownership
  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId)));

  if (sessionRows.length === 0) {
    return { status: 404, body: { error: "Session not found" } };
  }

  const session = sessionRows[0]!;
  const currentPersona = await resolvePersonaForSession(session);
  const worldRows = await db.select().from(worlds).where(eq(worlds.id, session.worldId));
  if (worldRows.length === 0) return { status: 404, body: { error: "World not found" } };

  // Creator's revert must normalize against their held working copy (not live),
  // or working-copy-only setup vars get stripped. See resolveSessionWorldSchema.
  const rawWorldDef = (await resolveSessionWorldSchema(worldRows[0]!, userId)) as unknown as WorldDefinition;
  const worldDef = migrateWorldDefinition(rawWorldDef);

  // Get ALL messages (including compacted) ordered by time
  const allMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  if (allMessages.length === 0) {
    return { status: 400, body: { error: "No messages to revert" } };
  }

  let targetIdx: number;

  if (args.messageId) {
    // Revert to a specific message — keep this message, delete everything after
    targetIdx = allMessages.findIndex((m) => m.id === args.messageId);
    if (targetIdx === -1) {
      return { status: 404, body: { error: "Message not found" } };
    }
  } else {
    // No messageId — revert the last exchange (find second-to-last assistant, or greeting)
    // Find the last assistant message
    let lastAssistantIdx = -1;
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i]!.role === "assistant") {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx === -1) {
      return { status: 400, body: { error: "No assistant message to revert" } };
    }

    // Target = the user message before the last assistant, or the message before the last pair
    // Effectively, find the message right before the user+assistant pair
    const userBeforeIdx = lastAssistantIdx > 0 && allMessages[lastAssistantIdx - 1]!.role === "user"
      ? lastAssistantIdx - 1
      : lastAssistantIdx;

    // Target is the message BEFORE the pair we want to delete
    targetIdx = userBeforeIdx - 1;

    if (targetIdx < 0) {
      // Nothing left — will reinitialize from world defaults
      targetIdx = -1;
    }
  }

  // Delete all messages after the target
  const toDelete = targetIdx >= 0 ? allMessages.slice(targetIdx + 1) : allMessages;

  if (toDelete.length === 0) {
    return { status: 400, body: { error: "Nothing to revert" } };
  }

  const idsToDelete = toDelete.map((m) => m.id);
  await db.delete(messages).where(inArray(messages.id, idsToDelete));

  // Find the state to restore. Walk backwards from the target message to the
  // most recent stateSnapshot. Only assistant messages carry a snapshot — user
  // messages never do — so reverting onto a user message must fall back to the
  // preceding assistant turn's snapshot, NOT to world defaults (which would
  // silently wipe every variable back to its default). Mirrors branchSession's
  // backward walk so revert and branch restore state identically.
  let restoredState: Record<string, unknown> | null = null;
  if (targetIdx >= 0) {
    for (let i = targetIdx; i >= 0; i--) {
      const snap = allMessages[i]!.stateSnapshot as Record<string, unknown> | null;
      if (snap) {
        restoredState = snap;
        break;
      }
    }
  }

  if (!restoredState) {
    if (targetIdx >= 0 && session.state) {
      // The target message survives but its snapshot (and every older one) was
      // dropped by the per-session snapshot cap. Don't zero the player's
      // variables — fall back to the live session state, mirroring
      // branchSession's fallback. Better to keep progress than reset to default.
      restoredState = session.state as Record<string, unknown>;
    } else {
      // Full reset (no target), or a session that genuinely has no state —
      // re-initialize from world defaults.
      const stateManager = new GameStateManager(worldDef);
      restoredState = stateManager.getSnapshot() as unknown as Record<string, unknown>;
    }
  }

  restoredState = normalizeGameState(worldDef, restoredState) as unknown as Record<string, unknown>;

  // Setup-scoped choices (e.g. the pre-game cast the player picked) are session
  // config, not narrative state — a revert must not reset them to world defaults.
  // Carry them forward from the live session state over the restored snapshot.
  restoredState = preserveSetupScopedVariables(
    worldDef.variables,
    session.state as { variables?: Record<string, unknown> } | null,
    restoredState,
  );

  // Extensions stop their queued jobs and reset their derived per-session state
  // (summaries, memory). Each tier is kept when its stored output covers only
  // surviving messages and dropped otherwise (see invalidateForRevert). The
  // fields merge into this one atomic update with the state.
  //
  // Decide from a FRESH read of the row, not the one loaded at the top: a
  // background compaction or memory update can persist between that read and
  // the delete above, moving the coverage pointers onto messages that are now
  // gone. The stale row would say "kept"; the live row says "drop".
  const [liveSession] = await db
    .select()
    .from(playSessions)
    .where(eq(playSessions.id, sessionId))
    .limit(1);
  const invalidation = collectExtensionInvalidation({
    reason: "session-revert",
    sessionId,
    userId,
    session: liveSession ?? session,
    removedMessages: toDelete.map((m) => ({
      id: m.id,
      compacted: m.compacted,
      summaryceptionCompacted: m.summaryceptionCompacted,
    })),
  });

  // Restoring social history creates a fresh incarnation; late old replies cannot enter it.
  restoredState = renewSocialEpoch(restoredState, randomUUID());
  const [account] = await db.select().from(user).where(eq(user.id, userId));
  applyPersonaMetadataToState(restoredState, currentPersona, account ?? {});
  // Update session state + clear stale generated context
  await db
    .update(playSessions)
    .set({
      state: restoredState,
      ...invalidation.sessionFields,
      updatedAt: new Date(),
    })
    .where(eq(playSessions.id, sessionId));
  await invalidation.runAfter();

  // Return remaining messages
  const updatedMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  return { status: 200, body: { data: { state: restoredState, messages: updatedMessages } } };
}

// POST /api/sessions/:id/revert — revert to a specific message (delete everything after it)
// Body: { messageId?: string } — if omitted, reverts the last assistant+user exchange
sessionRoutes.post("/:id/revert", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { messageId?: string };

  const result = await revertSession({
    userId: currentUser.id,
    sessionId,
    messageId: body.messageId,
  });
  return c.json(result.body, result.status as 200 | 400 | 404);
});

// POST /api/sessions/:id/restart — full reset: clear messages, state, memories, re-insert greeting
sessionRoutes.post("/:id/restart", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");

  // Verify ownership
  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)));

  if (sessionRows.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  const session = sessionRows[0]!;
  await resolvePersonaForSession(session);

  // Load world definition
  const worldRows = await db.select().from(worlds).where(eq(worlds.id, session.worldId));
  if (worldRows.length === 0) return c.json({ error: "World not found" }, 404);

  // Creator's restart rebuilds greeting + state from their held working copy
  // (not live), so working-copy-only vars/greetings apply. See resolveSessionWorldSchema.
  const rawWorldDef = (await resolveSessionWorldSchema(worldRows[0]!, currentUser.id)) as unknown as WorldDefinition;
  const worldDef = migrateWorldDefinition(rawWorldDef);

  // 1. Find the first assistant message (the greeting) to preserve it
  const existingMsgs = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  const firstAssistant = existingMsgs.find((m) => m.role === "assistant");

  // 2. Delete all messages EXCEPT the first assistant one
  if (firstAssistant) {
    await db
      .delete(messages)
      .where(and(eq(messages.sessionId, sessionId), ne(messages.id, firstAssistant.id)));
  } else {
    await db.delete(messages).where(eq(messages.sessionId, sessionId));
  }

  // 3. Clear world memories for this world+user
  await db
    .delete(worldMemories)
    .where(and(eq(worldMemories.worldId, session.worldId), eq(worldMemories.userId, currentUser.id)));

  // 4. Keep this session's identity when restarting.
  const stateManager = new GameStateManager(worldDef);
  const resetPersona = await resolvePersonaForSession(session);
  applyPersonaMetadata(stateManager, resetPersona ?? null, {
    username: currentUser.username,
    displayUsername: currentUser.displayUsername,
    name: currentUser.name,
    image: currentUser.image,
  });
  const baseInitialState = stateManager.getSnapshot();

  // Greeting "scenario presets" — mirror the session-create path so a RESTART
  // also seeds each opening's initialVariables (and stamps activeGreetingId).
  // Without this, restart gave every swipe the same base snapshot, so switching
  // openings changed neither the frontend variables nor the AI's <game-state>.
  const promptBuilder = new PromptBuilder();
  const restartGreetingEntries = promptBuilder.buildGreetingEntries(worldDef);
  const snapshotForGreeting = (g: WorldEntry | undefined): GameState => {
    if (!g) return baseInitialState;
    const sm = new GameStateManager(worldDef);
    applyPersonaMetadata(sm, resetPersona ?? null, {
      username: currentUser.username,
      displayUsername: currentUser.displayUsername,
      name: currentUser.name,
      image: currentUser.image,
    });
    for (const [k, v] of Object.entries(g.initialVariables ?? {})) sm.set(k, v);
    const snap = sm.getSnapshot();
    snap.activeGreetingId = g.id;
    return snap;
  };
  // The active (first) opening's snapshot becomes the live session state.
  const initialState = snapshotForGreeting(restartGreetingEntries[0]);

  // 5. Reset session state + clear extension-derived context. A restart is a
  // fresh run — the extensions' invalidation fields wipe summaries/memory in
  // this same atomic update, and runAfter unmarks compacted messages + clears
  // summaryception snippets (without this, the old story's snippets kept
  // injecting the previous playthrough into the new prompts).
  const restartInvalidation = collectExtensionInvalidation({ reason: "session-restart", sessionId });
  await db
    .update(playSessions)
    .set({
      state: initialState as unknown as Record<string, unknown>,
      ...restartInvalidation.sessionFields,
      updatedAt: new Date(),
    })
    .where(eq(playSessions.id, sessionId));
  await restartInvalidation.runAfter();

  // 6. Update existing greeting in-place or insert new one (with multi-greeting swipes)
  const greetings = promptBuilder.buildGreetings(worldDef, baseInitialState);
  let greetingMessage = null;
  if (greetings.length > 0) {
    // Each swipe carries its OWN opening's snapshot (base + that opening's
    // initialVariables + activeGreetingId), aligned index-for-index with the
    // greeting strings — so switching openings applies that route's variables.
    const swipes = greetings.map((content, i) => ({
      content,
      stateSnapshot: snapshotForGreeting(restartGreetingEntries[i]) as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    }));
    if (firstAssistant) {
      await db
        .update(messages)
        .set({
          content: greetings[0]!,
          swipes,
          activeSwipeIndex: 0,
          stateSnapshot: initialState as unknown as Record<string, unknown>,
        })
        .where(eq(messages.id, firstAssistant.id));
      greetingMessage = { ...firstAssistant, content: greetings[0]!, swipes, activeSwipeIndex: 0, stateSnapshot: initialState as unknown as Record<string, unknown> };
    } else {
      const result = await db
        .insert(messages)
        .values({
          sessionId,
          role: "assistant",
          content: greetings[0]!,
          stateSnapshot: initialState as unknown as Record<string, unknown>,
          swipes,
          activeSwipeIndex: 0,
        })
        .returning();
      greetingMessage = result[0] ?? null;
    }
  }

  return c.json({
    data: {
      state: initialState,
      messages: greetingMessage ? [greetingMessage] : [],
    },
  });
});

// ─── Branching ──────────────────────────────────────────────────────

// node-postgres encodes the Bind message's parameter count as an int16, so a
// single multi-row INSERT breaks the wire protocol past 65,535 bound values
// (pg reports it as "bind message has N parameter formats but 0 parameters").
// Message rows bind ~18 columns each, which made branching fail for every
// session past ~3.6k messages. Same total work, split into protocol-safe
// chunks inside the caller's transaction.
const INSERT_CHUNK_ROWS = 1_000;
function chunkRows<T>(rows: T[], size = INSERT_CHUNK_ROWS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export async function branchSession(args: {
  userId: string;
  sessionId: string;
  messageId: string;
}): Promise<{
  status: 201 | 400 | 404 | 500;
  body: {
    data?: { sessionId: string; name: string | null; parentSessionId: string | null; branchedFromMessageId: string | null };
    error?: string;
  };
}> {
  // Verify ownership
  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, args.sessionId), eq(playSessions.userId, args.userId)));

  if (sessionRows.length === 0) {
    return { status: 404, body: { error: "Session not found" } };
  }

  const parent = sessionRows[0]!;

  // Load all parent messages in order
  const allMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, args.sessionId))
    .orderBy(asc(messages.createdAt));

  const branchIdx = allMessages.findIndex((m) => m.id === args.messageId);
  if (branchIdx === -1) {
    return { status: 404, body: { error: "Message not found in this session" } };
  }

  const messagesToCopy = allMessages.slice(0, branchIdx + 1);

  // Pre-generate the branch's message ids so cross-references that point at
  // PARENT message ids — the session-memory processed pointer and the cloned
  // snippets' source-message ids — can be remapped onto the branch's own rows.
  const idMap = new Map(messagesToCopy.map((m) => [m.id, randomUUID()]));

  // Determine the state snapshot at the branch point.
  // Walk backwards from the branch message to find the latest stateSnapshot.
  let branchState: Record<string, unknown> = parent.state as Record<string, unknown>;
  for (let i = branchIdx; i >= 0; i--) {
    const snap = messagesToCopy[i]!.stateSnapshot as Record<string, unknown> | null;
    if (snap) {
      branchState = snap;
      break;
    }
  }

  // Load world def to normalize the branch state against the current schema
  // (variables the world no longer declares get dropped; missing defaults are
  // filled in). This keeps branches valid even when the world has evolved
  // since the pivot message was recorded.
  const worldRows = await db.select().from(worlds).where(eq(worlds.id, parent.worldId));
  if (worldRows.length === 0) {
    return { status: 404, body: { error: "World not found" } };
  }
  // Branch normalizes against the creator's working copy when they own a held
  // edit, so working-copy-only vars survive the branch. See resolveSessionWorldSchema.
  const branchSchema = await resolveSessionWorldSchema(worldRows[0]!, args.userId);
  const worldDef = migrateWorldDefinition(branchSchema as unknown as WorldDefinition);
  const normalizedState = normalizeGameState(worldDef, branchState);

  // ── Summary/compaction consistency (Q2, 2026-06-10) ──────────────────────
  // Invariant: every compacted=true message in the BRANCH must be covered by
  // the BRANCH's summary — compacted messages are excluded from prompt
  // assembly on the assumption the summary replaces them.
  //
  //   parent:  [m1 m2 m3 m4]ᶜᵒᵐᵖᵃᶜᵗᵉᵈ m5 m6 m7     summary covers m1-m4
  //   branch @ m6  → summary valid (covers only copied messages)   → KEEP
  //   branch @ m2  → summary describes m3,m4 the branch never had  → DROP
  //                  + reset compacted flags so m1,m2 re-enter prompts
  //
  // Checked directly from the flags (any compacted message BEYOND the branch
  // point ⇒ the summary covers content the branch excludes) instead of
  // summaryCoversUntilMessageId, which can be null on legacy rows.
  // Same rule for the summaryception variant, which additionally must CLONE
  // its snippet rows — before this, branches copied summaryceptionCompacted
  // flags but never the snippets, leaving a silent context hole on every
  // summaryception branch.
  const compactedBeyondBranch = allMessages.some((m, i) => i > branchIdx && m.compacted);
  const keepSummary = hasStorySummary(parent.summary) && !compactedBeyondBranch;
  const summaryceptionBeyondBranch = allMessages.some((m, i) => i > branchIdx && m.summaryceptionCompacted);
  const parentSnippets = await db
    .select()
    .from(summaryceptionSnippets)
    .where(eq(summaryceptionSnippets.sessionId, args.sessionId));
  // Keeping flags without their snippets would be the pre-existing hole; flags
  // without ANY snippets (legacy broken branches) get healed to raw messages.
  const keepSummaryception = !summaryceptionBeyondBranch && parentSnippets.length > 0;

  // Structured session memory is a rolling latest-state pointer (no range
  // gating), valid in the branch iff the turn it last processed is among the
  // copied messages — its facts derive only from turns up to that message. The
  // pointer references a PARENT message id, so it's remapped to the clone in the
  // insert below. A mid-flight update is fine: the job moved the pointer to the
  // turn it is folding when it started, so a copied pointer still proves the
  // stored (older) memory describes copied turns only (same rule as
  // invalidateForRevert — revert and branch must agree).
  // The pointer MAY be the branch tip itself (branching at the exact turn the
  // memory last folded): kept anyway — wiping destroyed the whole accumulated
  // memory for a one-exchange lag-one bend, the same tradeoff the revert path
  // makes; a swipe/edit of a covered tip stamps the stale-confession.
  const memProcId = parent.sessionMemoryProcessedMessageId;
  const keepSessionMemory =
    parent.sessionMemory != null &&
    memProcId != null &&
    idMap.has(memProcId);

  const parentPersona = captureSessionPersona(await resolvePersonaForSession(parent));
  const [account] = await db.select().from(user).where(eq(user.id, args.userId));
  applyPersonaMetadataToState(normalizedState, parentPersona.persona, account ?? {});
  const parentDisplayName = parent.name ?? "session";

  // Wrap the three writes (session + messages + memories) in one transaction
  // so a mid-operation failure can't leave an orphan branch row with no
  // messages behind. touchLibraryLastPlayed stays outside — it's bookkeeping
  // and must not roll back the branch on a library-update hiccup.
  const newSession = await db.transaction(async (tx) => {
    // Serialize concurrent branch attempts for the same parent session so
    // branch numbering is computed after the previous insert commits.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext(${args.userId}),
        hashtext(${args.sessionId})
      )
    `);

    // Generate branch name — "<parent name> · 分支 N"
    const existingBranches = await tx
      .select({ count: count() })
      .from(playSessions)
      .where(eq(playSessions.parentSessionId, args.sessionId));
    const branchNumber = (existingBranches[0]?.count ?? 0) + 1;
    const branchName = `${parentDisplayName} · 分支 ${branchNumber}`;

    const [inserted] = await tx
      .insert(playSessions)
      .values({
        userId: args.userId,
        worldId: parent.worldId,
        sessionPersona: parentPersona,
        personaLocked: parent.personaLocked,
        state: normalizedState as unknown as Record<string, unknown>,
        summary: keepSummary ? parent.summary : null,
        summaryModel: parent.summaryModel,
        stateGuardEnabled: parent.stateGuardEnabled,
        stateGuardModel: parent.stateGuardModel,
        summaryceptionModel: parent.summaryceptionModel,
        summaryImplementation: parent.summaryImplementation,
        summaryMode: parent.summaryMode,
        summaryIncluded: parent.summaryIncluded,
        summaryTriggerTokens: parent.summaryTriggerTokens,
        summaryRecentTailTokens: parent.summaryRecentTailTokens,
        summaryceptionIncluded: parent.summaryceptionIncluded,
        sessionMemoryIncluded: parent.sessionMemoryIncluded,
        sessionMemoryModel: parent.sessionMemoryModel,
        // Keep structured session memory only when valid for the branch (see
        // keepSessionMemory). Carry its bookkeeping so the branch's memory is
        // self-consistent; the processed pointer is remapped to the cloned id.
        sessionMemory: keepSessionMemory ? parent.sessionMemory : null,
        sessionMemoryProcessedMessageId: keepSessionMemory ? idMap.get(memProcId!)! : null,
        sessionMemorySourceHash: keepSessionMemory ? parent.sessionMemorySourceHash : null,
        sessionMemoryUpdatedAt: keepSessionMemory ? parent.sessionMemoryUpdatedAt : null,
        // The player's own pinned notes are session config, not derived state:
        // a branch continues the same story, so it inherits them unconditionally.
        sessionMemoryPinned: parent.sessionMemoryPinned,
        name: branchName,
        parentSessionId: args.sessionId,
        branchedFromMessageId: args.messageId,
      })
      .returning();

    if (!inserted) {
      throw new Error("Failed to insert branch session");
    }

    // Clone messages with fresh ids
    if (messagesToCopy.length > 0) {
      const messageRows =
        messagesToCopy.map((m) => ({
          id: idMap.get(m.id)!,
          sessionId: inserted.id,
          role: m.role,
          content: m.content,
          status: m.status,
          errorMessage: m.errorMessage,
          stateChanges: m.stateChanges as Record<string, unknown> | null,
          swipes: m.swipes as Array<{
            content: string;
            stateChanges?: Record<string, unknown>;
            stateSnapshot?: Record<string, unknown>;
            createdAt: string;
            model?: string;
            tokenCount?: number;
          }>,
          activeSwipeIndex: m.activeSwipeIndex ?? 0,
          model: m.model,
          tokenCount: m.tokenCount,
          generationTimeMs: m.generationTimeMs,
          // Flags only survive when their covering summary/snippets do —
          // otherwise the message must re-enter prompt assembly as raw text.
          compacted: keepSummary ? m.compacted : false,
          summaryceptionCompacted: keepSummaryception ? m.summaryceptionCompacted : false,
          stateSnapshot: m.stateSnapshot as Record<string, unknown> | null,
          attachments: m.attachments as Array<{ type: string; mimeType: string; name: string; url: string }> | null,
          createdAt: m.createdAt ?? new Date(),
        }));
      for (const chunk of chunkRows(messageRows)) {
        await tx.insert(messages).values(chunk);
      }
    }

    // Clone summaryception snippets when their compacted flags survived —
    // the snippets ARE the summary content those flags point at.
    if (keepSummaryception) {
      const snippetRows = parentSnippets.map((s) => ({
        ...s,
        id: randomUUID(),
        sessionId: inserted.id,
        // Source ids referenced PARENT message rows; remap to the clones so
        // coverage stays anchored to messages that exist in the branch (the
        // source ordinals still bound the range if a legacy id is unmapped).
        sourceStartMessageId: s.sourceStartMessageId ? idMap.get(s.sourceStartMessageId) ?? null : null,
        sourceEndMessageId: s.sourceEndMessageId ? idMap.get(s.sourceEndMessageId) ?? null : null,
      }));
      for (const chunk of chunkRows(snippetRows)) {
        await tx.insert(summaryceptionSnippets).values(chunk);
      }
    }

    // Clone session-scoped memories (sessionId IS NULL memories are world-global and remain shared)
    const parentMemories = await tx
      .select()
      .from(worldMemories)
      .where(and(eq(worldMemories.sessionId, args.sessionId), eq(worldMemories.userId, args.userId)));

    if (parentMemories.length > 0) {
      await tx.insert(worldMemories).values(
        parentMemories.map((mem) => ({
          worldId: mem.worldId,
          userId: mem.userId,
          content: mem.content,
          category: mem.category,
          importance: mem.importance,
          sessionId: inserted.id,
        }))
      );
    }

    return inserted;
  });

  // Bookkeeping: touch userLibrary lastPlayedAt (outside the transaction)
  await touchLibraryLastPlayed(args.userId, parent.worldId, new Date());

  // Rebuild dropped session memory for the new branch from its copied
  // transcript, so it's populated when the user opens the branch instead of
  // empty until later turns rebuild it. Kept memory was copied intact above and
  // needs no regen. The story summary is NOT regenerated on fork: the branch's
  // copied prefix is identical to the parent up to the fork point, so a kept
  // summary still fits and a dropped one re-forms via threshold compaction.
  regenerateDroppedMemoryTiers({
    sessionId: newSession.id,
    userId: args.userId,
    session: newSession,
    keptSessionMemory: keepSessionMemory,
    regenerateStorySummary: false,
  });

  return {
    status: 201,
    body: {
      data: {
        sessionId: newSession.id,
        name: newSession.name,
        parentSessionId: newSession.parentSessionId,
        branchedFromMessageId: newSession.branchedFromMessageId,
      },
    },
  };
}

// POST /api/sessions/:id/branch — fork a new session from a specific message
// Body: { messageId: string }
sessionRoutes.post("/:id/branch", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { messageId?: string };

  if (!body.messageId) {
    return c.json({ error: "messageId is required" }, 400);
  }

  const result = await branchSession({
    userId: currentUser.id,
    sessionId,
    messageId: body.messageId,
  });
  return c.json(result.body, result.status);
});

// GET /api/sessions/:id/branch-context — return current/parent/siblings/children
// as a pre-computed branch tree slice. Used by the BranchPopover and any
// sandbox card that wants to render its own branch manager.
sessionRoutes.get("/:id/branch-context", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");
  const rd = await readOwn(currentUser.id);

  const currentRows = await rd
    .select({
      id: playSessions.id,
      name: playSessions.name,
      parentSessionId: playSessions.parentSessionId,
      branchedFromMessageId: playSessions.branchedFromMessageId,
      createdAt: playSessions.createdAt,
      updatedAt: playSessions.updatedAt,
    })
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)));

  if (currentRows.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }
  const current = currentRows[0]!;

  const [parentRows, siblingRows, childRows] = await Promise.all([
    current.parentSessionId
      ? rd
          .select({
            id: playSessions.id,
            name: playSessions.name,
            parentSessionId: playSessions.parentSessionId,
            branchedFromMessageId: playSessions.branchedFromMessageId,
            createdAt: playSessions.createdAt,
            updatedAt: playSessions.updatedAt,
          })
          .from(playSessions)
          .where(and(
            eq(playSessions.id, current.parentSessionId),
            eq(playSessions.userId, currentUser.id),
          ))
      : Promise.resolve([] as Array<{
          id: string;
          name: string | null;
          parentSessionId: string | null;
          branchedFromMessageId: string | null;
          createdAt: Date;
          updatedAt: Date;
        }>),
    current.parentSessionId
      ? rd
          .select({
            id: playSessions.id,
            name: playSessions.name,
            parentSessionId: playSessions.parentSessionId,
            branchedFromMessageId: playSessions.branchedFromMessageId,
            createdAt: playSessions.createdAt,
            updatedAt: playSessions.updatedAt,
          })
          .from(playSessions)
          .where(and(
            eq(playSessions.parentSessionId, current.parentSessionId),
            ne(playSessions.id, sessionId),
            eq(playSessions.userId, currentUser.id),
          ))
          .orderBy(asc(playSessions.createdAt))
      : Promise.resolve([] as Array<{
          id: string;
          name: string | null;
          parentSessionId: string | null;
          branchedFromMessageId: string | null;
          createdAt: Date;
          updatedAt: Date;
        }>),
    rd
      .select({
        id: playSessions.id,
        name: playSessions.name,
        parentSessionId: playSessions.parentSessionId,
        branchedFromMessageId: playSessions.branchedFromMessageId,
        createdAt: playSessions.createdAt,
        updatedAt: playSessions.updatedAt,
      })
      .from(playSessions)
      .where(and(
        eq(playSessions.parentSessionId, sessionId),
        eq(playSessions.userId, currentUser.id),
      ))
      .orderBy(asc(playSessions.createdAt)),
  ]);

  const allIds = [
    current.id,
    ...parentRows.map((r) => r.id),
    ...siblingRows.map((r) => r.id),
    ...childRows.map((r) => r.id),
  ];

  const counts = allIds.length > 0
    ? await rd
        .select({ sessionId: messages.sessionId, count: count() })
        .from(messages)
        .where(inArray(messages.sessionId, allIds))
        .groupBy(messages.sessionId)
    : [];
  const countMap = new Map(counts.map((r) => [r.sessionId, Number(r.count)]));

  type BranchNode = {
    id: string;
    name: string | null;
    parentSessionId: string | null;
    branchedFromMessageId: string | null;
    messageCount: number;
    updatedAt: string;
    createdAt: string;
  };

  const toNode = (row: {
    id: string;
    name: string | null;
    parentSessionId: string | null;
    branchedFromMessageId: string | null;
    createdAt: Date | null;
    updatedAt: Date | null;
  }): BranchNode => ({
    id: row.id,
    name: row.name,
    parentSessionId: row.parentSessionId,
    branchedFromMessageId: row.branchedFromMessageId,
    messageCount: countMap.get(row.id) ?? 0,
    updatedAt: (row.updatedAt ?? new Date(0)).toISOString(),
    createdAt: (row.createdAt ?? new Date(0)).toISOString(),
  });

  return c.json({
    data: {
      current: toNode(current),
      parent: parentRows[0] ? toNode(parentRows[0]) : null,
      siblings: siblingRows.map(toNode),
      children: childRows.map(toNode),
    },
  });
});

// ─── Checkpoints ────────────────────────────────────────────────────

// POST /api/sessions/:id/checkpoints — create checkpoint
sessionRoutes.post("/:id/checkpoints", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");

  // Verify ownership
  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)));

  if (sessionRows.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  const session = sessionRows[0]!;
  await resolvePersonaForSession(session);

  // Snapshot all messages
  const allMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  // Auto-name: "Checkpoint #N"
  const existingCheckpoints = await db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.sessionId, sessionId));

  const name = `Checkpoint #${existingCheckpoints.length + 1}`;

  const result = await db
    .insert(checkpoints)
    .values({
      sessionId,
      name,
      messages: allMessages as unknown as Array<Record<string, unknown>>,
      state: session.state as Record<string, unknown>,
      summary: session.summary,
    })
    .returning();

  return c.json({
    data: {
      ...result[0]!,
      messageCount: allMessages.length,
    },
  }, 201);
});

// GET /api/sessions/:id/checkpoints — list checkpoints for session
sessionRoutes.get("/:id/checkpoints", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");

  // Verify ownership
  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)));

  if (sessionRows.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  const result = await db
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.sessionId, sessionId))
    .orderBy(desc(checkpoints.createdAt));

  // Return lightweight list (without full message snapshots)
  const list = result.map((cp) => ({
    id: cp.id,
    name: cp.name,
    messageCount: (cp.messages as unknown[]).length,
    createdAt: cp.createdAt,
  }));

  return c.json({ data: list });
});

// POST /api/sessions/:id/checkpoints/:checkpointId/restore — restore checkpoint
sessionRoutes.post("/:id/checkpoints/:checkpointId/restore", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");

  // Verify ownership
  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)));

  if (sessionRows.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Load checkpoint
  const cpRows = await db
    .select()
    .from(checkpoints)
    .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.sessionId, sessionId)));

  if (cpRows.length === 0) {
    return c.json({ error: "Checkpoint not found" }, 404);
  }

  await resolvePersonaForSession(sessionRows[0]!);
  const checkpoint = cpRows[0]!;
  const snapshotMessages = checkpoint.messages as unknown as Array<Record<string, unknown>>;
  const worldRows = await db.select().from(worlds).where(eq(worlds.id, sessionRows[0]!.worldId));
  if (worldRows.length === 0) return c.json({ error: "World not found" }, 404);

  // Creator's checkpoint restore normalizes against their held working copy so
  // working-copy-only vars aren't stripped. See resolveSessionWorldSchema.
  const cpSchema = await resolveSessionWorldSchema(worldRows[0]!, currentUser.id);
  const worldDef = migrateWorldDefinition(cpSchema as unknown as WorldDefinition);
  const restoredState = renewSocialEpoch(normalizeGameState(worldDef, checkpoint.state), randomUUID());
  applyPersonaMetadataToState(restoredState, await resolvePersonaForSession(sessionRows[0]!), currentUser);

  // Delete all current messages
  await db.delete(messages).where(eq(messages.sessionId, sessionId));

  // Re-insert messages from snapshot
  if (snapshotMessages.length > 0) {
    await db.insert(messages).values(
      snapshotMessages.map((m) => ({
        id: m.id as string,
        sessionId,
        role: m.role as "user" | "assistant" | "system",
        content: m.content as string,
        stateChanges: (m.stateChanges ?? null) as Record<string, unknown> | null,
        swipes: (Array.isArray(m.swipes) ? m.swipes : []) as Array<{
          content: string;
          stateChanges?: Record<string, unknown>;
          stateSnapshot?: Record<string, unknown>;
          createdAt: string;
          model?: string;
          tokenCount?: number;
        }>,
        activeSwipeIndex: (m.activeSwipeIndex as number) ?? 0,
        model: (m.model as string) ?? null,
        tokenCount: (m.tokenCount as number) ?? null,
        generationTimeMs: (m.generationTimeMs as number) ?? null,
        compacted: (m.compacted as boolean) ?? false,
        stateSnapshot: (m.stateSnapshot ?? null) as Record<string, unknown> | null,
        attachments: (m.attachments ?? null) as Array<{ type: string; mimeType: string; name: string; url: string }> | null,
        createdAt: m.createdAt ? new Date(m.createdAt as string) : new Date(),
      }))
    );
  }

  // Restore session state + summary. Checkpoints CAPTURE the story summary,
  // so this route restores those fields itself; the extensions' invalidation
  // fields (reason: checkpoint-restore) drop what checkpoints don't capture —
  // summaryception snippets and structured session memory — in the same
  // atomic update, or prompts would inject content from the pre-restore
  // timeline.
  const invalidation = collectExtensionInvalidation({ reason: "checkpoint-restore", sessionId });
  await db
    .update(playSessions)
    .set({
      state: restoredState as unknown as Record<string, unknown>,
      ...invalidation.sessionFields,
      summary: checkpoint.summary,
      summaryUpdatedAt: checkpoint.summary ? new Date() : null,
      summaryStatus: "idle",
      summaryError: null,
      summarySourceHash: null,
      summaryCoversUntilMessageId: null,
      summaryTokenCount: checkpoint.summary ? Math.ceil(checkpoint.summary.length / 4) : null,
      updatedAt: new Date(),
    })
    .where(eq(playSessions.id, sessionId));
  await invalidation.runAfter();

  // Return restored messages + state
  const restoredMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt));

  return c.json({
    data: {
      state: restoredState,
      messages: restoredMessages,
    },
  });
});

// DELETE /api/sessions/:id/checkpoints/:checkpointId — delete checkpoint
sessionRoutes.delete("/:id/checkpoints/:checkpointId", async (c) => {
  const currentUser = c.get("user");
  const sessionId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");

  // Verify ownership
  const sessionRows = await db
    .select()
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)));

  if (sessionRows.length === 0) {
    return c.json({ error: "Session not found" }, 404);
  }

  const result = await db
    .delete(checkpoints)
    .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.sessionId, sessionId)))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Checkpoint not found" }, 404);
  }

  return c.json({ data: { deleted: true } });
});

// DELETE /api/worlds/:worldId/memories — clear all memories for a world
sessionRoutes.delete("/worlds/:worldId/memories", async (c) => {
  const currentUser = c.get("user");
  const worldId = c.req.param("worldId");

  await db
    .delete(worldMemories)
    .where(
      and(eq(worldMemories.worldId, worldId), eq(worldMemories.userId, currentUser.id))
    );

  return c.json({ data: { cleared: true } });
});

type PlaytimeEvent = "resume" | "tick" | "pause" | "stop";

// Playtime decisions and capture commit under the same session-row lock.
sessionRoutes.post("/:id/playtime", async (c) => {
  const currentUser=c.get("user"),sessionId=c.req.param("id");
  const body=await c.req.json().catch(()=>({})) as {event?:unknown;leaseId?:unknown;recentInput?:unknown;recoverElapsed?:unknown};
  if(!["resume","tick","pause","stop"].includes(String(body.event)))return c.json({error:"Invalid playtime event"},400);
  if(typeof body.leaseId!=="string"||!body.leaseId.trim()||body.leaseId.length>200)return c.json({error:"leaseId is required"},400);
  const leaseId=body.leaseId.trim(),event=body.event as "resume"|"tick"|"pause"|"stop";
  let worldId:string|null=null;
  let observedAt=0;
  try {
    const result=await db.transaction(async tx=>{
      await tx.execute(sql`SET LOCAL lock_timeout = '250ms'`);
      const [session]=await tx.select({id:playSessions.id,worldId:playSessions.worldId,leaseId:playSessions.playtimeLeaseId,
        seenAt:playSessions.playtimeLastSeenAt,syncedAt:playSessions.lastHeartbeatAt}).from(playSessions)
        .where(and(eq(playSessions.id,sessionId),eq(playSessions.userId,currentUser.id))).for("update");
      if(!session)return null;
      worldId=session.worldId;
      const now=new Date();
      observedAt=+now;
      const decision=playtimeDecision(session,event,leaseId,now,body.recoverElapsed===true);
      if(!decision.accepted)return decision;
      await tx.update(playSessions).set({
        playtimeLeaseId:decision.active?leaseId:null,
        playtimeLastSeenAt:decision.active?now:null,
        lastHeartbeatAt:decision.active?decision.syncedAt:null,
        ...(decision.deltaSeconds>0?{playtimeSeconds:sql`${playSessions.playtimeSeconds} + ${decision.deltaSeconds}`}:{})
      }).where(eq(playSessions.id,sessionId));
      if(decision.deltaSeconds>0)await tx.execute(enqueueLifetimePlaytime(currentUser.id,decision.deltaSeconds));
      if(process.env.ANALYTICS_CAPTURE_ENABLED==="true"&&decision.deltaSeconds>0){
        // Store exactly the awarded seconds, including UTC midnight crossings.
        // Overlapping sessions are unioned per person by warehouse reports.
        const end=decision.syncedAt ?? now;
        const start=new Date(+end-decision.deltaSeconds*1000);
        const id=`${sessionId}:${leaseId}:${session.syncedAt!.toISOString()}`;
        await tx.execute(sql`INSERT INTO analytics_play_intervals (id,user_id,world_id,started_at,ended_at)
          VALUES (${id},${currentUser.id},${session.worldId},${start.toISOString()},${end.toISOString()}) ON CONFLICT (id) DO NOTHING`);
      }
      return decision;
    });
    if(!result)return c.json({error:"Session not found"},404);
    if(process.env.ANALYTICS_CAPTURE_ENABLED==="true" && result.accepted && worldId && redis?.status==="ready") {
      // Analytics never delays the playtime response. Missing Redis/input
      // evidence fails closed; the next accepted tick can recover capture.
      const world=worldId,at=observedAt;
      const key="analytics:engagement:v1:"+createHash("sha256").update(sessionId+":"+leaseId).digest("hex");
      void redis.eval(PLAY_ENGAGEMENT_LUA,1,key,at,result.deltaSeconds,event==="tick"&&body.recentInput===true?"1":"0")
        .then(async qualified=>{
          if(Number(qualified)!==1)return;
          const id=`engaged:${sessionId}:${Math.floor(at/60000)}`;
          await db.execute(sql`INSERT INTO analytics_activity(id,user_id,world_id,occurred_at,surface,action)
            VALUES (${id},${currentUser.id},${world},${new Date(at).toISOString()},'play','foreground-engaged-60s') ON CONFLICT(id) DO NOTHING`);
        }).catch(error=>captureServerError("ugc-engagement-capture",error));
    }
    if(result.accepted&&event==="resume"&&worldId)await touchLibraryLastPlayed(currentUser.id,worldId,new Date());
    return c.json({data:result});
  }catch(error){
    let cause:unknown=error;
    for(let depth=0;cause&&depth<5;depth++){
      const e=cause as {code?:string;cause?:unknown};
      if(e.code==="55P03")return c.json({data:{accepted:false,active:event!=="pause"&&event!=="stop",reason:"tick-contended",deltaSeconds:0}});
      cause=e.cause;
    }
    throw error;
  }
});

export { sessionRoutes };

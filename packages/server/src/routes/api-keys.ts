import { getCatalogImageSupport, ensureOpenRouterCatalog } from "../lib/llm/model-catalog.js";
import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { encryptApiKey, decryptApiKey } from "../lib/crypto.js";
import { createProvider } from "../lib/llm/provider-factory.js";
import type { ProviderName } from "../lib/llm/provider-factory.js";
import type { AppEnv } from "../lib/types.js";
import type { ApiKeyMetadata, PromptPostProcessing } from "@yumina/shared";
import { MAX_API_KEY_LABEL } from "@yumina/shared";
import { CustomProvider } from "../lib/llm/custom.js";
import { customEndpointFailure, verifyCustomConnection } from "../lib/llm/custom-connection.js";
import { validateCustomEndpointUrl } from "../lib/ssrf.js";
import { invalidateModelCacheForUser } from "./messages.js";
import { mergePrivateCatalog, privateCatalogIsFresh } from "../lib/private-model-catalog.js";

const apiKeyRoutes = new Hono<AppEnv>();

apiKeyRoutes.use("/*", authMiddleware);

const POST_PROC_VALUES: PromptPostProcessing[] = [
  "none", "merge", "merge_tools", "semi", "semi_tools", "strict", "strict_tools", "single",
];

interface MetadataInput {
  models?: string[];
  includeBody?: Record<string, unknown>;
  excludeBody?: string[];
  includeHeaders?: Record<string, string>;
  promptPostProcessing?: PromptPostProcessing;
  defaultModel?: string;
}

/** Validate metadata input from a client. Returns either a sanitized partial or an error. */
function validateMetadata(input: MetadataInput): { ok: true; value: Partial<ApiKeyMetadata> } | { ok: false; error: string } {
  const out: Partial<ApiKeyMetadata> = {};

  if (input.models !== undefined) {
    if (!Array.isArray(input.models) || !input.models.every((m) => typeof m === "string")) {
      return { ok: false, error: "models must be an array of strings" };
    }
    if (input.models.length > 500 || input.models.some((m) => m.length > 256)) {
      return { ok: false, error: "models: max 500 entries, each ≤ 256 chars" };
    }
    out.models = input.models;
  }

  if (input.includeBody !== undefined) {
    if (input.includeBody === null || typeof input.includeBody !== "object" || Array.isArray(input.includeBody)) {
      return { ok: false, error: "includeBody must be a JSON object" };
    }
    if (JSON.stringify(input.includeBody).length > 4096) {
      return { ok: false, error: "includeBody: payload too large (>4 KiB)" };
    }
    out.includeBody = input.includeBody;
  }

  if (input.excludeBody !== undefined) {
    if (!Array.isArray(input.excludeBody) || !input.excludeBody.every((s) => typeof s === "string")) {
      return { ok: false, error: "excludeBody must be an array of strings" };
    }
    if (input.excludeBody.length > 64) {
      return { ok: false, error: "excludeBody: max 64 entries" };
    }
    out.excludeBody = input.excludeBody;
  }

  if (input.includeHeaders !== undefined) {
    if (input.includeHeaders === null || typeof input.includeHeaders !== "object" || Array.isArray(input.includeHeaders)) {
      return { ok: false, error: "includeHeaders must be a JSON object of string→string" };
    }
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.includeHeaders)) {
      if (typeof v !== "string") return { ok: false, error: `includeHeaders.${k} must be a string` };
      if (/[\r\n\0]/.test(k) || /[\r\n\0]/.test(v)) return { ok: false, error: "header names/values cannot contain CR/LF/NUL" };
      if (k.length > 128 || v.length > 1024) return { ok: false, error: "header names ≤ 128 chars, values ≤ 1024 chars" };
      if (k.toLowerCase() === "authorization") return { ok: false, error: "Authorization header is managed by the stored key — do not override" };
      safe[k] = v;
    }
    if (Object.keys(safe).length > 32) return { ok: false, error: "includeHeaders: max 32 entries" };
    out.includeHeaders = safe;
  }

  if (input.promptPostProcessing !== undefined) {
    if (!POST_PROC_VALUES.includes(input.promptPostProcessing)) {
      return { ok: false, error: `promptPostProcessing must be one of: ${POST_PROC_VALUES.join(", ")}` };
    }
    out.promptPostProcessing = input.promptPostProcessing;
  }

  if (input.defaultModel !== undefined) {
    if (typeof input.defaultModel !== "string" || input.defaultModel.length > 256) {
      return { ok: false, error: "defaultModel must be a string ≤ 256 chars" };
    }
    out.defaultModel = input.defaultModel;
  }

  return { ok: true, value: out };
}

// POST /api/keys — store a new API key
apiKeyRoutes.post("/", async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json<{
    key: string;
    provider?: string;
    label?: string;
    baseUrl?: string;
  } & MetadataInput>();

  if (!body.key || typeof body.key !== "string") {
    return c.json({ error: "API key is required" }, 400);
  }
  if (body.label && body.label.length > MAX_API_KEY_LABEL) {
    return c.json({ error: `Label must be ${MAX_API_KEY_LABEL} characters or fewer` }, 400);
  }

  const provider = body.provider ?? "openrouter";

  // Custom-provider-specific validation
  let validatedBaseUrl: string | null = null;
  if (provider === "custom") {
    if (!body.baseUrl) {
      return c.json({ error: "Custom endpoints require a base URL" }, 400);
    }
    try {
      validatedBaseUrl = validateCustomEndpointUrl(body.baseUrl);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  } else if (body.baseUrl !== undefined) {
    return c.json({ error: "baseUrl is only valid for provider='custom'" }, 400);
  }

  // `defaultModel` and `models` are allowed on every provider (any profile can
  // remember its preferred model + its fetched model list). The remaining
  // metadata fields (includeBody/excludeBody/includeHeaders/promptPostProcessing)
  // are custom-only because they shape an OpenAI-compatible request body.
  let metadata: ApiKeyMetadata | null = null;
  if (provider === "custom") {
    const parsed = validateMetadata(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    metadata = { models: [], ...parsed.value };
  } else {
    if (body.includeBody !== undefined || body.excludeBody !== undefined || body.includeHeaders !== undefined || body.promptPostProcessing !== undefined) {
      return c.json({ error: "includeBody/excludeBody/includeHeaders/promptPostProcessing are only valid for provider='custom'" }, 400);
    }
    const parsed = validateMetadata({ models: body.models, defaultModel: body.defaultModel });
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (Object.keys(parsed.value).length > 0) metadata = parsed.value;
  }

  const { encrypted, iv, tag } = encryptApiKey(body.key);

  const result = await db
    .insert(apiKeys)
    .values({
      userId: currentUser.id,
      provider,
      encryptedKey: encrypted,
      keyIv: iv,
      keyTag: tag,
      label: body.label ?? "Default",
      baseUrl: validatedBaseUrl,
      metadata,
    })
    .returning();

  // New key changes the aggregated model list returned by GET /api/models.
  await invalidateModelCacheForUser(currentUser.id);
  return c.json({ data: result[0] }, 201);
});

// GET /api/keys — list keys (metadata only)
apiKeyRoutes.get("/", async (c) => {
  const currentUser = c.get("user");
  const result = await db
    .select({
      id: apiKeys.id,
      provider: apiKeys.provider,
      label: apiKeys.label,
      baseUrl: apiKeys.baseUrl,
      metadata: apiKeys.metadata,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, currentUser.id));

  return c.json({ data: result });
});

// PATCH /api/keys/:id — update custom endpoint fields
apiKeyRoutes.patch("/:id", async (c) => {
  const currentUser = c.get("user");
  const keyId = c.req.param("id");
  const body = await c.req.json<{ baseUrl?: string; label?: string; key?: string } & MetadataInput>();

  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id)));

  if (rows.length === 0) {
    return c.json({ error: "Key not found" }, 404);
  }

  const existing = rows[0]!;

  const patch: { baseUrl?: string; label?: string; metadata?: ApiKeyMetadata; encryptedKey?: string; keyIv?: string; keyTag?: string } = {};

  if (body.label !== undefined) {
    if (typeof body.label !== "string" || body.label.length === 0 || body.label.length > MAX_API_KEY_LABEL) {
      return c.json({ error: `Label must be a non-empty string of ${MAX_API_KEY_LABEL} characters or fewer` }, 400);
    }
    patch.label = body.label;
  }

  if (body.key !== undefined) {
    if (typeof body.key !== "string" || body.key.length === 0) {
      return c.json({ error: "key must be a non-empty string" }, 400);
    }
    const { encrypted, iv, tag } = encryptApiKey(body.key);
    patch.encryptedKey = encrypted;
    patch.keyIv = iv;
    patch.keyTag = tag;
  }

  // baseUrl is strictly custom-only
  if (body.baseUrl !== undefined && existing.provider !== "custom") {
    return c.json({ error: "baseUrl is only valid for provider='custom'" }, 400);
  }
  if (body.baseUrl !== undefined) {
    try {
      patch.baseUrl = validateCustomEndpointUrl(body.baseUrl);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  // includeBody/excludeBody/includeHeaders/promptPostProcessing reshape an
  // OpenAI-compatible request — only meaningful for custom proxies.
  const customShapeFieldGiven =
    body.includeBody !== undefined ||
    body.excludeBody !== undefined ||
    body.includeHeaders !== undefined ||
    body.promptPostProcessing !== undefined;
  if (customShapeFieldGiven && existing.provider !== "custom") {
    return c.json({ error: "includeBody/excludeBody/includeHeaders/promptPostProcessing are only valid for provider='custom'" }, 400);
  }

  // models / defaultModel are allowed on every provider.
  if (existing.provider === "custom") {
    const parsed = validateMetadata(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (Object.keys(parsed.value).length > 0) {
      patch.metadata = { ...((existing.metadata as ApiKeyMetadata | null) ?? {}), ...parsed.value };
    }
  } else if (body.models !== undefined || body.defaultModel !== undefined) {
    const parsed = validateMetadata({ models: body.models, defaultModel: body.defaultModel });
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (Object.keys(parsed.value).length > 0) {
      patch.metadata = { ...((existing.metadata as ApiKeyMetadata | null) ?? {}), ...parsed.value };
    }
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  if (body.key !== undefined || body.baseUrl !== undefined || body.includeHeaders !== undefined) {
    patch.metadata = { ...(patch.metadata ?? existing.metadata ?? {}), modelsSyncedAt: 0 };
  }

  const updated = await db
    .update(apiKeys)
    .set(patch)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id)))
    .returning();

  // Any field on the key (label, baseUrl, model whitelist, post-processing,
  // additional params) potentially affects what GET /api/models surfaces, so
  // drop the cache unconditionally here rather than tracking which field changed.
  await invalidateModelCacheForUser(currentUser.id);

  // Strip encrypted material before returning to client
  const row = updated[0];
  const safe = row && {
    id: row.id, provider: row.provider, label: row.label,
    baseUrl: row.baseUrl, metadata: row.metadata, createdAt: row.createdAt,
  };
  return c.json({ data: safe });
});

// DELETE /api/keys/:id — remove a key
apiKeyRoutes.delete("/:id", async (c) => {
  const currentUser = c.get("user");
  const keyId = c.req.param("id");

  const result = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id)))
    .returning();

  if (result.length === 0) {
    return c.json({ error: "Key not found" }, 404);
  }

  await invalidateModelCacheForUser(currentUser.id);
  return c.json({ data: { deleted: true } });
});

// POST /api/keys/:id/verify — quick connectivity check (legacy two-step verify)
apiKeyRoutes.post("/:id/verify", async (c) => {
  const currentUser = c.get("user");
  const keyId = c.req.param("id");

  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id)));

  if (rows.length === 0) {
    return c.json({ error: "Key not found" }, 404);
  }

  const row = rows[0]!;
  const decrypted = decryptApiKey(row.encryptedKey, row.keyIv, row.keyTag);
  if (!decrypted) return c.json({ data: { valid: false, reason: "Failed to decrypt API key — try re-saving it" } });

  if (row.provider === "custom") {
    if (!row.baseUrl) {
      return c.json({ data: { valid: false, reason: "Missing base URL on this key" } });
    }
    const custom = new CustomProvider(decrypted, row.baseUrl, (row.metadata as ApiKeyMetadata | null) ?? null);

    return c.json({ data: await verifyCustomConnection(custom, row.metadata as ApiKeyMetadata | null) });
  }

  try {
    const provider = createProvider(row.provider as ProviderName, decrypted);
    if (provider.verify) {
      const valid = await provider.verify();
      return c.json({ data: { valid } });
    }
    return c.json({ data: { valid: false, reason: "Provider does not support verification" } });
  } catch {
    return c.json({ data: { valid: false, reason: "Verification failed" } });
  }
});

/**
 * POST /api/keys/:id/list-models — fetch the model list this key can access.
 *
 * For provider='custom', hits upstream {baseUrl}/models with detailed status.
 * For other providers, calls provider.listModels() (e.g. OpenAI /v1/models).
 *
 * The returned list (with provider prefix stripped) is also cached into
 * metadata.models so resolve-provider and the chat picker can use it quickly.
 */
apiKeyRoutes.post("/:id/list-models", async (c) => {
  const currentUser = c.get("user");
  const keyId = c.req.param("id");

  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id)));

  if (rows.length === 0) {
    return c.json({ error: "Key not found" }, 404);
  }

  const row = rows[0]!;
  const imageCapabilities = (ids: string[]) => Object.fromEntries(ids.flatMap(id => {
    if (row.provider === "custom" || row.provider === "ollama") return [];
    const full = id.includes("/") || row.provider === "openrouter" ? id : `${row.provider}/${id}`;
    const support = getCatalogImageSupport(full);
    return support === undefined ? [] : [[full, support]];
  }));
  if (c.req.query("refresh") === "auto" && privateCatalogIsFresh(row.metadata)) {
    return c.json({ data: { ok: true, provider: row.provider, models: row.metadata?.models ?? [], imageCapabilities: imageCapabilities(row.metadata?.models ?? []) } });
  }
  // A fresh private catalog stays entirely local. Only OpenRouter refreshes
  // need its live modality catalog; other providers use the cached snapshot,
  // and custom endpoints must never trigger an unrelated provider request.
  if (row.provider === "openrouter") await ensureOpenRouterCatalog();
  const decrypted = decryptApiKey(row.encryptedKey, row.keyIv, row.keyTag);
  if (!decrypted) return c.json({ error: "Failed to decrypt API key — try re-saving it" }, 500);

  let bareIds: string[] = [];
  let status: number | undefined;

  if (row.provider === "custom") {
    if (!row.baseUrl) {
      return c.json({ error: "Missing base URL on this key" }, 400);
    }
    const custom = new CustomProvider(decrypted, row.baseUrl, (row.metadata as ApiKeyMetadata | null) ?? null);
    const detail = await custom.listModelsDetailed();
    if (!detail.ok || detail.models.length === 0) {
      return c.json({ data: {
        ok: false,
        status: detail.status,
        ...customEndpointFailure("models", detail.status, detail.reason),
        models: [],
      } });
    }
    bareIds = detail.models;
    status = detail.status;
  } else {
    try {
      const provider = createProvider(row.provider as ProviderName, decrypted);
      const models = await provider.listModels();
      // Strip the "{provider}/" prefix, leaving the bare upstream id (e.g. "gpt-4o").
      const prefix = `${row.provider}/`;
      bareIds = models.map((m) => (m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id));
    } catch (err) {
      return c.json({
        data: { ok: false, reason: `Failed to fetch model list: ${(err as Error).message}`, models: [] },
      });
    }
  }

  // Re-read under a short lock after the network call. Never overwrite a model
  // or request-setting edit made while the provider was responding.
  const nextMeta = await db.transaction(async (tx) => {
    const [latest] = await tx.select().from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id))).for("update");
    if (!latest || latest.encryptedKey !== row.encryptedKey || latest.baseUrl !== row.baseUrl ||
        JSON.stringify(latest.metadata?.includeHeaders) !== JSON.stringify(row.metadata?.includeHeaders)) return null;
    const metadata = mergePrivateCatalog(latest.metadata, bareIds);
    if (!metadata) return null;
    await tx.update(apiKeys).set({ metadata }).where(eq(apiKeys.id, keyId));
    return metadata;
  });
  if (!nextMeta) {
    return c.json({ data: { ok: false, status, reason: "No usable models returned or profile changed; saved models kept", models: [] } });
  }

  // Refreshed whitelist: invalidate the aggregated GET /api/models cache so the
  // chat picker (and the sandbox model modal that reads from it) reflects the
  // new list immediately instead of waiting up to 5 minutes for TTL.
  await invalidateModelCacheForUser(currentUser.id);

  return c.json({ data: { ok: true, status, provider: row.provider, models: nextMeta.models, imageCapabilities: imageCapabilities(nextMeta.models ?? []) } });
});

/**
 * POST /api/keys/:id/test — send a single non-streaming chat completion to verify
 * end-to-end the key+endpoint+model combination works. The "Send test message" button.
 * Body: { model: string; prompt?: string }
 */
apiKeyRoutes.post("/:id/test", async (c) => {
  const currentUser = c.get("user");
  const keyId = c.req.param("id");
  const body = await c.req.json<{ model?: string; prompt?: string }>().catch(() => ({} as { model?: string; prompt?: string }));

  if (!body.model || typeof body.model !== "string") {
    return c.json({ error: "model is required" }, 400);
  }
  const prompt = typeof body.prompt === "string" && body.prompt.length > 0 ? body.prompt.slice(0, 1000) : "Hi";

  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id)));

  if (rows.length === 0) {
    return c.json({ error: "Key not found" }, 404);
  }

  const row = rows[0]!;
  if (row.provider !== "custom") {
    return c.json({ error: "test is only supported for provider='custom'" }, 400);
  }
  if (!row.baseUrl) {
    return c.json({ error: "Missing base URL on this key" }, 400);
  }

  const decrypted = decryptApiKey(row.encryptedKey, row.keyIv, row.keyTag);
  if (!decrypted) return c.json({ error: "Failed to decrypt API key — try re-saving it" }, 500);
  const custom = new CustomProvider(decrypted, row.baseUrl, (row.metadata as ApiKeyMetadata | null) ?? null);
  const result = await custom.sendTestMessage(body.model, prompt);

  if (!result.ok) {
    return c.json({ data: {
      ok: false,
      status: result.status,
      ...customEndpointFailure("chat", result.status, result.reason),
    } });
  }

  return c.json({ data: { ok: true, status: result.status, reply: result.reply ?? "" } });
});

export { apiKeyRoutes };

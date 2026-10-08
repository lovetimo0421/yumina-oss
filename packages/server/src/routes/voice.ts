import { Hono, type Context } from "hono";
import type { PilotCleanupResult } from "../lib/voice-lifetime.js";
import { z } from "zod";
import type { AppEnv, SessionUser } from "../lib/types.js";
import { isVoiceSdp, isVoiceToolAllowlist, VOICE_MAX_INSTRUCTIONS, VoiceConnectionError, type VoiceConnectRequest, type VoiceToolName } from "../lib/voice-realtime.js";

export interface VoiceAvatarConnection {
  sessionId: string;
  livekitUrl: string;
  livekitClientToken: string;
  wsUrl: string;
  maxDurationSeconds: 300;
}
export interface VoiceAvatarRequest {
  userId: string;
  sessionId: string;
  connectionId: string;
  signal?: AbortSignal;
}
const avatarFailures = {
  AVATAR_UNAVAILABLE: { status: 503, message: "Live video is not available for this session." },
  AVATAR_PROVIDER_ERROR: { status: 502, message: "Live video could not connect. Please try again." },
  AVATAR_TIMEOUT: { status: 504, message: "The live video connection timed out. Please try again." },
  AVATAR_CANCELLED: { status: 408, message: "The live video connection was cancelled." },
  AVATAR_CONNECTION_PENDING: { status: 429, message: "A live video call is already active. Stop it before starting another." },
  AVATAR_DAILY_LIMIT: { status: 429, message: "The testing live video daily limit has been reached. Please try again tomorrow." },
  AVATAR_STOP_FAILED: { status: 503, message: "Live video cleanup is still pending. Please try stopping again." },
} as const;
/** Safe public failures live at the edition-neutral service boundary. */
export class VoiceAvatarError extends Error {
  readonly status: (typeof avatarFailures)[keyof typeof avatarFailures]["status"];
  constructor(readonly code: keyof typeof avatarFailures) {
    super(avatarFailures[code].message);
    this.name = "VoiceAvatarError";
    this.status = avatarFailures[code].status;
  }
}

export interface VoiceRouteServices {
  /** Null means outside hosted balance policy. An unavailable result must not
   * fall through to another key/funding mechanism. */
  balanceConfig?(userId: string, sessionId: string): Promise<Record<string, unknown> | null>;
  authenticate(c: Context<AppEnv>): Promise<Pick<SessionUser, "id" | "isBanned" | "isSuspended"> | null>;
  ownsSession(sessionId: string, userId: string): Promise<boolean>;
  getOpenAiKey(userId: string): Promise<string | null>;
  checkRateLimit(userId: string): Promise<{ retryAfter: number } | null>;
  acquireConnection(userId: string): Promise<boolean>;
  releaseConnection(userId: string): Promise<void>;
  connect(request: VoiceConnectRequest): Promise<string>;
  /** Host-controlled rollout; a world cannot enable another paid transport. */
  liveAvailable?(): boolean;
  getTestingKey?(): string | null;
  getPilotKey?(userId: string, sessionId: string): Promise<string | null>;
  connectPilot?(request: VoiceConnectRequest & { sessionId: string; connectionId: string }): Promise<string>;
  stopPilot?(userId: string, sessionId: string, connectionId: string): Promise<PilotCleanupResult|null|void>;
  connectSponsored?(request: VoiceConnectRequest & { sessionId: string; connectionId?: string; sponsored?: boolean }): Promise<string>;
  stopSponsored?(userId: string, sessionId: string, connectionId?: string): Promise<void>;
  avatarAvailable?(): boolean;
  startAvatar?(request: VoiceAvatarRequest): Promise<VoiceAvatarConnection>;
  stopAvatar?(userId: string, sessionId: string, connectionId: string): Promise<void>;
  heartbeatAvatar?(userId: string, sessionId: string, connectionId: string): Promise<boolean>;
}

const connectSchema = z.object({
  sdp: z.string().refine(isVoiceSdp),
  voice: z.enum(["marin", "cedar"]).optional(),
  tools: z.custom<VoiceToolName[]>(isVoiceToolAllowlist).optional(),
  turnControl: z.enum(["client-v1", "live-v1"]).optional(),
  instructions: z.string().max(VOICE_MAX_INSTRUCTIONS).refine((value) => value.trim().length > 0),
}).strict();
const avatarStartSchema = z.object({}).strict();
const avatarAvailable = (deps: VoiceRouteServices) => Boolean(deps.startAvatar && deps.stopAvatar && deps.heartbeatAvatar && deps.avatarAvailable?.());

/** Injectable service boundary keeps route tests independent of DB/auth secrets. */
export function createVoiceRoutes(services: VoiceRouteServices | (() => Promise<VoiceRouteServices>)) {
  const routes = new Hono<AppEnv>();
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  for (const action of ["config", "stop"] as const) {
    routes.on(action === "config" ? "GET" : "POST", `/:sessionId/${action}`, async c => {
      try {
        const deps = typeof services === "function" ? await services() : services;
        const user = await deps.authenticate(c);
        if (!user) return c.json({ error: "Sign in to use live voice.", code: "UNAUTHORIZED" }, 401);
        const sessionId = c.req.param("sessionId")!;
        const connection=action==='stop'?readConnectionId(c.req.raw):undefined;
        if(action==='stop'&&connection&&/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)){
          // Exact retained pilot ownership authorizes cleanup only, including
          // deleted chats/restricted accounts. It grants no other transport.
          const cleanup=await deps.stopPilot?.(user.id,sessionId,connection);
          if(cleanup)return c.json({stopped:cleanup.status==='closed',cleanup:cleanup.status},cleanup.status==='pending'?202:200);
        }
        if (user.isBanned || user.isSuspended) return c.json({ error: "Live voice is unavailable for this account.", code: "VOICE_FORBIDDEN" }, 403);
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || !await deps.ownsSession(sessionId, user.id)) return c.json({ error: "Session not found.", code: "SESSION_NOT_FOUND" }, 404);
        if (action === "stop") {
          await deps.stopSponsored?.(user.id, sessionId, connection);
          return c.json({ stopped: true });
        }
        const balance = await deps.balanceConfig?.(user.id, sessionId);
        if (balance) return c.json(balance);
        const ownKey = await deps.getOpenAiKey(user.id);
        const funding = ownKey?.trim() ? "byok" : deps.connectSponsored && deps.getTestingKey?.() ? "testing"
          : deps.connectPilot && await deps.getPilotKey?.(user.id, sessionId) ? "private-pilot" : null;
        return c.json({ available: funding !== null, funding, maxDurationSeconds: 300, avatarAvailable: avatarAvailable(deps), turnControl: "client-v1", ...(deps.liveAvailable?.() ? { liveModel: "gpt-live-1" } : {}) });
      } catch { return c.json({ error: "Voice is temporarily unavailable. Please try again.", code: "VOICE_UNAVAILABLE" }, 503); }
    });
  }
  for (const action of ["start", "stop", "heartbeat"] as const) {
    routes.post(`/:sessionId/avatar/${action}`, async c => {
      try {
        const deps = typeof services === "function" ? await services() : services;
        const user = await deps.authenticate(c);
        if (!user) return c.json({ error: "Sign in to use live voice.", code: "UNAUTHORIZED" }, 401);
        if (user.isBanned || user.isSuspended) return c.json({ error: "Live voice is unavailable for this account.", code: "VOICE_FORBIDDEN" }, 403);
        const sessionId = c.req.param("sessionId")!;
        const connectionId = readConnectionId(c.req.raw);
        if (!connectionId) throw new VoiceConnectionError("INVALID_VOICE_REQUEST");
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || !await deps.ownsSession(sessionId, user.id)) {
          return c.json({ error: "Session not found.", code: "SESSION_NOT_FOUND" }, 404);
        }
        // Cleanup remains available when the testing flag or credentials are revoked.
        if (action === "stop") {
          await deps.stopAvatar?.(user.id, sessionId, connectionId);
          return c.json({ stopped: true });
        }
        if (action === "heartbeat") return c.json({ active: await deps.heartbeatAvatar?.(user.id, sessionId, connectionId) ?? false });
        if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
          return c.json({ error: "Voice connection requests must use JSON.", code: "INVALID_CONTENT_TYPE" }, 415);
        }
        if (!avatarStartSchema.safeParse(await readVoiceRequest(c.req.raw)).success) throw new VoiceConnectionError("INVALID_VOICE_REQUEST");
        if (!avatarAvailable(deps)) throw new VoiceAvatarError("AVATAR_UNAVAILABLE");
        const rateLimit = await deps.checkRateLimit(user.id);
        if (rateLimit) {
          c.header("Retry-After", String(Math.max(1, Math.ceil(rateLimit.retryAfter))));
          return c.json({ error: "Too many voice connection attempts. Please wait before trying again.", code: "VOICE_RATE_LIMITED" }, 429);
        }
        const connection = await deps.startAvatar!({ userId: user.id, sessionId, connectionId, signal: c.req.raw.signal });
        return c.json(connection);
      } catch (error) {
        if (error instanceof VoiceAvatarError || error instanceof VoiceConnectionError) return c.json({ error: error.message, code: error.code }, error.status);
        return c.json({ error: "Live video is temporarily unavailable. Please try again.", code: "AVATAR_UNAVAILABLE" }, 503);
      }
    });
  }
  routes.post("/:sessionId/connect", async (c) => {
    try {
      const deps = typeof services === "function" ? await services() : services;
      const currentUser = await deps.authenticate(c);
      if (!currentUser) return c.json({ error: "Sign in to use live voice.", code: "UNAUTHORIZED" }, 401);
      if (currentUser.isBanned || currentUser.isSuspended) {
        return c.json({ error: "Live voice is unavailable for this account.", code: "VOICE_FORBIDDEN" }, 403);
      }
      if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        return c.json({ error: "Voice connection requests must use JSON.", code: "INVALID_CONTENT_TYPE" }, 415);
      }
      const sessionId = c.req.param("sessionId");
      const body = connectSchema.safeParse(await readVoiceRequest(c.req.raw));
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || !body.success) {
        return c.json({ error: "Invalid voice connection request.", code: "INVALID_VOICE_REQUEST" }, 400);
      }
      if (body.data.turnControl === "live-v1" && (!deps.liveAvailable?.() || body.data.tools?.length !== 0)) {
        throw new VoiceConnectionError("INVALID_VOICE_REQUEST");
      }
      const rateLimit = await deps.checkRateLimit(currentUser.id);
      if (rateLimit) {
        c.header("Retry-After", String(Math.max(1, Math.ceil(rateLimit.retryAfter))));
        return c.json({ error: "Too many voice connection attempts. Please wait before trying again.", code: "VOICE_RATE_LIMITED" }, 429);
      }
      if (!await deps.ownsSession(sessionId, currentUser.id)) {
        return c.json({ error: "Session not found.", code: "SESSION_NOT_FOUND" }, 404);
      }
      if (await deps.balanceConfig?.(currentUser.id, sessionId)) {
        return c.json({ error: "This session uses normal-balance voice.", code: "VOICE_BALANCE_REQUIRED" }, 409);
      }
      const ownKey = await deps.getOpenAiKey(currentUser.id);
      const testingKey = !ownKey?.trim() && deps.connectSponsored ? deps.getTestingKey?.() : null;
      const pilotKey = !ownKey?.trim() && !testingKey && deps.connectPilot ? await deps.getPilotKey?.(currentUser.id, sessionId) : null;
      if (pilotKey && deps.connectPilot) {
        const connectionId = readConnectionId(c.req.raw);
        if (!connectionId || body.data.turnControl !== "client-v1" || body.data.tools?.length !== 0) throw new VoiceConnectionError("INVALID_VOICE_REQUEST");
        const sdp = await deps.connectPilot({ ...body.data, apiKey: pilotKey, userId: currentUser.id, sessionId, connectionId, signal: c.req.raw.signal });
        return c.json({ sdp, turnControl: "client-v1" });
      }
      const apiKey = ownKey?.trim() || testingKey;
      if (testingKey && deps.connectSponsored) {
        const sdp = await deps.connectSponsored({ ...body.data, apiKey: testingKey, userId: currentUser.id, sessionId, connectionId: readConnectionId(c.req.raw), signal: c.req.raw.signal });
        return c.json(body.data.turnControl ? { sdp, turnControl: body.data.turnControl } : { sdp });
      }
      if (!apiKey?.trim()) throw new VoiceConnectionError("OPENAI_KEY_REQUIRED");
      if (body.data.turnControl === "live-v1" && deps.connectSponsored) {
        const sdp = await deps.connectSponsored({ ...body.data, apiKey, userId: currentUser.id, sessionId,
          connectionId: readConnectionId(c.req.raw), signal: c.req.raw.signal, sponsored: false });
        return c.json({ sdp, turnControl: "live-v1" });
      }
      if (!await deps.acquireConnection(currentUser.id)) {
        c.header("Retry-After", "2");
        return c.json({ error: "A voice connection is already being established.", code: "VOICE_CONNECTION_PENDING" }, 429);
      }
      try {
        const sdp = await deps.connect({ ...body.data, apiKey, userId: currentUser.id, signal: c.req.raw.signal });
        return c.json(body.data.turnControl ? { sdp, turnControl: body.data.turnControl } : { sdp });
      } finally {
        // The shared concurrency limiter also expires abandoned slots.
        await deps.releaseConnection(currentUser.id).catch(() => {});
      }
    } catch (error) {
      if (error instanceof VoiceConnectionError) return c.json({ error: error.message, code: error.code }, error.status);
      // Database/auth/key failures must not disclose credentials or raw errors.
      return c.json({ error: "Voice is temporarily unavailable. Please try again.", code: "VOICE_UNAVAILABLE" }, 503);
    }
  });
  return routes;
}

function readConnectionId(request: Request): string | undefined {
  const value = request.headers.get("X-Voice-Connection-Id");
  if (value === null) return undefined;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new VoiceConnectionError("INVALID_VOICE_REQUEST");
  return value;
}

async function readVoiceRequest(request: Request): Promise<unknown> {
  const maxBytes = 128 * 1024;
  if (Number(request.headers.get("content-length")) > maxBytes) {
    throw new VoiceConnectionError("VOICE_REQUEST_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new VoiceConnectionError("VOICE_REQUEST_TOO_LARGE");
      }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return null; }
  } finally {
    reader.releaseLock();
  }
}

export const voiceRoutes = createVoiceRoutes(async () => (await import("../lib/voice-services.js")).voiceServices);

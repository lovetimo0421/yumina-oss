import type { SSEStreamingApi } from "hono/streaming";
import { publishRoomEvent } from "./room-manager.js";
import { findOpenRoomForSession, storyRoomChannel } from "./story-rooms.js";

type SSEMessage = Parameters<SSEStreamingApi["writeSSE"]>[0];

/** The host's own receipts: never forwarded to the other people in the room. */
const PRIVATE_DONE_KEYS = ["promptTrace", "credits", "consentNeeded"] as const;

type Publish = (key: string, event: string, payload: Record<string, unknown>) => Promise<void>;

/**
 * Mirrors a generation's SSE stream into its story room. Every event the
 * send / regenerate / continue stream writes to the host is re-published on
 * the room channel as `stream {event, data}` (same names, same payloads, data
 * parsed back to JSON), in write order, and `turn-done` follows the last one —
 * also on error or stop, flagged `error: true`. Members render the reply live
 * from it. Publishing never blocks or fails the host's stream.
 */
export class StoryRoomTee {
  private chain: Promise<void> = Promise.resolve();
  private messageId: string | null = null;
  private userMessageId: string | null = null;
  private errored = false;
  private finished = false;

  constructor(
    private readonly roomId: string,
    private readonly turnId: string | null,
    private readonly publish: Publish = publishRoomEvent,
  ) {}

  forward(message: SSEMessage): void {
    if (this.finished) return;
    const event = message.event ?? "message";
    if (event === "ping") return;
    if (typeof message.data !== "string") return;
    let data: unknown = message.data;
    try { data = JSON.parse(message.data); } catch { /* keep the raw string */ }
    if (event === "error") this.errored = true;
    if (event === "done" && data && typeof data === "object") {
      const done = { ...(data as Record<string, unknown>) };
      if (typeof done.messageId === "string") this.messageId = done.messageId;
      if (typeof done.userMessageId === "string") this.userMessageId = done.userMessageId;
      for (const key of PRIVATE_DONE_KEYS) delete done[key];
      data = done;
    }
    this.enqueue("stream", { event, data });
  }

  /** Publishes `turn-done` once, after every forwarded event. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const error = this.errored || !this.messageId;
    this.enqueue("turn-done", {
      messageId: this.messageId,
      userMessageId: this.userMessageId,
      turnId: this.turnId,
      ...(error ? { error: true } : {}),
    });
    await this.chain;
  }

  private enqueue(event: string, payload: Record<string, unknown>): void {
    const key = storyRoomChannel(this.roomId);
    this.chain = this.chain
      .then(() => this.publish(key, event, payload))
      .catch((error) => console.warn("[StoryRoom] publish failed", error instanceof Error ? error.message : error));
  }
}

/** A tee for this session's open room, or null when nobody else is watching. */
export async function openStoryRoomTee(sessionId: string, turnId?: string | null): Promise<StoryRoomTee | null> {
  const room = await findOpenRoomForSession(sessionId);
  return room ? new StoryRoomTee(room.id, turnId ?? null) : null;
}

/** Wraps a streamSSE handler so the tee's `turn-done` follows the stream's last write, whatever path it ends on. */
export function withStoryRoomTee(
  tee: StoryRoomTee | null,
  handler: (stream: SSEStreamingApi) => Promise<void>,
): (stream: SSEStreamingApi) => Promise<void> {
  if (!tee) return handler;
  return async (stream) => {
    try {
      await handler(stream);
    } finally {
      await tee.finish();
    }
  };
}

/** Pre-stream rejection of a room turn: members must not wait for a reply that never starts. */
export async function publishRoomTurnRejected(roomId: string, turnId: string): Promise<void> {
  await publishRoomEvent(storyRoomChannel(roomId), "turn-done", { messageId: null, userMessageId: null, turnId, error: true })
    .catch(() => {});
}

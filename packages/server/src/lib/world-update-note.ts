import { MAX_WORLD_UPDATE_CONTENT, MAX_WORLD_UPDATE_TITLE } from "@yumina/shared";

export interface WorldUpdateNoteInput {
  title: string;
  content: string | null;
  isMajor: boolean;
}

export type WorldUpdateNoteParseResult =
  | { ok: true; data: WorldUpdateNoteInput }
  | { ok: false; error: string };

export function parseWorldUpdateNoteBody(body: unknown): WorldUpdateNoteParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body" };
  }

  const input = body as Record<string, unknown>;
  if (typeof input.title !== "string" || !input.title.trim()) {
    return { ok: false, error: "Title is required" };
  }
  const title = input.title.trim();
  if (title.length > MAX_WORLD_UPDATE_TITLE) {
    return { ok: false, error: `Title must be ${MAX_WORLD_UPDATE_TITLE} characters or fewer` };
  }

  if (input.content != null && typeof input.content !== "string") {
    return { ok: false, error: "Content must be text" };
  }
  const content = typeof input.content === "string" && input.content.trim()
    ? input.content.trim()
    : null;
  if (content && content.length > MAX_WORLD_UPDATE_CONTENT) {
    return { ok: false, error: `Content must be ${MAX_WORLD_UPDATE_CONTENT} characters or fewer` };
  }

  if (input.isMajor != null && typeof input.isMajor !== "boolean") {
    return { ok: false, error: "isMajor must be a boolean" };
  }

  return {
    ok: true,
    data: { title, content, isMajor: input.isMajor === true },
  };
}

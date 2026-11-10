// Short films, host side: the film engine "shorts" (realtime-video/controller.ts) has each reply
// filmed on the server as ~5 s shots with sound, as long as the reply needs
// (POST /realtime-video/turn-clip/:id). It renders for a few minutes, past any request timeout,
// so the request only starts it and the film is polled for; the player keeps reading and typing
// meanwhile. The reply carries a client-only `turnVideo` status, and the finished film becomes
// part of the reply's text as video embeds, which the chat hides and the film window plays.

import { turnFilmNotesPath, turnVideoPaths } from "./turn-video-embeds";

export type TurnVideoFailureReason = "busy" | "credits" | "timeout" | "unavailable";
/** Where each shot of a film being made is. */
export type TurnShotState = "queued" | "rendering" | "done" | "failed";
/** Shot by shot, how a film being made is coming along (server: TurnClipProgress). */
type Progress = { shots?: number; done?: number; cells?: TurnShotState[]; clips?: (string | null)[]; texts?: string[] };
/** `shots`/`done`: the director's script so far (0 shots: still writing it); `cells`, `clips`
 *  (finished shots, played while the rest render) and `texts` (each shot's passage) by shot. */
export type TurnVideoStatus = ({ status: "rendering"; since: number } & Progress) | { status: "failed"; reason: TurnVideoFailureReason };

type Job = { status: "none" } | ({ status: "rendering" } & Progress) | { status: "done"; content: string; credits?: number } | { status: "failed"; reason: string };

const apiBase = import.meta.env.VITE_API_URL || "";
const SHOWN_REASONS = new Set<string>(["busy", "credits", "timeout", "unavailable"]);
const POLL_MS = 4000;
/** A film machine started from nothing boots for 2-10 min before a 6-8 min render, and a failed
 *  deployment falls back to the shared pool (20 + 12 min at most on the server); past this the
 *  film is given up. */
const GIVE_UP_MS = 35 * 60_000;

const polling = new Set<string>();

async function store() {
  return (await import("@/stores/chat")).useChatStore.getState();
}

/** The shots of a reply's film, as URLs in playing order (none: not filmed). */
export function turnVideoClips(content: string): string[] {
  return turnVideoPaths(content).map((path) => `${apiBase}${path}`);
}

/** The passage each shot of a reply's film films, from the film's notes (null: none kept,
 *  e.g. a film made before notes were). */
export async function turnFilmNotes(content: string): Promise<string[] | null> {
  const first = turnVideoPaths(content)[0];
  const path = first ? turnFilmNotesPath(first) : null;
  if (!path) return null;
  const r = await fetch(`${apiBase}${path}`).catch(() => null);
  const notes = r?.ok ? ((await r.json().catch(() => null)) as { shots?: { text?: string }[] } | null) : null;
  return notes?.shots?.map((s) => String(s.text ?? "")) ?? null;
}

async function getJob(messageId: string): Promise<Job | null> {
  const r = await fetch(`${apiBase}/api/realtime-video/turn-clip/${messageId}`, { credentials: "include" }).catch(() => null);
  return r?.ok ? ((await r.json()) as Job) : null;
}

/** Films one reply (a film already being made for it is followed instead) and resolves once it
 *  has landed, failed or been given up on, with the mushies it cost. `style`: the film's look,
 *  "source" (the card's own) or a preset (live, anime, painted). */
export async function filmTurn(messageId: string, style = "source"): Promise<number> {
  const message = (await store()).messages.find((m) => m.id === messageId);
  if (!message || message.role !== "assistant" || message.turnVideo?.status === "rendering") return 0;
  (await store()).updateMessage(messageId, { turnVideo: { status: "rendering", since: Date.now() } });
  const r = await fetch(`${apiBase}/api/realtime-video/turn-clip/${messageId}`, {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ style }),
  }).catch(() => null);
  const started = r?.ok ? ((await r.json()) as Job) : { status: "failed" as const, reason: r?.status === 403 ? "off" : "unavailable" };
  if (started.status === "failed" || started.status === "done") return settle(messageId, started);
  return follow(messageId, Date.now());
}

/** Polls a film that is rendering until it lands, fails or is given up on. */
async function follow(messageId: string, since: number): Promise<number> {
  if (polling.has(messageId)) return 0;
  polling.add(messageId);
  try {
    while (Date.now() - since < GIVE_UP_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!(await store()).messages.some((m) => m.id === messageId)) return 0; // left the session or deleted
      const job = await getJob(messageId);
      if (!job) continue;
      if (job.status === "rendering") {
        // How far the film is, shot by shot; finished shots play while the rest render.
        const now = (await store()).messages.find((m) => m.id === messageId)?.turnVideo;
        const next = { shots: job.shots, done: job.done, cells: job.cells, clips: job.clips?.map((c) => (c ? `${apiBase}${c}` : null)), texts: job.texts };
        if (now?.status === "rendering" && JSON.stringify([now.shots, now.done, now.cells, now.clips, now.texts]) !== JSON.stringify([next.shots, next.done, next.cells, next.clips, next.texts])) {
          (await store()).updateMessage(messageId, { turnVideo: { ...now, ...next } });
        }
        continue;
      }
      return settle(messageId, job);
    }
    return settle(messageId, { status: "failed", reason: "timeout" });
  } finally {
    polling.delete(messageId);
  }
}

async function settle(messageId: string, job: Job): Promise<number> {
  const chat = await store();
  const current = chat.messages.find((m) => m.id === messageId);
  if (!current) return 0;
  if (job.status === "done") {
    const active = current.activeSwipeIndex ?? 0;
    const swipes = current.swipes?.map((s, i) => (i === active ? { ...s, content: job.content } : s));
    chat.updateMessage(messageId, { content: job.content, ...(swipes ? { swipes } : {}), turnVideo: undefined });
    // The film was charged on the server: re-read the wallet.
    if (job.credits) (await import("@/edition/slots.state")).fetchCreditsForChat();
    return job.credits ?? 0;
  }
  if (job.status === "failed" && SHOWN_REASONS.has(job.reason)) {
    chat.updateMessage(messageId, { turnVideo: { status: "failed", reason: job.reason as TurnVideoFailureReason } });
  } else {
    chat.updateMessage(messageId, { turnVideo: undefined });
  }
  return 0;
}

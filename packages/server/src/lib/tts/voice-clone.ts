/**
 * 克隆声音: a recording someone uploads (or records in the browser) → a clean mono WAV fish.audio can build a
 * voice from. The file goes through the same guarded ffmpeg as every other upload (lib/generation/safe-media.ts):
 * its container is recognised from its first bytes and ffmpeg is told that exact demuxer.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerAllowed, ffRunner, safeInputFlags, sniffMediaContainer } from "../generation/safe-media.js";

/** Shortest recording that clones well enough to be worth it. */
export const CLONE_MIN_SECONDS = 5;
/** What is kept of a longer recording: fish.audio needs no more than this. */
export const CLONE_MAX_SECONDS = 90;
/** Largest file taken (a few minutes of a high-bitrate recording). */
export const CLONE_MAX_BYTES = 25 * 1024 * 1024;

const FFMPEG_TIMEOUT_MS = 60_000;

export class CloneAudioError extends Error {
  constructor(public readonly code: "AUDIO_FORMAT" | "AUDIO_TOO_SHORT" | "AUDIO_TOO_LARGE" | "MEDIA_UNAVAILABLE") { super(code); }
}

/** The recording as 24 kHz mono 16-bit WAV, cut to CLONE_MAX_SECONDS, and how long it is. */
export async function normalizeCloneAudio(input: Buffer): Promise<{ wav: Buffer; seconds: number }> {
  if (input.length > CLONE_MAX_BYTES) throw new CloneAudioError("AUDIO_TOO_LARGE");
  const container = sniffMediaContainer(input);
  if (!containerAllowed(container, "audio")) throw new CloneAudioError("AUDIO_FORMAT");
  const dir = await mkdtemp(join(tmpdir(), "yumina-clone-"));
  try {
    const src = join(dir, "in");
    const out = join(dir, "out.wav");
    await writeFile(src, input);
    try {
      await ffRunner.run("ffmpeg", ["-v", "error", "-y", ...safeInputFlags(container), "-i", src,
        "-vn", "-ac", "1", "-ar", "24000", "-sample_fmt", "s16", "-t", String(CLONE_MAX_SECONDS), out],
        { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new CloneAudioError("MEDIA_UNAVAILABLE");
      throw new CloneAudioError("AUDIO_FORMAT");
    }
    const wav = await readFile(out);
    // 24 kHz × 2 bytes, after the 44-byte header.
    const seconds = Math.max(0, wav.length - 44) / 48_000;
    if (seconds < CLONE_MIN_SECONDS) throw new CloneAudioError("AUDIO_TOO_SHORT");
    return { wav, seconds };
  } finally {
    void rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

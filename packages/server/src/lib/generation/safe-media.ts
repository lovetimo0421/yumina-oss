/**
 * Open-source edition copy. These ffmpeg helpers are pure and shared by voice
 * cloning and the workbench covers; the rest of lib/generation stays hosted.
 */
// ffmpeg/ffprobe on files people upload. ffmpeg guesses a file's format from its content, and some of the
// formats it guesses can open other things: an HLS playlist or a concat list fetches URLs and reads local
// files, subfile reads a byte range of another file. So an uploaded "video" is never handed to ffmpeg to
// guess: its container is recognised here from its first bytes, only the real audio/video containers pass,
// and ffmpeg is told that exact demuxer (-f), may use no protocol but a local file, and no other demuxer.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** ffmpeg's demuxer for each container we take. */
export type MediaContainer = "mov" | "matroska" | "mp3" | "wav" | "ogg" | "flac" | "aac";

const VIDEO_CONTAINERS: ReadonlySet<MediaContainer> = new Set(["mov", "matroska"]);
const AUDIO_CONTAINERS: ReadonlySet<MediaContainer> = new Set(["mov", "matroska", "mp3", "wav", "ogg", "flac", "aac"]);
/** Every demuxer ffmpeg may use on an uploaded file, whatever it is told. */
const FORMAT_WHITELIST = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,wav,ogg,flac,aac";

/** The MP4 family's box types that may open a file (ftyp normally; old QuickTime files start elsewhere). */
const MOV_FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"]);

/** The container a file's first bytes declare, or null when it is not one we take. */
export function sniffMediaContainer(buffer: Buffer): MediaContainer | null {
  if (buffer.length < 12) return null;
  const ascii = (from: number, to: number) => buffer.toString("latin1", from, to);
  if (MOV_FIRST_BOXES.has(ascii(4, 8))) return "mov";
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "matroska";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 3) === "ID3") return "mp3";
  if (buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0) {
    // A frame sync: AAC (ADTS) says layer 00, an MPEG audio frame layer 1-3.
    return (buffer[1]! & 0x06) === 0 ? "aac" : "mp3";
  }
  return null;
}

export function containerAllowed(container: MediaContainer | null, kind: "video" | "audio"): container is MediaContainer {
  return !!container && (kind === "video" ? VIDEO_CONTAINERS : AUDIO_CONTAINERS).has(container);
}

/** The flags that go before every `-i <uploaded file>`: this demuxer, local files only, no other demuxer. */
export function safeInputFlags(container: MediaContainer): string[] {
  return ["-protocol_whitelist", "file", "-format_whitelist", FORMAT_WHITELIST, "-f", container];
}

/** The runner every ffmpeg/ffprobe call on media goes through (tests watch it). */
export const ffRunner = { run: promisify(execFile) as (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }> };

import { extractAiCallsFromFiles, type FrontendAiCall } from "./ai-call-scan.js";
import { extractVariableReadsFromFiles } from "./variable-read-scan.js";

/**
 * What a card's frontend does, file by file.
 *
 * The frontend used to be one block on the canvas: a phone showing the live
 * interface, with a count of the variables it reads in the inspector. For the
 * stock chat that is the whole story. For a card whose logic LIVES in the
 * interface — fifty TSX files that run a stage, call two AIs and keep the
 * world in one json variable — it hid everything that made the card work, so
 * neither the creator's assistant nor another creator could see what was
 * there to understand or copy.
 *
 * This manifest is the honest list: each file, how big it is, which
 * variables it reads and writes, which AI calls it makes and which platform
 * APIs it leans on. It is derived, never stored, and read-only — a sticky
 * note stuck to a file row is how a creator adds what the scan cannot know.
 */

/** The sandbox API families a file reaches for, beyond variables. */
export type FrontendApiFamily =
  | "ai" | "room" | "voice" | "tts" | "storage" | "media" | "social" | "audio" | "assets" | "chat" | "session";

export interface FrontendFileFacts {
  file: string;
  bytes: number;
  lines: number;
  /** Variable names (or ids) this file reads with a literal key. */
  reads: string[];
  /** Variable names (or ids) this file writes with a literal key. */
  writes: string[];
  dynamicReads: number;
  dynamicWrites: number;
  aiCalls: FrontendAiCall[];
  uses: FrontendApiFamily[];
}

export interface FrontendManifest {
  files: FrontendFileFacts[];
  bytes: number;
  lines: number;
  reads: string[];
  writes: string[];
  dynamicReads: number;
  dynamicWrites: number;
  aiCalls: FrontendAiCall[];
  uses: FrontendApiFamily[];
}

const FAMILY_PATTERNS: Array<[FrontendApiFamily, RegExp]> = [
  ["ai", /\.ai\s*\.\s*(?:complete|decide|context)\s*\(/],
  ["room", /\.room\s*\.\s*(?:join|leave|sendInput|sendCommand|onFrame|voice)\s*\(/],
  ["voice", /\.voice\s*\.\s*(?:prepare|record|stop|cancel|setPrefs)\s*\(/],
  ["tts", /\.tts\s*\.\s*(?:speak|stop|preview|setPrefs|onPlaybackFrame)\s*\(/],
  ["storage", /\.storage\s*\.\s*(?:get|set|remove)\s*\(/],
  ["media", /\.media\s*\.\s*(?:list|upload|pick|remove)\s*\(/],
  ["social", /\.social\s*\.\s*(?:get|action|generate)\s*\(/],
  ["audio", /\.(?:playAudio|stopAudio|pauseAudio|resumeAudio|setAudioVolume)\s*\(/],
  ["assets", /@asset:|\.fetchAsset\s*\(/],
  ["chat", /\.(?:sendMessage|editMessage|deleteMessage|regenerateMessage|continueLastMessage|swipeMessage)\s*\(/],
  ["session", /\.(?:saveCheckpoint|restoreCheckpoint|branchFromMessage|revertToMessage|createSession|listSessions)\s*\(/],
];

const sortedUnique = (xs: Iterable<string>) => [...new Set(xs)].sort();

export function frontendFileFacts(file: string, source: string): FrontendFileFacts {
  const scan = extractVariableReadsFromFiles({ [file]: source });
  const uses = FAMILY_PATTERNS.filter(([, re]) => re.test(source)).map(([k]) => k);
  return {
    file,
    bytes: source.length,
    lines: source.length === 0 ? 0 : source.split("\n").length,
    reads: scan.names,
    writes: scan.writes,
    dynamicReads: scan.dynamicReads,
    dynamicWrites: scan.dynamicWrites,
    aiCalls: extractAiCallsFromFiles({ [file]: source }),
    uses,
  };
}

/** Files ordered as a reader wants them: the entry file first, then by how
 *  much they do (AI calls, variable traffic), then by size. */
export function frontendManifest(files: Record<string, string>, entryFile?: string): FrontendManifest {
  const facts = Object.entries(files)
    .filter((e): e is [string, string] => typeof e[1] === "string")
    .map(([file, source]) => frontendFileFacts(file, source));
  const weight = (f: FrontendFileFacts) =>
    (f.file === entryFile ? 1_000_000 : 0) + f.aiCalls.length * 10_000 + (f.reads.length + f.writes.length) * 1_000 + f.bytes / 1_000;
  facts.sort((a, b) => weight(b) - weight(a) || a.file.localeCompare(b.file));
  return {
    files: facts,
    bytes: facts.reduce((n, f) => n + f.bytes, 0),
    lines: facts.reduce((n, f) => n + f.lines, 0),
    reads: sortedUnique(facts.flatMap((f) => f.reads)),
    writes: sortedUnique(facts.flatMap((f) => f.writes)),
    dynamicReads: facts.reduce((n, f) => n + f.dynamicReads, 0),
    dynamicWrites: facts.reduce((n, f) => n + f.dynamicWrites, 0),
    aiCalls: facts.flatMap((f) => f.aiCalls),
    uses: [...new Set(facts.flatMap((f) => f.uses))] as FrontendApiFamily[],
  };
}

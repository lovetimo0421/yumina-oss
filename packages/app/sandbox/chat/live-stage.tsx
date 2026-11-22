/**
 * A live character beside the stock chat: a character entry with `portraitLive` (a `@rig:` ref, set on the canvas,
 * from 放进我的卡, or by the Studio assistant) stands next to the transcript, a column on a wide screen and a strip
 * above it on a narrow one. The card writes no code: the AI opens each reply with `[face: …]` (engine
 * buildLiveFaceBlock, asked only of cards that have one), the stream hands the tag through (keepSpeakerTag), and the
 * face follows the reply while the mouth moves as it streams or as the voice reads it.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { LiveStageLayout } from "./live-stage-layout";
import { makeChatT } from "./i18n";
import { parseLeadingSpeakerTag, stripFaceLines } from "@yumina/engine";
import { useYumina } from "../sandbox-context";
import { RigCharacter, type RigControls, type RigMood } from "../building-blocks/rig-character";
import { aiFrameIds, displayCharacterName, resolveSpeaker } from "./speaker";

/** The mood a face leaves her in once it has played. */
const REST: Record<string, RigMood> = {
  calm: "calm", neutral: "calm", happy: "happy", laugh: "happy", heart: "happy", wink: "happy",
  sad: "low", sigh: "low", lookdown: "low", angry: "annoyed", doubt: "annoyed", sleepy: "sleepy",
};
/** Moves that play once (a face is kept for the reply instead). */
const ONCE = new Set(["nod", "shake", "tilt"]);
/** How long a face shows: about one reply's reading. */
const FACE_SECONDS = 6;

/** Plays a face the AI named: the creator's own names and the generation page's labels work too (alive6 resolves
 *  them); a name it does not know does nothing. */
export function showFace(ctl: RigControls, face: string): void {
  const name = face.trim();
  if (!name) return;
  const key = name.toLowerCase();
  ctl.setMood(REST[key] ?? "calm");
  if (key === "calm" || key === "neutral") return;
  if (ONCE.has(key)) ctl.cue(name);
  else ctl.cue(name, { seconds: FACE_SECONDS, strength: 0.85 });
}

/** The face a reply named: its leading tag, else one on a line of its own. */
export function faceOf(text: string): string | null {
  return parseLeadingSpeakerTag(text).face ?? stripFaceLines(text).face ?? null;
}

interface LiveEntry { name: string; portraitLive?: string | null; portrait?: string | null; role?: string; enabled?: boolean }

/** Where the player's fold of the strip is kept: the card's own browser storage (the host scopes it per card). */
export const FOLD_KEY = "yumina:live-stage:folded";
type CardStorage = { get: (key: string) => Promise<string | null>; set: (key: string, value: string) => Promise<void>; remove: (key: string) => Promise<void> };

/** Folded only when the player folded it on this card; unknown or unreadable storage leaves her shown. */
export async function readFolded(storage: CardStorage | undefined): Promise<boolean> {
  try { return (await storage?.get(FOLD_KEY)) === "1"; } catch { return false; }
}
export async function writeFolded(storage: CardStorage | undefined, folded: boolean): Promise<void> {
  try { if (folded) await storage?.set(FOLD_KEY, "1"); else await storage?.remove(FOLD_KEY); } catch { /* kept for this page only */ }
}

/** Wraps the stock chat; a card without a live character gets its children back untouched. */
export function ChatLiveStage({ children }: { children: React.ReactNode }) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const live = useMemo(
    () => (api.entries as ReadonlyArray<LiveEntry>).filter((e) => e.role === "character" && e.enabled !== false && typeof e.portraitLive === "string" && e.portraitLive),
    [api.entries],
  );
  const [folded, setFolded] = useState(false);
  const storage = (api as { storage?: CardStorage }).storage;
  const hasLive = live.length > 0;
  useEffect(() => {
    if (!hasLive) return;
    let alive = true;
    void readFolded(storage).then((f) => { if (alive && f) setFolded(true); });
    return () => { alive = false; };
    // read once per card: the storage object is a new one on every host push
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLive]);
  if (!hasLive) return <>{children}</>;
  const toggle = () => setFolded((f) => { void writeFolded(storage, !f); return !f; });
  return (
    <LiveStageLayout stage={<LiveCharacterOnStage live={live} />}
      fold={{ folded, onToggle: toggle, avatar: live[0]!.portrait ?? null, hideLabel: t("liveStageHide"), showLabel: t("liveStageShow") }}>
      {children}
    </LiveStageLayout>
  );
}

function LiveCharacterOnStage({ live }: { live: LiveEntry[] }) {
  const api = useYumina();
  const ctl = useRef<RigControls | null>(null);
  const [ready, setReady] = useState(false);
  const aiFrames = useMemo(() => aiFrameIds(api.worldbooks), [api.worldbooks]);

  // What the newest reply says: the live stream, else the last reply's raw output (it alone keeps the tags).
  const last = useMemo(() => {
    const list = api.messages as Array<{ id?: string; role?: string; content?: string; swipes?: Array<{ rawContent?: string }>; activeSwipeIndex?: number }>;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i]!;
      if (m.role !== "assistant") continue;
      const swipe = m.activeSwipeIndex ?? 0;
      return { key: `${m.id}:${swipe}`, text: m.swipes?.[swipe]?.rawContent ?? m.content ?? "" };
    }
    return null;
  }, [api.messages]);
  const source = api.isStreaming ? { key: "stream", text: api.streamingContent ?? "" } : last;

  // Whose stage it is: the live character speaking now, else the one shown last, else the first.
  const [who, setWho] = useState(0);
  const speaker = useMemo(
    () => (source?.text ? resolveSpeaker(api.entries, source.text, aiFrames, api.worldbooks) : null),
    [api.entries, api.worldbooks, aiFrames, source?.text],
  );
  const speakingIndex = speaker ? live.findIndex((e) => displayCharacterName(e.name) === speaker.name) : -1;
  useEffect(() => { if (speakingIndex >= 0) setWho(speakingIndex); }, [speakingIndex]);
  const shown = live[Math.min(who, live.length - 1)]!;
  const herLine = speakingIndex >= 0 ? live[speakingIndex] === shown : live.length === 1 && !speaker;

  useEffect(() => { setReady(false); }, [shown.portraitLive]);

  // The face, once per reply (the stream and the reply it is saved as are the same one).
  const face = source?.text ? faceOf(source.text) : null;
  const applied = useRef<{ key: string; face: string } | null>(null);
  useEffect(() => {
    if (!ready || !ctl.current || !face || !source || !herLine) return;
    const prev = applied.current;
    applied.current = { key: source.key, face };
    if (prev && prev.face === face && (prev.key === source.key || prev.key === "stream")) return;
    showFace(ctl.current, face);
  }, [ready, face, source?.key, herLine]);

  // The mouth moves while her reply streams in (the voice readout moves it by its loudness: `voice`).
  const talking = api.isStreaming && herLine;
  useEffect(() => {
    const c = ctl.current;
    if (!ready || !c) return;
    if (talking) c.talk(600);
    else c.stopTalking();
  }, [talking, ready]);

  return (
    <RigCharacter key={shown.portraitLive!} pack={shown.portraitLive!} voice ctl={ctl} onReady={() => setReady(true)} />
  );
}

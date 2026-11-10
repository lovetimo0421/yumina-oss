import { UI_CANVAS_W, type RootComponent, type UiDoc } from "@yumina/engine";

/**
 * Who owns a card's interface, and what it costs to take it over.
 *
 * The visual editor writes `uiDoc` and save-time compiles that into
 * `rootComponent`. For a card whose rootComponent is hand-written TSX, doing so
 * replaces work that cannot be recovered — compiling code back into a document
 * is not possible, and no amount of care in the editor changes that. So the
 * takeover is a decision the creator makes explicitly, once, and the old files
 * are set aside rather than deleted.
 *
 * The one case that does NOT deserve a confirmation is the empty shell. Of the
 * 134 stored cards carrying a rootComponent, 96 are under 800 bytes with a
 * median of 56 — scaffolding a wizard left behind, not anybody's frontend.
 * Making those creators confirm an irreversible replacement of nothing would
 * teach them to click through the dialog that actually matters.
 */

export type InterfaceOwner =
  /** No rootComponent at all. */
  | "none"
  /** A rootComponent that renders nothing worth keeping. */
  | "shell"
  /** Output of the interface compiler — safe to regenerate without asking. */
  | "generated"
  /** Somebody wrote this. Taking it over is irreversible. */
  | "handwritten";

/**
 * Under this many non-whitespace characters across all files, a rootComponent
 * is probably scaffolding. Measured against the library: the 96 stored shells
 * top out at 312 characters and the smallest of the 38 real frontends is 1755,
 * so this line sits in 1443 characters of daylight.
 * (`packages/server/scripts/audit-interface-takeover.mjs` re-measures it.)
 */
const SHELL_MAX_CHARS = 800;

/**
 * Signs that a rootComponent renders something a person would miss.
 *
 * Size alone is not enough, and the audit found the counterexample: a card in
 * the library reads variables and draws with them in barely 300 characters.
 * Small-and-real is exactly the case where the classification failing costs
 * somebody their work, so both tests have to agree before a takeover happens
 * silently. Being wrong the other way costs one confirmation dialog.
 */
function rendersSomething(rc: RootComponent): boolean {
  const source = Object.values(rc.files ?? {}).join("");
  return (
    /\.map\s*\(/.test(source) ||
    /<img/i.test(source) ||
    /onClick/.test(source) ||
    /api\.(variables|setVariable|sendMessage)/.test(source) ||
    /React\.use(State|Effect|Memo)/.test(source)
  );
}

export function classifyInterface(rc: RootComponent | undefined): InterfaceOwner {
  if (!rc) return "none";
  if (rc.generatedFrom === "uiDoc") return "generated";
  const source = Object.values(rc.files ?? {}).join("");
  const small = source.replace(/\s+/g, "").length < SHELL_MAX_CHARS;
  return small && !rendersSomething(rc) ? "shell" : "handwritten";
}

/** Whether opening the visual editor on this card destroys something. */
export const takeoverNeedsConfirmation = (rc: RootComponent | undefined) =>
  classifyInterface(rc) === "handwritten";

/** Where a taken-over frontend is kept. Reverse-engineering it back into a
 *  document is impossible, but the code itself is not the part we are entitled
 *  to throw away. */
export const REPLACED_FILE = "_replaced-by-interface.tsx.bak";

/**
 * Set the hand-written entry aside so the takeover is recoverable by hand even
 * though it is not reversible by us. Other files (bundle folders, imports the
 * entry pulled in) stay where they are — they are still referenced by the
 * backup, and moving them would be the thing that actually loses the code.
 *
 * An existing backup is never overwritten. The path that would: convert a
 * hand-written card, export it back to code, then convert again — the second
 * pass would set the GENERATED file aside on top of the original author's, and
 * the code this whole gate exists to preserve would be gone for good. Later
 * backups get a number instead.
 */
export function setAsideHandwritten(rc: RootComponent): Record<string, string> {
  const entry = rc.entryFile || "index.tsx";
  const source = rc.files?.[entry];
  if (!source) return { ...(rc.files ?? {}) };
  const rest = { ...(rc.files ?? {}) };
  delete rest[entry];
  return { ...rest, [nextBackupName(rest)]: source };
}

function nextBackupName(files: Record<string, string>): string {
  if (!(REPLACED_FILE in files)) return REPLACED_FILE;
  const stem = REPLACED_FILE.replace(/\.tsx\.bak$/, "");
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}.tsx.bak`;
    if (!(candidate in files)) return candidate;
  }
}

const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * The document a card starts from. It is not empty: a card whose story has
 * nowhere to appear is not a card, so the transcript and the composer are
 * already placed, and the creator's first act is arranging around them rather
 * than discovering that the thing they built cannot be played.
 */
/**
 * The platform's chat, as a page of parts: the same transcript and input, on
 * the theme's ground rather than a painted one. What a bare-chat card becomes
 * the moment its creator adds anything to its screen.
 */
export function chatPageDoc(name?: string): UiDoc {
  const base = startingUiDoc();
  return { ...base, pages: base.pages.map((p) => ({ ...p, name: name ?? p.name, background: undefined })) };
}

export function startingUiDoc(height = 812): UiDoc {
  const composerH = 96;
  const gap = 12;
  return {
    version: 1,
    entryPageId: "page-1",
    pages: [
      {
        id: "page-1",
        name: "Main",
        height,
        background: { kind: "color", color: "#0b0b0f" },
        elements: [
          {
            id: `messages-${uid()}`,
            type: "messages",
            name: "Transcript",
            x: 0,
            y: 0,
            w: UI_CANVAS_W,
            h: height - composerH - gap,
          },
          {
            id: `composer-${uid()}`,
            type: "composer",
            name: "Input",
            x: 0,
            y: height - composerH,
            w: UI_CANVAS_W,
            h: composerH,
          },
        ],
      },
    ],
  };
}

// ── Playability ────────────────────────────────────────────────────────────

export interface PlayabilityWarning {
  code: "no-input" | "no-transcript" | "input-too-small" | "input-hidden";
  elementId?: string;
}

/** Roughly the height below which the composer cannot be typed into. */
const MIN_COMPOSER_H = 32;

/** Free CSS is the price of real freedom, and one of the things it buys is the
 *  ability to make a card nobody can type into. These are warnings, never
 *  blocks: a card driven entirely by buttons has no composer on purpose, and
 *  refusing to save it would be the tool overruling the creator about their own
 *  design. */
export function checkPlayability(doc: UiDoc): PlayabilityWarning[] {
  // A wrapped card's transcript and composer live in its BASE frontend, which
  // this checker cannot see into — warning that they are "missing" would
  // train creators to ignore the warning that matters.
  if (doc.base) return [];
  const warnings: PlayabilityWarning[] = [];
  const elements = doc.pages.flatMap((p) => p.elements);
  const inputs = elements.filter((el) => el.type === "composer" || el.type === "chat");
  const transcripts = elements.filter((el) => el.type === "messages" || el.type === "chat");

  if (inputs.length === 0) warnings.push({ code: "no-input" });
  if (transcripts.length === 0) warnings.push({ code: "no-transcript" });

  for (const el of inputs) {
    if (el.h < MIN_COMPOSER_H) warnings.push({ code: "input-too-small", elementId: el.id });
  }

  // CSS that removes the composer from play. Matched loosely on purpose: this
  // is a nudge toward a preview, not a linter, and a false positive costs a
  // dismissed warning while a false negative costs an unplayable card.
  const KILLED = /(display\s*:\s*none|visibility\s*:\s*hidden|pointer-events\s*:\s*none|opacity\s*:\s*0(?!\.))/i;
  const cardCss = doc.theme?.css ?? "";
  if (/play-composer/.test(cardCss) && KILLED.test(cardCss)) {
    warnings.push({ code: "input-hidden" });
  }
  for (const el of inputs) {
    if (el.css && KILLED.test(el.css)) warnings.push({ code: "input-hidden", elementId: el.id });
  }
  return warnings;
}

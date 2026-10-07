import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Worldbook } from "@yumina/engine";
import { LiveFrontendPreview } from "../preview/live-frontend-preview";
import { moduleSceneState } from "../preview/scene-state";

/** The card's frontend at 375 wide, shrunk to whatever room the page has. */
const PREVIEW_WIDTH = 375;
const PREVIEW_HEIGHT = 420;
const BOX_WIDTH = 260;
const SCALE = BOX_WIDTH / PREVIEW_WIDTH;

/**
 * What this module looks like when it is on.
 *
 * Not a decoration: a module with a screen of its own is a different place to
 * be in, and until now the page said so with a filename in a dropdown. The
 * preview renders the card's real frontend with the variables that open this
 * module forced on — the same thing the canvas draws in a module's frame, from
 * the same component, so the two cannot show different rooms.
 *
 * Mounted only when `book.frontendFile` is set. The renderer compiles the
 * card's TSX and runs its side effects (audio, timers), which is not something
 * to leave running under every module that has no screen at all.
 */
export function ModuleScenePreview({ book }: { book: Worldbook }) {
  const { t } = useTranslation("editor");
  // Stable object: a fresh one every render re-sends the variables.
  const overrides = useMemo(() => moduleSceneState(book) ?? undefined, [book]);

  return (
    <div className="mt-2">
      <div
        className="relative overflow-hidden rounded-lg border border-border/70 bg-background"
        style={{ width: BOX_WIDTH, height: PREVIEW_HEIGHT * SCALE }}
        aria-label={t("blueprint.blocks.scene")}
      >
        <div
          className="pointer-events-none absolute left-0 top-0 origin-top-left"
          style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, transform: `scale(${SCALE})` }}
        >
          <LiveFrontendPreview overrides={overrides} />
        </div>
      </div>
    </div>
  );
}

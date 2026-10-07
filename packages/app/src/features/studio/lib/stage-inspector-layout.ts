export const STAGE_INDEX_RAIL_WIDTH = 44;
export const STAGE_CANVAS_MIN_WIDTH = 560;
export const STAGE_INSPECTOR_MIN_WIDTH = 280;
export const STAGE_INSPECTOR_MAX_WIDTH = 520;
/** Matches CANVAS_WRITING_NODE_WIDTH: a folded row is written in this column,
 *  so it opens at least as wide as the same text would be on the board. The
 *  creator's own drag still wins — this is only where it starts. */
export const STAGE_INSPECTOR_DEFAULT_WIDTH = 420;
export const STAGE_INSPECTOR_OVERLAY_INSET = 12;

/** Measure the workspace, not the browser: sidebars and embedded Studio
 * layouts can leave a narrow canvas even on a wide display. The saved width
 * is a preference; temporarily constraining it never overwrites that choice. */
export function getStageInspectorLayout(stageWidth: number, preferredWidth: number) {
  const available = Number.isFinite(stageWidth) && stageWidth > 0
    ? Math.max(0, stageWidth - STAGE_INDEX_RAIL_WIDTH)
    : STAGE_INSPECTOR_DEFAULT_WIDTH + STAGE_INSPECTOR_OVERLAY_INSET * 2;
  const overlay = available < STAGE_CANVAS_MIN_WIDTH + STAGE_INSPECTOR_MIN_WIDTH;
  const maxWidth = Math.max(1, Math.min(STAGE_INSPECTOR_MAX_WIDTH,
    overlay ? available - STAGE_INSPECTOR_OVERLAY_INSET * 2 : available - STAGE_CANVAS_MIN_WIDTH));
  const minWidth = Math.min(STAGE_INSPECTOR_MIN_WIDTH, maxWidth);
  const preferred = Number.isFinite(preferredWidth) ? preferredWidth : STAGE_INSPECTOR_DEFAULT_WIDTH;
  return { overlay, minWidth, maxWidth, width: Math.max(minWidth, Math.min(maxWidth, preferred)) };
}

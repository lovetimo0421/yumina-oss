type Bounds = { x: number; y: number; width: number; height: number };

/** Fit the board width between the docks; tall cards remain vertically pannable. */
export function blueprintEntranceViewport(
  bounds: Bounds,
  width: number,
  insets: { left: number; right: number },
  top: number,
  height: number,
) {
  const available = width - insets.left - insets.right;
  const availableHeight = height - top - 56;
  if (!(bounds.width > 0) || !(bounds.height > 0) || available <= 48 || availableHeight <= 48) return null;
  const padding = 24;
  // Match ReactFlow's minimum, but do not impose the old 85% reading floor.
  const zoom = Math.max(0.12, Math.min(1, (available - padding * 2) / bounds.width));
  return {
    x: insets.left + available / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: top + padding - bounds.y * zoom,
    zoom,
  };
}

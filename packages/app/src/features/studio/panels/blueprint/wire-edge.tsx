import { BaseEdge, Position, getBezierPath, useInternalNode, type EdgeProps } from "@xyflow/react";

/**
 * A wire that does not cut through the blocks it joins.
 *
 * Every wire leaves a right-hand handle and lands on a left-hand one, which
 * is right while the target sits to the right. But the commonest wire on any
 * card — a behaviour changing a variable — runs the other way: variables
 * stand to the left of behaviours, so the wire left the behaviour's right
 * edge, looped back, and cut straight through both rows at head height. On
 * the tutorial's own sample it was the first wire a new author ever saw.
 *
 * When the target block ends before the source block begins, the wire
 * leaves the source's LEFT edge and lands on the target's RIGHT edge — the
 * short way, across the gap. The handles stay where they are; only the
 * drawn endpoints move.
 */
export function WireEdge({
  id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  markerEnd, style, label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius, interactionWidth,
}: EdgeProps) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  let sx = sourceX;
  let tx = targetX;
  let sp = sourcePosition;
  let tp = targetPosition;
  const fromBox = from?.internals.positionAbsolute;
  const toBox = to?.internals.positionAbsolute;
  const fromWidth = from?.measured?.width;
  const toWidth = to?.measured?.width;
  // Centres, not edges: tiles on the board abut and overlap by a border, so
  // "ends before it begins" is never quite true of two neighbours.
  const backwards = fromBox && toBox && fromWidth && toWidth && toBox.x + toWidth / 2 < fromBox.x + fromWidth / 2;
  if (backwards && sourcePosition === Position.Right && targetPosition === Position.Left) {
    sx = fromBox.x;
    sp = Position.Left;
    tx = toBox.x + toWidth;
    tp = Position.Right;
  }
  // Two abutting tiles leave no gap for a curve; a straight dash across
  // the seam, with the label just off it, says the same thing.
  const [path, labelX, labelY] = getBezierPath({ sourceX: sx, sourceY, sourcePosition: sp, targetX: tx, targetY, targetPosition: tp, curvature: Math.abs(tx - sx) < 40 ? 0 : 0.25 });
  return (
    <BaseEdge
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      label={label}
      labelStyle={labelStyle}
      labelBgStyle={labelBgStyle}
      labelBgPadding={labelBgPadding}
      labelBgBorderRadius={labelBgBorderRadius}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={interactionWidth}
    />
  );
}

import type { AtlasWorld, WorldReport } from "./admin-analytics.js";

function seed(id: string) {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967296;
}

/** Deterministic sparse audience graph; metrics never determine a misleading axis. */
export function layoutAtlas(
  worlds: AtlasWorld[],
  edges: WorldReport["edges"],
): AtlasWorld[] {
  const nodes = worlds.map((w) => ({
    ...w,
    x: 0.5 + 0.3 * Math.cos(seed(w.id) * Math.PI * 2),
    y: 0.5 + 0.3 * Math.sin(seed(w.id) * Math.PI * 2),
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (let step = 0; step < 100; step++) {
    const delta = new Map(
      nodes.map((n) => [
        n.id,
        { x: (0.5 - n.x) * 0.002, y: (0.5 - n.y) * 0.002 },
      ]),
    );
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!,
          b = nodes[j]!,
          dx = a.x - b.x,
          dy = a.y - b.y,
          d2 = Math.max(0.001, dx * dx + dy * dy);
        const force = 0.000035 / d2;
        delta.get(a.id)!.x += dx * force;
        delta.get(a.id)!.y += dy * force;
        delta.get(b.id)!.x -= dx * force;
        delta.get(b.id)!.y -= dy * force;
      }
    for (const edge of edges) {
      const a = byId.get(edge.from),
        b = byId.get(edge.to);
      if (!a || !b) continue;
      const strength = 0.008 * Math.sqrt(edge.similarity);
      delta.get(a.id)!.x += (b.x - a.x) * strength;
      delta.get(a.id)!.y += (b.y - a.y) * strength;
      delta.get(b.id)!.x += (a.x - b.x) * strength;
      delta.get(b.id)!.y += (a.y - b.y) * strength;
    }
    for (const n of nodes) {
      const d = delta.get(n.id)!;
      n.x = Math.max(
        0.06,
        Math.min(0.94, n.x + Math.max(-0.02, Math.min(0.02, d.x))),
      );
      n.y = Math.max(
        0.08,
        Math.min(0.92, n.y + Math.max(-0.02, Math.min(0.02, d.y))),
      );
    }
  }
  return nodes;
}

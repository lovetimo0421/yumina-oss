import { extractVariableReadsFromFiles, resolveStation, type CardGraph, type GraphEdge, type GraphNode, type Variable, type WorldDefinition } from "@yumina/engine";
import { getVariableIdUsage } from "@/features/editor/lib/variable-id-references";

export type RelationshipKind =
  | "trigger" | "condition" | "stop-condition" | "activate-module" | "activate-variable" | "gate-entry"
  | "write-value" | "toggle-variable" | "toggle-entry" | "seed-value" | "read-variable" | "display-entry"
  | "read-context" | "wake-module" | "audio" | "related";

export interface RelationshipObject {
  graphNodeId: string;
  /** Canonical authoring ID. Events and missing objects have no edit target. */
  objectId: string | null;
  kind: GraphNode["kind"] | "unknown";
  title: string;
  missing: boolean;
  inGraph: boolean;
}

export interface ObjectRelationship {
  id: string;
  kind: RelationshipKind;
  direction: "incoming" | "outgoing";
  target: RelationshipObject;
  label?: string;
  labelKey?: string;
  /** Exact structured locations, never matches in arbitrary prose. */
  paths: string[];
  edge?: GraphEdge;
  edgeIds: string[];
}

export interface ObjectRelationships {
  object: RelationshipObject;
  owner: RelationshipObject | null;
  members: RelationshipObject[];
  incoming: ObjectRelationship[];
  outgoing: ObjectRelationship[];
  hasDynamicCodeAccess: boolean;
}

interface AuthoredObject { id: string; kind: GraphNode["kind"]; title: string; ownerId?: string }
const isProjection = (id: string) => id === "core-entries" || id.startsWith("module-entries:") || id.startsWith("block:") || id.startsWith("frame:");
const isBehavior = (id: string) => id.startsWith("reaction:") || id.startsWith("rule:");
const referenceKeys = new Set(["variableId", "secondaryVariableId", "conditionVariableId", "valueRef", "candidatesVar", "historyVar"]);
const literalKeys = new Set(["defaultValue", "conditionValue", "fallback", "candidates", "items", "initialVariables"]);

/** Find missing structured targets too: toGraph intentionally drops several
 * dangling edges, while its entry/audio placeholder nodes can look real. */
function structuredVariableCandidates(world: WorldDefinition): Set<string> {
  const result = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value || value.startsWith("@")) return;
    const known = world.variables.find(variable => value === variable.id || value.startsWith(`${variable.id}.`) || value.startsWith(`${variable.id}[`));
    result.add(known?.id ?? value.split(/[.[]/, 1)[0]!);
  };
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(object)) {
      if (referenceKeys.has(key)) { add(child); continue; }
      if (key === "path") {
        add(typeof child === "string" && child.startsWith("@vars.enabled.") ? child.slice("@vars.enabled.".length) : child);
        continue;
      }
      if (literalKeys.has(key) || (key === "value" && ("operator" in object || object.type === "set" || object.type === "modify-variable"))) continue;
      walk(child);
    }
  };
  walk([world.entries, world.variables, world.rules, world.reactions, world.worldbooks, world.loreUiBindings]);
  for (const reaction of world.reactions ?? []) add(reaction.when.match?.variableId?.value);
  return result;
}

/** Direct authored relations, supplemented by engine-backed static references.
 * This reads the draft only. Membership is separate from causal dependency;
 * arbitrary prose and arbitrary JavaScript are never treated as dependencies. */
export function getObjectRelationships(world: WorldDefinition, graph: CardGraph, objectId: string): ObjectRelationships {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const authored = new Map<string, AuthoredObject>();
  const addObject = (id: string, kind: GraphNode["kind"], title: string, ownerId?: string) => {
    if (!authored.has(id)) authored.set(id, { id, kind, title, ownerId });
  };
  addObject("world:root", "world", world.name);
  for (const entry of world.entries) addObject(`${entry.role === "greeting" ? "greeting" : "entry"}:${entry.id}`, entry.role === "greeting" ? "greeting" : "entry", entry.name || entry.id, entry.worldbookId);
  for (const variable of world.variables) addObject(`var:${variable.id}`, "variable", variable.name || variable.id, variable.worldbookId);
  for (const rule of world.rules) addObject(`rule:${rule.id}`, "rule", rule.name || rule.id, rule.worldbookId);
  for (const reaction of world.reactions ?? []) addObject(`reaction:${reaction.id}`, "rule", reaction.name || reaction.id, reaction.worldbookId);
  for (const book of world.worldbooks ?? []) addObject(`module:${book.id}`, "module", book.name || book.id);
  for (const track of world.audioTracks ?? []) addObject(`audio:${track.id}`, "audio", track.name || track.id);
  for (const img of world.sceneImages ?? []) addObject(`image:${img.id}`, "image", img.name || img.id);
  if (world.rootComponent || world.uiDoc || (world.components?.length ?? 0) > 0 || (world.loreUiBindings?.length ?? 0) > 0) addObject("frontend", "component", world.rootComponent?.name || nodes.get("frontend")?.title || "frontend");

  const resolve = (id: string): RelationshipObject => {
    const node = nodes.get(id);
    const trackKey = id.startsWith("audio:") ? id.slice(6) : undefined;
    const track = trackKey === undefined ? undefined : world.audioTracks?.find(item => item.id === trackKey) ?? world.audioTracks?.find(item => item.name === trackKey);
    const canonical = track ? `audio:${track.id}` : id;
    const object = authored.get(canonical);
    const event = node?.kind === "event";
    const kind = object?.kind ?? node?.kind ?? (id.startsWith("var:") ? "variable" : id.startsWith("module:") ? "module" : id.startsWith("entry:") ? "entry" : id.startsWith("greeting:") ? "greeting" : id.startsWith("audio:") ? "audio" : "unknown");
    return { graphNodeId: id, objectId: object?.id ?? null, kind, title: object?.title || node?.title || id, missing: !object && !event, inGraph: nodes.has(id) };
  };
  const canonical = (id: string) => resolve(id).objectId ?? id;
  const sourceId = canonical(objectId);
  const relations = new Map<string, ObjectRelationship & { from: string; to: string; labels: Set<string> }>();
  const addRelation = (from: string, to: string, kind: RelationshipKind, path?: string, edge?: GraphEdge, label?: string, labelKey?: string) => {
    if (isProjection(from) || isProjection(to)) return;
    const fromId = canonical(from), toId = canonical(to);
    if (fromId !== sourceId && toId !== sourceId) return;
    const direction = toId === sourceId ? "incoming" : "outgoing";
    const resolvedLabelKey = labelKey ?? edge?.labelKey;
    const id = JSON.stringify([fromId, toId, kind, kind === "read-context" ? resolvedLabelKey : undefined]);
    let relation = relations.get(id);
    if (!relation) {
      relation = { id, from: fromId, to: toId, kind, direction, target: resolve(direction === "incoming" ? from : to), paths: [], edgeIds: [], labels: new Set() };
      relations.set(id, relation);
    }
    if (path && !relation.paths.includes(path)) relation.paths.push(path);
    if (edge) {
      relation.edge ??= edge;
      if (!relation.edgeIds.includes(edge.id)) relation.edgeIds.push(edge.id);
      if (edge.label) relation.labels.add(edge.label);
      // Prefer an actual graph anchor when structured data used a canonical ID.
      if (nodes.has(direction === "incoming" ? from : to)) relation.target = resolve(direction === "incoming" ? from : to);
    }
    if (resolvedLabelKey) relation.labelKey = resolvedLabelKey;
    if (label) relation.labels.add(label);
  };

  const variableEffectKind = (edge: GraphEdge): RelationshipKind => {
    const index = Number(edge.id.slice(edge.id.lastIndexOf(":") + 1));
    const effect = world.reactions?.find(item => `reaction:${item.id}` === edge.from)?.then[index];
    return effect && "path" in effect && typeof effect.path === "string" && effect.path.startsWith("@vars.enabled.") ? "toggle-variable" : "write-value";
  };
  for (const edge of graph.edges) {
    // The card→opening rail is collection scaffolding, not a trigger/configuration.
    if (edge.from === "world:root" && edge.to.startsWith("greeting:") && edge.fromPort === "openings") continue;
    let kind: RelationshipKind = "related";
    if (edge.labelKey === "contextWire.wakeOnClose") kind = "wake-module";
    else if (edge.from.startsWith("module:") && edge.to.startsWith("module:") && edge.labelKey?.startsWith("contextWire.")) kind = "read-context";
    else if (edge.toPort === "trigger") kind = "trigger";
    else if (edge.toPort === "condition") kind = "condition";
    else if (edge.toPort === "stop") kind = "stop-condition";
    else if (edge.to.startsWith("module:") && edge.toPort === "activate") kind = "activate-module";
    else if (edge.from.startsWith("greeting:") && edge.fromPort === "seeds") kind = "seed-value";
    else if (edge.to === "frontend" && edge.toPort.startsWith("read:")) kind = "read-variable";
    else if (edge.to === "frontend" && edge.toPort.startsWith("slot:")) kind = "display-entry";
    else if (isBehavior(edge.from) && edge.to.startsWith("var:")) kind = variableEffectKind(edge);
    else if (isBehavior(edge.from) && edge.to.startsWith("entry:")) kind = "toggle-entry";
    else if (isBehavior(edge.from) && edge.to.startsWith("audio:")) kind = "audio";
    else if (edge.from.startsWith("var:") && edge.to.startsWith("entry:")) kind = "gate-entry";
    addRelation(edge.from, edge.to, kind, undefined, edge);
  }

  const referenceOwner = (path: string): string | null => {
    const match = /^(entries|variables|reactions|rules|worldbooks)\[(\d+)\]/.exec(path);
    if (match) {
      const index = Number(match[2]);
      if (match[1] === "entries") { const entry = world.entries[index]; return entry ? `${entry.role === "greeting" ? "greeting" : "entry"}:${entry.id}` : null; }
      if (match[1] === "variables") return world.variables[index] ? `var:${world.variables[index]!.id}` : null;
      if (match[1] === "reactions") return world.reactions?.[index] ? `reaction:${world.reactions[index]!.id}` : null;
      if (match[1] === "rules") return world.rules[index] ? `rule:${world.rules[index]!.id}` : null;
      return world.worldbooks?.[index] ? `module:${world.worldbooks[index]!.id}` : null;
    }
    if (/^(loreUiBindings\[|components\[|uiDoc\.|uiBlueprint\.)/.test(path)) return "frontend";
    if (path.startsWith("settings.")) return "world:root";
    return null;
  };
  const interfaceWritePaths = new Set<string>();
  const visitInterfaceActions = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => visitInterfaceActions(item, `${path}[${index}]`)); return; }
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (object.kind === "set-variable" && typeof object.variableId === "string") {
      const target = `var:${object.variableId}`;
      const variablePath = `${path}.variableId`;
      interfaceWritePaths.add(variablePath);
      addRelation("frontend", target, "write-value", variablePath);
      // add/subtract/toggle read the existing value before writing it.
      if (object.op !== "set") addRelation(target, "frontend", "read-variable", `${path}.op`);
      return;
    }
    for (const [key, child] of Object.entries(object)) if (key !== "value" && key !== "defaultValue") visitInterfaceActions(child, `${path}.${key}`);
  };
  visitInterfaceActions(world.uiDoc, "uiDoc");
  const candidates = new Map(world.variables.map(variable => [variable.id, variable]));
  for (const id of structuredVariableCandidates(world)) if (!candidates.has(id)) candidates.set(id, { id, name: id, type: "string", defaultValue: "" });
  // Code reviews are advisory and unused here; scan the actual frontend once
  // below instead of reparsing every TSX file for each variable.
  const referenceWorld = { ...world, rootComponent: undefined, customUI: [] };
  for (const variable of candidates.values()) {
    for (const reference of getVariableIdUsage(referenceWorld, variable).references) {
      if (interfaceWritePaths.has(reference.path)) continue;
      const owner = referenceOwner(reference.path);
      if (!owner) continue;
      const path = reference.path;
      let kind: RelationshipKind = "read-variable";
      let writes = false;
      if (path.includes(".initialVariables[")) { kind = "seed-value"; writes = true; }
      else if (/^reactions\[\d+\]\.then\[\d+\]\.path$/.test(path)) {
        const match = /^reactions\[(\d+)\]\.then\[(\d+)\]/.exec(path)!;
        const effect = world.reactions![Number(match[1])]!.then[Number(match[2])];
        kind = effect && "path" in effect && typeof effect.path === "string" && effect.path.startsWith("@vars.enabled.") ? "toggle-variable" : "write-value";
        writes = true;
      } else if (/^rules\[\d+\]\.actions\[\d+\]\.variableId$/.test(path)) { kind = "write-value"; writes = true; }
      else if (path.includes(".stopConditions[")) kind = "stop-condition";
      else if (/^variables\[\d+\]\.activation\./.test(path)) kind = "activate-variable";
      else if (/^worldbooks\[\d+\]\.activation\./.test(path)) kind = "activate-module";
      else if (/^entries\[\d+\]\.conditions\[/.test(path)) kind = owner.startsWith("greeting:") ? "condition" : "gate-entry";
      else if (path.includes(".when.match.variableId.value")) {
        const index = Number(/^reactions\[(\d+)\]/.exec(path)?.[1]);
        // A != filter names an excluded variable; it does not say that this
        // variable's changes trigger the behavior.
        kind = world.reactions?.[index]?.when.match?.variableId?.operator === "eq" ? "trigger" : "related";
      } else if (/^rules\[\d+\]\.trigger\./.test(path)) kind = "trigger";
      else if (path.includes(".conditions[") || path.includes(".conditionVariableId") || path.includes(".valueRef")) kind = "condition";
      addRelation(writes ? owner : `var:${variable.id}`, writes ? `var:${variable.id}` : owner, kind, path);
    }
  }

  // Seeds accept either an ID or a legacy display name. Preserve that same
  // resolution order, including missing values that the graph cannot draw.
  const resolveVariable = (key: string): Variable | undefined => world.variables.find(variable => variable.id === key) ?? world.variables.find(variable => variable.name === key);
  for (const [index, entry] of world.entries.entries()) {
    if (entry.role !== "greeting") continue;
    for (const [key, value] of Object.entries(entry.initialVariables ?? {})) addRelation(`greeting:${entry.id}`, `var:${resolveVariable(key)?.id ?? key}`, "seed-value", `entries[${index}].initialVariables[${JSON.stringify(key)}]`, undefined, `= ${JSON.stringify(value)}`);
  }
  for (const [index, book] of (world.worldbooks ?? []).entries()) {
    if (book.activation.mode === "greeting") for (const greetingId of book.activation.greetingIds) addRelation(`greeting:${greetingId}`, `module:${book.id}`, "activate-module", `worldbooks[${index}].activation.greetingIds`);
    const station = resolveStation(book);
    const trigger = station?.trigger;
    if (trigger?.on === "module-closed" && trigger.from !== book.id) addRelation(`module:${trigger.from}`, `module:${book.id}`, "wake-module", `worldbooks[${index}].station.trigger.from`);
    for (const [inputIndex, input] of (station?.inputs ?? []).entries()) {
      if (input.from === book.id) continue;
      const source = input.from === "core" ? "world:root" : `module:${input.from}`;
      const path = book.station ? `worldbooks[${index}].station.inputs[${inputIndex}].from` : `worldbooks[${index}].memorySubscriptions[${inputIndex}].sourceBookId`;
      addRelation(source, `module:${book.id}`, "read-context", path, undefined, undefined, `contextWire.${input.kind}.${input.as === "lore" ? "lore" : "history"}`);
    }
  }
  for (const [index, binding] of (world.loreUiBindings ?? []).entries()) addRelation(`entry:${binding.entryId}`, "frontend", "display-entry", `loreUiBindings[${index}].entryId`);
  const uiScan = extractVariableReadsFromFiles(world.rootComponent?.files ?? {});
  for (const key of uiScan.names) addRelation(`var:${resolveVariable(key)?.id ?? key}`, "frontend", "read-variable");
  for (const key of uiScan.writes) addRelation("frontend", `var:${resolveVariable(key)?.id ?? key}`, "write-value");

  const object = resolve(objectId);
  const ownerId = authored.get(sourceId)?.ownerId;
  const owner = ownerId ? resolve(`module:${ownerId}`) : null;
  const moduleId = sourceId.startsWith("module:") ? sourceId.slice(7) : null;
  const members = moduleId === null ? [] : [...authored.values()].filter(item => item.ownerId === moduleId).map(item => resolve(item.id));
  const completed = [...relations.values()].map(({ from: _from, to: _to, labels, ...relation }) => ({ ...relation, ...(labels.size > 0 ? { label: [...labels].join(" · ") } : {}) }));
  return { object, owner, members, incoming: completed.filter(item => item.direction === "incoming"), outgoing: completed.filter(item => item.direction === "outgoing"), hasDynamicCodeAccess: uiScan.dynamicReads > 0 || uiScan.dynamicWrites > 0 };
}

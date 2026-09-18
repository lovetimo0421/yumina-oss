import { compileRulesToReactions, type Reaction, type ReactionEffect, type WorldDefinition } from "@yumina/engine";

/** The editor and runtime see both formats. Conversion happens only on a behavior edit. */
export function editableBehaviors(world: Pick<WorldDefinition, "rules" | "reactions">): Reaction[] {
  return [
    ...compileRulesToReactions(world.rules).map((r, index) => ({
      ...r,
      when: world.rules[index]!.trigger.type === "turn-count" && world.rules[index]!.trigger.atTurn !== undefined
        ? { ...r.when, _legacyTrigger: world.rules[index]!.trigger } : r.when,
      // Older import examples used null to mean unlimited.
      cooldownTurns: r.cooldownTurns ?? undefined,
      maxFireCount: r.maxFireCount ?? undefined,
    })),
    ...(world.reactions ?? []),
  ];
}

export function materializeBehaviors(world: WorldDefinition): WorldDefinition {
  if (world.rules.length === 0) return world;
  const convertedIds = new Set(world.rules.map(r => r.id));
  return {
    ...world, rules: [], reactions: editableBehaviors(world),
    ...(world.installedBundles ? { installedBundles: world.installedBundles.map(bundle => ({
      ...bundle,
      ruleIds: bundle.ruleIds.filter(id => !convertedIds.has(id)),
      reactionIds: [...new Set([...(bundle.reactionIds ?? []), ...bundle.ruleIds.filter(id => convertedIds.has(id))])],
    })) } : {}),
  };
}

/** Editing text must not turn a persistent directive into a one-shot context message. */
export function preserveLegacyEffect(original: ReactionEffect, updated: ReactionEffect): ReactionEffect {
  if (original.type === "set" && original.path.startsWith("@prompt.directive.") &&
      original.value !== false && updated.type === "set" && updated.path === "@prompt.context") {
    return { ...original, value: typeof original.value === "object" && original.value !== null
      ? { ...original.value, content: updated.value }
      : updated.value };
  }
  return updated;
}

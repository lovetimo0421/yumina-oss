import { resolveUIBlueprint } from "../components/ui-blueprint-resolver.js";
import type {
  CustomUIComponent,
  GameState,
  UIBlueprint,
  WorldDefinition,
} from "../types/index.js";
import type {
  UIPackage,
  UIPackageCollectionDiff,
  UIPackageDiff,
  UIPackageExportSeed,
  UIPackageValidationOptions,
  UIPackageValidationResult,
  UIPackageWorldValidationContext,
} from "../types/ui-package.js";

const DEFAULT_SUPPORTED_PACKAGE_MAJOR = 1;
const DEFAULT_SUPPORTED_BLUEPRINT_MAJOR = 1;

const EMPTY_BLUEPRINT: UIBlueprint = {
  version: "1.0",
  theme: { preset: "default", tokens: {} },
  layouts: [],
  components: [],
  bindings: [],
  triggers: [],
  interactions: [],
};

export function validateUIPackage(
  pkg: UIPackage,
  context: UIPackageWorldValidationContext,
  options: UIPackageValidationOptions = {}
): UIPackageValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const supportedPackageMajor =
    options.supportedPackageMajor ?? DEFAULT_SUPPORTED_PACKAGE_MAJOR;
  const supportedBlueprintMajor =
    options.supportedBlueprintMajor ?? DEFAULT_SUPPORTED_BLUEPRINT_MAJOR;

  const packageMajor = parseMajorVersion(pkg.schemaVersion);
  if (packageMajor === null) {
    errors.push(`Invalid schemaVersion "${pkg.schemaVersion}"`);
  } else if (packageMajor !== supportedPackageMajor) {
    errors.push(
      `Unsupported schemaVersion major ${packageMajor}. Supported major is ${supportedPackageMajor}.`
    );
  }

  const blueprintMajor = parseMajorVersion(pkg.uiBlueprint.version);
  if (blueprintMajor === null) {
    errors.push(`Invalid uiBlueprint.version "${pkg.uiBlueprint.version}"`);
  } else if (blueprintMajor !== supportedBlueprintMajor) {
    errors.push(
      `Unsupported uiBlueprint.version major ${blueprintMajor}. Supported major is ${supportedBlueprintMajor}.`
    );
  }

  const variableIds = new Set(context.variables.map((variable) => variable.id));
  for (const requiredId of pkg.summary.requiresVariableIds) {
    if (!variableIds.has(requiredId)) {
      errors.push(
        `summary.requiresVariableIds contains missing variable "${requiredId}"`
      );
    }
  }

  const layoutIdSet = new Set<string>();
  const componentIdSet = new Set<string>();
  const triggerIdSet = new Set<string>();

  for (const layout of pkg.uiBlueprint.layouts) {
    if (layoutIdSet.has(layout.id)) {
      errors.push(`Duplicate layout id "${layout.id}"`);
    }
    layoutIdSet.add(layout.id);
  }

  for (const component of pkg.uiBlueprint.components) {
    if (componentIdSet.has(component.id)) {
      errors.push(`Duplicate component id "${component.id}"`);
    }
    componentIdSet.add(component.id);
  }

  for (const trigger of pkg.uiBlueprint.triggers ?? []) {
    if (triggerIdSet.has(trigger.id)) {
      errors.push(`Duplicate trigger id "${trigger.id}"`);
    }
    triggerIdSet.add(trigger.id);
  }

  for (const layout of pkg.uiBlueprint.layouts) {
    for (const componentId of layout.componentIds ?? []) {
      if (!componentIdSet.has(componentId)) {
        errors.push(
          `Layout "${layout.id}" references missing component "${componentId}" in componentIds`
        );
      }
    }
    for (const triggerId of layout.triggerIds ?? []) {
      if (!triggerIdSet.has(triggerId)) {
        errors.push(
          `Layout "${layout.id}" references missing trigger "${triggerId}" in triggerIds`
        );
      }
    }
  }

  for (const component of pkg.uiBlueprint.components) {
    if (component.layoutId && !layoutIdSet.has(component.layoutId)) {
      errors.push(
        `Component "${component.id}" references missing layout "${component.layoutId}"`
      );
    }
    for (const triggerId of component.triggerIds ?? []) {
      if (!triggerIdSet.has(triggerId)) {
        errors.push(
          `Component "${component.id}" references missing trigger "${triggerId}" in triggerIds`
        );
      }
    }
  }

  for (const trigger of pkg.uiBlueprint.triggers ?? []) {
    for (const condition of trigger.conditions ?? []) {
      if (!variableIds.has(condition.variableId)) {
        errors.push(
          `Trigger "${trigger.id}" references missing variable "${condition.variableId}"`
        );
      }
    }
  }

  for (const binding of pkg.uiBlueprint.bindings ?? []) {
    if (!componentIdSet.has(binding.targetId)) {
      errors.push(
        `Binding "${binding.id}" references missing target component "${binding.targetId}"`
      );
    }
    const referencedVariableIds = extractVariableIdsFromPath(binding.path);
    for (const variableId of referencedVariableIds) {
      if (!variableIds.has(variableId)) {
        errors.push(
          `Binding "${binding.id}" references missing variable "${variableId}" in path "${binding.path}"`
        );
      }
    }
  }

  for (const interaction of pkg.uiBlueprint.interactions ?? []) {
    if (
      !componentIdSet.has(interaction.targetId) &&
      !layoutIdSet.has(interaction.targetId)
    ) {
      errors.push(
        `Interaction "${interaction.id}" references missing target "${interaction.targetId}"`
      );
    }
  }

  const tagSet = new Set(pkg.metadata.tags.map((tag) => tag.toLowerCase()));
  const isTransportMode =
    pkg.metadata.authoringMode === "ai-transported" ||
    tagSet.has("sillytavern-port");

  if (isTransportMode) {
    if (pkg.metadata.authoringMode !== "ai-transported") {
      errors.push(
        "Transport mode requires metadata.authoringMode to be \"ai-transported\""
      );
    }
    if (!tagSet.has("sillytavern-port")) {
      errors.push(
        "Transport mode requires metadata.tags to include \"sillytavern-port\""
      );
    }

    const loweredNotes = pkg.summary.notes.map((note) => note.toLowerCase());
    if (!loweredNotes.some((note) => note.includes("preserved"))) {
      errors.push(
        "Transport mode requires summary.notes to include preserved effects details"
      );
    }
    if (!loweredNotes.some((note) => note.includes("adapted"))) {
      errors.push(
        "Transport mode requires summary.notes to include adapted effects details"
      );
    }
    if (!loweredNotes.some((note) => note.includes("dropped"))) {
      errors.push(
        "Transport mode requires summary.notes to include dropped effects details"
      );
    }
    if (!loweredNotes.some((note) => note.includes("regex_scripts"))) {
      warnings.push(
        "Transport mode note should mention regex_scripts source coverage"
      );
    }
    if (!loweredNotes.some((note) => note.includes("tavern_helper.scripts"))) {
      warnings.push(
        "Transport mode note should mention tavern_helper.scripts source coverage"
      );
    }
  }

  const previewState: GameState = {
    worldId: context.worldId,
    turnCount: 0,
    metadata: {},
    variables: buildPreviewVariables(context.variables),
  };
  const resolverResult = resolveUIBlueprint(
    pkg.uiBlueprint,
    previewState,
    context.variables
  );
  for (const resolverError of resolverResult.errors) {
    errors.push(`uiBlueprint resolver: ${resolverError}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function diffUIPackageAgainstWorld(
  world: Pick<
    WorldDefinition,
    "uiBlueprint" | "components" | "customUI" | "settings"
  >,
  pkg: UIPackage
): UIPackageDiff {
  const beforeBlueprint = world.uiBlueprint ?? EMPTY_BLUEPRINT;
  const afterBlueprint = pkg.uiBlueprint;

  const messageEntry: CustomUIComponent | undefined = world.customUI.find(
    (c) => c.surface === "message"
  );
  const messageRendererBeforeEnabled = Boolean(messageEntry);
  const messageRendererAfterEnabled = pkg.messageRenderer.enabled;
  const messageRendererNameBefore = messageEntry?.name ?? "";
  const messageRendererNameAfter = pkg.messageRenderer.enabled
    ? pkg.messageRenderer.name
    : "";
  const messageRendererCodeBefore = messageEntry?.tsxCode ?? "";
  const messageRendererCodeAfter = pkg.messageRenderer.enabled
    ? pkg.messageRenderer.tsxCode
    : "";

  const nameChanged = messageRendererNameBefore !== messageRendererNameAfter;
  const codeChanged = messageRendererCodeBefore !== messageRendererCodeAfter;
  const rendererChanged =
    messageRendererBeforeEnabled !== messageRendererAfterEnabled ||
    nameChanged ||
    codeChanged;

  const fullScreenComponentBefore = world.customUI.some(
    (c) => c.surface === "app"
  );
  const fullScreenComponentAfter = pkg.displaySettings.fullScreenComponent;

  return {
    layouts: diffById(beforeBlueprint.layouts, afterBlueprint.layouts),
    components: diffById(beforeBlueprint.components, afterBlueprint.components),
    bindings: diffById(
      beforeBlueprint.bindings ?? [],
      afterBlueprint.bindings ?? []
    ),
    triggers: diffById(
      beforeBlueprint.triggers ?? [],
      afterBlueprint.triggers ?? []
    ),
    interactions: diffById(
      beforeBlueprint.interactions ?? [],
      afterBlueprint.interactions ?? []
    ),
    legacyComponents: diffById(world.components, pkg.legacyComponents),
    messageRenderer: {
      beforeEnabled: messageRendererBeforeEnabled,
      afterEnabled: messageRendererAfterEnabled,
      nameChanged,
      codeChanged,
      changed: rendererChanged,
    },
    displaySettings: {
      fullScreenComponentBefore,
      fullScreenComponentAfter,
      changed: fullScreenComponentBefore !== fullScreenComponentAfter,
    },
  };
}

export function exportUIPackageFromWorld(
  world: Pick<
    WorldDefinition,
    | "name"
    | "description"
    | "uiBlueprint"
    | "components"
    | "customUI"
    | "settings"
  >,
  seed: UIPackageExportSeed = {}
): UIPackage {
  const defaultName =
    world.name.trim().length > 0 ? `${world.name} UI Package` : "UI Package";
  const defaultDescription =
    world.description.trim().length > 0
      ? world.description
      : "Exported from Yumina";

  const tags = seed.metadata?.tags ? [...seed.metadata.tags] : [];

  const metadata = {
    name: seed.metadata?.name ?? defaultName,
    description: seed.metadata?.description ?? defaultDescription,
    uiType: seed.metadata?.uiType ?? "custom",
    implementation: seed.metadata?.implementation ?? "hybrid",
    tags,
    authoringMode: seed.metadata?.authoringMode ?? "manual",
  };

  const summary = {
    whatThisAdds: seed.summary?.whatThisAdds
      ? [...seed.summary.whatThisAdds]
      : [],
    requiresVariableIds: seed.summary?.requiresVariableIds
      ? [...seed.summary.requiresVariableIds]
      : [],
    notes: seed.summary?.notes ? [...seed.summary.notes] : [],
  };

  const messageEntry: CustomUIComponent | undefined = world.customUI.find(
    (c) => c.surface === "message"
  );

  return {
    format: "yumina.ui-package",
    schemaVersion: "1.0.0",
    metadata,
    summary,
    uiBlueprint: cloneBlueprint(world.uiBlueprint ?? EMPTY_BLUEPRINT),
    legacyComponents: world.components.map(cloneLegacyComponent),
    messageRenderer: {
      enabled: Boolean(messageEntry),
      name: messageEntry?.name ?? "",
      tsxCode: messageEntry?.tsxCode ?? "",
    },
    displaySettings: {
      fullScreenComponent: world.customUI.some((c) => c.surface === "app"),
    },
  };
}

function diffById<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[]
): UIPackageCollectionDiff {
  const beforeMap = new Map(before.map((item) => [item.id, item]));
  const afterMap = new Map(after.map((item) => [item.id, item]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const id of afterMap.keys()) {
    if (!beforeMap.has(id)) {
      added.push(id);
    }
  }

  for (const id of beforeMap.keys()) {
    if (!afterMap.has(id)) {
      removed.push(id);
    }
  }

  let unchanged = 0;
  for (const [id, beforeItem] of beforeMap.entries()) {
    const afterItem = afterMap.get(id);
    if (!afterItem) continue;
    if (JSON.stringify(beforeItem) === JSON.stringify(afterItem)) {
      unchanged += 1;
    } else {
      changed.push(id);
    }
  }

  added.sort();
  removed.sort();
  changed.sort();

  return {
    added,
    removed,
    changed,
    unchanged,
  };
}

function parseMajorVersion(value: string): number | null {
  const match = /^(\d+)(?:\.\d+){1,2}$/.exec(value);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 10);
}

function extractVariableIdsFromPath(path: string): string[] {
  const trimmedPath = path.trim();
  if (!trimmedPath.startsWith("vars")) {
    return [];
  }

  const ids: string[] = [];
  const bracketMatch = /^vars\[['"]([^'"]+)['"]\]/.exec(trimmedPath);
  if (bracketMatch?.[1]) {
    ids.push(bracketMatch[1]);
  }

  const dotMatch = /^vars\.([A-Za-z0-9_-]+)/.exec(trimmedPath);
  if (dotMatch?.[1]) {
    ids.push(dotMatch[1]);
  }

  return Array.from(new Set(ids));
}

function buildPreviewVariables(
  variables: UIPackageWorldValidationContext["variables"]
): GameState["variables"] {
  const preview: GameState["variables"] = {};
  for (const variable of variables) {
    preview[variable.id] = variable.defaultValue;
  }
  return preview;
}

function cloneBlueprint(blueprint: UIBlueprint): UIBlueprint {
  return {
    version: blueprint.version,
    theme: blueprint.theme
      ? {
          preset: blueprint.theme.preset,
          tokens: blueprint.theme.tokens
            ? { ...blueprint.theme.tokens }
            : undefined,
        }
      : undefined,
    layouts: blueprint.layouts.map((layout) => ({
      ...layout,
      componentIds: layout.componentIds ? [...layout.componentIds] : undefined,
      triggerIds: layout.triggerIds ? [...layout.triggerIds] : undefined,
    })),
    components: blueprint.components.map((component) => ({
      ...component,
      props: component.props ? { ...component.props } : undefined,
      triggerIds: component.triggerIds ? [...component.triggerIds] : undefined,
    })),
    bindings: (blueprint.bindings ?? []).map((binding) => ({ ...binding })),
    triggers: (blueprint.triggers ?? []).map((trigger) => ({
      ...trigger,
      conditions: (trigger.conditions ?? []).map((condition) => ({
        ...condition,
      })),
    })),
    interactions: (blueprint.interactions ?? []).map((interaction) => ({
      ...interaction,
      payload: interaction.payload ? { ...interaction.payload } : undefined,
    })),
  };
}

function cloneLegacyComponent<T extends UIPackage["legacyComponents"][number]>(
  component: T
): T {
  return {
    ...component,
    config: { ...component.config },
  } as T;
}

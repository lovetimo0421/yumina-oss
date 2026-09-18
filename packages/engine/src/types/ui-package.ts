import type { GameComponent } from "./components.js";
import type { UIBlueprint } from "./ui-blueprint.js";

export type UIPackageFormat = "yumina.ui-package";

export type UIPackageUIType =
  | "status-bar"
  | "text-background"
  | "image-showcase"
  | "inventory"
  | "dashboard"
  | "narrative-overlay"
  | "custom";

export type UIPackageImplementation =
  | "stat-bar"
  | "text-display"
  | "image-panel"
  | "inventory-grid"
  | "web-panel"
  | "ui-blueprint-only"
  | "message-renderer"
  | "hybrid";

export type UIPackageAuthoringMode =
  | "ai-generated"
  | "ai-transported"
  | "manual";

export interface UIPackageMetadata {
  name: string;
  description: string;
  uiType: UIPackageUIType;
  implementation: UIPackageImplementation;
  tags: string[];
  authoringMode: UIPackageAuthoringMode;
}

export interface UIPackageSummary {
  whatThisAdds: string[];
  requiresVariableIds: string[];
  notes: string[];
}

export interface UIPackageMessageRenderer {
  enabled: boolean;
  name: string;
  tsxCode: string;
}

export interface UIPackageDisplaySettings {
  fullScreenComponent: boolean;
}

export interface UIPackage {
  format: UIPackageFormat;
  schemaVersion: string;
  metadata: UIPackageMetadata;
  summary: UIPackageSummary;
  uiBlueprint: UIBlueprint;
  legacyComponents: GameComponent[];
  messageRenderer: UIPackageMessageRenderer;
  displaySettings: UIPackageDisplaySettings;
}

export interface UIPackageValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface UIPackageCollectionDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

export interface UIPackageDiff {
  layouts: UIPackageCollectionDiff;
  components: UIPackageCollectionDiff;
  bindings: UIPackageCollectionDiff;
  triggers: UIPackageCollectionDiff;
  interactions: UIPackageCollectionDiff;
  legacyComponents: UIPackageCollectionDiff;
  messageRenderer: {
    beforeEnabled: boolean;
    afterEnabled: boolean;
    nameChanged: boolean;
    codeChanged: boolean;
    changed: boolean;
  };
  displaySettings: {
    fullScreenComponentBefore: boolean;
    fullScreenComponentAfter: boolean;
    changed: boolean;
  };
}

export interface UIPackageExportSeed {
  metadata?: Partial<UIPackageMetadata>;
  summary?: Partial<UIPackageSummary>;
}

export interface UIPackageValidationOptions {
  supportedPackageMajor?: number;
  supportedBlueprintMajor?: number;
}

export interface UIPackageVariableRef {
  id: string;
  name: string;
  type: "number" | "string" | "boolean";
  defaultValue: number | string | boolean;
}

export interface UIPackageWorldValidationContext {
  variables: UIPackageVariableRef[];
  worldId: string;
}

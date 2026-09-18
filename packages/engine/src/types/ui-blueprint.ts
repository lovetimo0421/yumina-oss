export type UIBlueprintLayoutType = "stack" | "grid" | "tabs" | "overlay" | "split" | "panel";

export type UIBlueprintComponentType =
  | "text"
  | "metric"
  | "progress"
  | "badge"
  | "list"
  | "table"
  | "image"
  | "choiceGroup"
  | "form"
  | "webPanel";

export type UIBindingTransform =
  | "string"
  | "number"
  | "boolean"
  | "percent"
  | "jsonArrayLength";

export interface UIBlueprintTheme {
  preset?: string;
  tokens?: Record<string, string | number | boolean>;
}

export interface UIBlueprintCondition {
  variableId: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains";
  value: number | string | boolean;
}

export interface UIBlueprintTrigger {
  id: string;
  name?: string;
  description?: string;
  expression?: string;
  conditions?: UIBlueprintCondition[];
  conditionLogic?: "all" | "any";
  enabled?: boolean;
}

export interface UIBlueprintLayout {
  id: string;
  type: UIBlueprintLayoutType;
  name?: string;
  placement?: "header";
  order?: number;
  columns?: number;
  gap?: number;
  componentIds?: string[];
  triggerIds?: string[];
  triggerLogic?: "all" | "any";
  when?: string;
  visible?: boolean;
}

export interface UIBlueprintComponent {
  id: string;
  type: UIBlueprintComponentType;
  name?: string;
  layoutId?: string;
  placement?: "header";
  order?: number;
  props?: Record<string, unknown>;
  triggerIds?: string[];
  triggerLogic?: "all" | "any";
  when?: string;
  visible?: boolean;
}

export interface UIBlueprintBinding {
  id: string;
  targetId: string;
  prop: string;
  path: string;
  transform?: UIBindingTransform;
  fallback?: string | number | boolean;
}

export type UIBlueprintInteractionEvent = "click" | "submit" | "change";

export type UIBlueprintInteractionAction =
  | "setVariable"
  | "sendMessage"
  | "executeAction"
  | "openPanel"
  | "switchLayout";

export interface UIBlueprintInteraction {
  id: string;
  targetId: string;
  event: UIBlueprintInteractionEvent;
  action: UIBlueprintInteractionAction;
  payload?: Record<string, unknown>;
}

export interface UIBlueprint {
  version: string;
  theme?: UIBlueprintTheme;
  layouts: UIBlueprintLayout[];
  components: UIBlueprintComponent[];
  bindings?: UIBlueprintBinding[];
  triggers?: UIBlueprintTrigger[];
  interactions?: UIBlueprintInteraction[];
}

export type UIBlueprintTriggerStatus = "active" | "inactive" | "error" | "indeterminate";

export interface UIBlueprintTriggerTrace {
  id: string;
  name?: string;
  expression?: string;
  status: UIBlueprintTriggerStatus;
  result: boolean | null;
  dependencies: string[];
  affectedNodeIds: string[];
  error?: string;
}

export interface UIBlueprintNodeTrace {
  id: string;
  type: string;
  visible: boolean;
  placement: "header";
  order: number;
  triggerIds: string[];
  triggerLogic: "all" | "any";
  when?: string;
  reason?: string;
}

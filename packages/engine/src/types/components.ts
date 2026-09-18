/** All supported component types */
export type ComponentType =
  | "stat-bar"
  | "text-display"
  | "image-panel"
  | "inventory-grid"
  | "web-panel";

// ── Per-type config interfaces ──

export interface StatBarConfig {
  variableId: string;
  /** CSS color or preset name */
  color?: string;
  /** Show numeric value next to bar (default true) */
  showValue?: boolean;
  /** Show variable name as label (default true) */
  showLabel?: boolean;
  /** Optional variable for dynamic max (overrides variable.max) */
  secondaryVariableId?: string;
}

export interface TextDisplayConfig {
  variableId: string;
  /** Template string, e.g. "Location: {{value}}" */
  format?: string;
  fontSize?: "sm" | "md" | "lg";
  /** Lucide icon name */
  icon?: string;
  /** CSS color for the text */
  textColor?: string;
}

export interface ImagePanelConfig {
  /** Optional variable containing a runtime image URL */
  variableId?: string;
  /** Optional fixed URL for static images (used when variable is empty or omitted) */
  url?: string;
  aspectRatio?: "square" | "portrait" | "landscape" | "wide";
  /** Render size of the panel in sidebar mode */
  size?: "sm" | "md" | "lg" | "full";
  /** Horizontal alignment inside sidebar mode */
  placement?: "left" | "center" | "right";
  fallbackUrl?: string;
}

export interface InventoryGridConfig {
  variableId: string;
  /** Grid columns (default 4) */
  columns?: number;
  /** Max items (default 16) */
  maxSlots?: number;
}

export interface WebPanelConfig {
  /** Optional URL of an HTML document to render directly */
  htmlUrl?: string;
  /** Optional HTML fragment/string injected into iframe srcDoc */
  html?: string;
  /** Optional CSS URL linked from iframe srcDoc */
  cssUrl?: string;
  /** Optional inline CSS injected into iframe srcDoc */
  css?: string;
  /** Optional JavaScript URL loaded by iframe srcDoc */
  jsUrl?: string;
  /** Optional inline JavaScript injected into iframe srcDoc */
  js?: string;
  /** Optional fixed panel height in pixels (default runtime-defined) */
  height?: number;
  /** Sandbox flags for iframe. Defaults to a safe script-enabled sandbox. */
  sandbox?: string;
}

// ── Discriminated union ──

interface BaseComponent {
  id: string;
  name: string;
  /** Display order (lower = higher) */
  order: number;
  /** Hide from GamePanel without removing (default true) */
  visible?: boolean;
  /** Where to render: header bar above chat (default "header") */
  placement?: "header";
}

export interface StatBarComponent extends BaseComponent {
  type: "stat-bar";
  config: StatBarConfig;
}

export interface TextDisplayComponent extends BaseComponent {
  type: "text-display";
  config: TextDisplayConfig;
}

export interface ImagePanelComponent extends BaseComponent {
  type: "image-panel";
  config: ImagePanelConfig;
}

export interface InventoryGridComponent extends BaseComponent {
  type: "inventory-grid";
  config: InventoryGridConfig;
}

export interface WebPanelComponent extends BaseComponent {
  type: "web-panel";
  config: WebPanelConfig;
}

export type GameComponent =
  | StatBarComponent
  | TextDisplayComponent
  | ImagePanelComponent
  | InventoryGridComponent
  | WebPanelComponent;

// ── Metadata for the editor ──

export interface ComponentTypeMeta {
  label: string;
  description: string;
  compatibleVariableTypes: Array<"number" | "string" | "boolean" | "json">;
}

export const COMPONENT_TYPE_META: Record<ComponentType, ComponentTypeMeta> = {
  "stat-bar": {
    label: "Stat Bar",
    description: "Progress bar bound to a numeric variable (HP, mana, stamina)",
    compatibleVariableTypes: ["number"],
  },
  "text-display": {
    label: "Text Display",
    description: "Shows a variable value as formatted text (location, status)",
    compatibleVariableTypes: ["number", "string", "boolean", "json"],
  },
  "image-panel": {
    label: "Image Panel",
    description: "Displays an image from a URL variable or fixed link (scene art, portraits)",
    compatibleVariableTypes: ["string"],
  },
  "inventory-grid": {
    label: "Inventory Grid",
    description: "Grid of items from a json array variable (or a string containing a JSON array)",
    compatibleVariableTypes: ["json", "string"],
  },
  "web-panel": {
    label: "Web Panel",
    description: "Render custom HTML/CSS/JS content or linked files in sidebar/header",
    compatibleVariableTypes: [],
  },
};

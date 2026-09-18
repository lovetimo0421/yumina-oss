/** Definition of a field on an event (for editor UI autocomplete) */
export interface EventFieldDefinition {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
}

/** Definition of an event type that a system can emit (for editor WHEN picker) */
export interface EventDefinition {
  type: string;
  description: string;
  dataFields: EventFieldDefinition[];
}

/** Definition of a state path that a system manages (for editor THEN picker) */
export interface StatePathDefinition {
  path: string;
  description: string;
  valueType: "string" | "number" | "boolean" | "json";
}

/**
 * A System is a plugin that emits events and/or watches state.
 * Systems declare their capabilities via metadata (events + state paths).
 * The editor uses this metadata to populate WHEN/THEN pickers dynamically.
 */
export interface SystemDefinition {
  id: string;
  name: string;
  description: string;

  /** Events this system can emit (populates the WHEN dropdown in editor) */
  events: EventDefinition[];

  /** State paths this system manages (populates the THEN dropdown in editor) */
  statePaths: StatePathDefinition[];

  /** Category grouping for editor UI */
  category: string;

  /** Whether this system is always active or opt-in */
  alwaysActive?: boolean;
}

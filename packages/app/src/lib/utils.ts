import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { migrateWorldDefinition } from "@yumina/engine";
import type { WorldDefinition } from "@yumina/engine";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Safely parse and migrate a raw world schema into a typed WorldDefinition.
 * Returns `undefined` when the input is missing or migration fails,
 * replacing the previous `as unknown as WorldDefinition` type-safety bypass.
 */
export function safeParseWorldDef(
  schema: unknown,
): WorldDefinition | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  try {
    return migrateWorldDefinition(schema as WorldDefinition);
  } catch {
    return undefined;
  }
}

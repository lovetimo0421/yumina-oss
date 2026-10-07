/**
 * Variables in text, shown by name — the names the style and element panels
 * use for the one translation in parts/variable-text.ts, so every text box in
 * the editor shows and writes ids the same way (unique names only, exact
 * inverses).
 */
import { idsToNames, namesToIds } from "./parts/variable-text";

export interface NamedVariable { id: string; name: string }

export function templateToDisplay(template: string, variables: readonly NamedVariable[]): string {
  return idsToNames(template ?? "", variables);
}

export function templateFromDisplay(text: string, variables: readonly NamedVariable[]): string {
  return namesToIds(text ?? "", variables);
}

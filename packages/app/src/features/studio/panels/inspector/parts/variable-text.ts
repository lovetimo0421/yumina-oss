/**
 * `{{id}}` in the document, `{{名字}}` on screen.
 *
 * Variables are bound by id so a rename cannot break a card, and ids are
 * UUIDs — so a text that reads a variable used to show the creator
 * `{{3f2a9c1e-…}}`, which is the document's plumbing, not their words. The
 * text boxes show names and write ids, and the two directions are exact
 * inverses over everything the creator can type, so a controlled input never
 * sees its value change under the cursor.
 *
 * Only a name that belongs to exactly one variable is swapped: with two
 * variables called 好感 there is no way back from `{{好感}}` to the right id,
 * and a text that quietly re-pointed at the other one would be worse than
 * showing the id.
 */

interface Named { id: string; name: string }

const MACRO = /\{\{\s*([^{}]+?)\s*\}\}/g;

function uniqueNames(variables: readonly Named[]) {
  const count = new Map<string, number>();
  for (const v of variables) {
    const name = v.name.trim();
    if (name) count.set(name, (count.get(name) ?? 0) + 1);
  }
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  const ids = new Set(variables.map((v) => v.id));
  for (const v of variables) {
    const name = v.name.trim();
    // A name that is also some variable's id, or holds braces, cannot be told
    // apart from that id on the way back.
    if (!name || count.get(name) !== 1 || /[{}]/.test(name) || (ids.has(name) && name !== v.id)) continue;
    byId.set(v.id, name);
    byName.set(name, v.id);
  }
  return { byId, byName };
}

/** The document's `{{id}}` as the creator reads it: `{{名字}}`. */
export function idsToNames(template: string, variables: readonly Named[]): string {
  const { byId } = uniqueNames(variables);
  return template.replace(MACRO, (whole, key: string) => {
    const name = byId.get(key.trim());
    return name ? `{{${name}}}` : whole;
  });
}

/** What the creator typed, back into the document's `{{id}}`. */
export function namesToIds(text: string, variables: readonly Named[]): string {
  const { byName } = uniqueNames(variables);
  return text.replace(MACRO, (whole, key: string) => {
    const id = byName.get(key.trim());
    return id ? `{{${id}}}` : whole;
  });
}

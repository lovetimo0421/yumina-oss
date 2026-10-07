import type { WorldDefinition } from "@yumina/engine";
import { classifyInterface } from "../../lib/ui-doc-takeover";

/** The stock chat is ready to play; an arbitrary short TSX file is not. */
export function isDefaultChatInterface(
  world: Pick<WorldDefinition, "rootComponent" | "uiDoc">,
): boolean {
  if (world.uiDoc) return false;
  const root = world.rootComponent;
  const owner = classifyInterface(root);
  if (owner === "none") return true;
  if (!root || owner !== "shell") return false;
  const files = Object.keys(root.files);
  if (files.length !== 1 || files[0] !== root.entryFile) return false;
  const source = root.files[root.entryFile]?.replace(/\s+/g, "") ?? "";
  return /^exportdefaultfunction[A-Za-z_$][\w$]*\(\)\{return<Chat\/>;?\}$/.test(source);
}

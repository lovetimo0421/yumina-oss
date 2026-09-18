// Turn Counter — the hidden drop-in proof extension (see its registry entry in
// packages/shared/src/types/extension.ts). Deliberately tiny: one toolbar
// badge reading existing sandbox state. Exists to prove (and demonstrate)
// that an extension is a manifest entry + this module + one import-map line —
// nothing in the chat UI or message pipeline changes.

import { useYumina } from "../../sandbox-context";
import type { ExtensionClientContext } from "../registry";

function TurnCounterBadge() {
  const api = useYumina();
  return (
    <span
      className="mx-auto flex shrink-0 items-center rounded-full border border-white/[0.12] bg-white/[0.05] px-3 py-1.5 text-[11px] font-medium text-white/60"
      title="Messages in this session"
    >
      #{api.messages.length}
    </span>
  );
}

export default function register(ctx: ExtensionClientContext): void {
  ctx.contribute("chat.composer.toolbar", {
    id: "turn-counter:badge",
    priority: 50,
    Component: TurnCounterBadge,
  });
}

// Session Memory & Story Summary — sandbox client module. Registered when the
// extension is installed (see sandbox/extensions/index.ts).
//
// It adds no composer button of its own: "Memory" in the "+" menu opens
// MemoryPanelHostMount (component-host), which shows this extension's panel
// when it is installed and the core Memory panel otherwise.

import type { ExtensionClientContext } from "../registry";

export default function register(_ctx: ExtensionClientContext): void {}

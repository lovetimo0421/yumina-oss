// The sandbox-side contribution-point registry. Installed extensions' client
// modules register UI contributions into named slots; the default chat UI
// renders `<SlotOutlet point=… />` where it used to hardcode per-extension JSX.
// Modules are bundled statically (see ./index.ts for why runtime dynamic
// import() can't be used in the prod sandbox) and gated here by install state:
// an uninstalled extension's contributions are present but never rendered.
//
// Kept dependency-free of @yumina/shared on purpose — the sandbox bundle is
// size-sensitive and only needs the slot names. The canonical ContributionPoint
// type lives in packages/shared/src/types/extension.ts; keep the two unions in
// sync.

import { Component, Suspense, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

/**
 * UI slots extensions can fill. All slots compose by priority (lower renders
 * first; ties break by contribution id) — except `chat.renderer`, which is
 * EXCLUSIVE and resolved by explicit policy: a world's own rootComponent
 * replaces the default ChatCanvas (the existing install-root mechanism), and
 * extensions cannot claim it.
 */
export type ContributionPoint =
  | "chat.composer.toolbar"
  | "chat.message.actions"
  | "chat.settings.panel"
  | "chat.renderer";

export interface SlotContribution {
  /** Stable id, unique within the slot (conventionally `<extension>:<what>`). */
  id: string;
  priority: number;
  Component: ComponentType;
}

/**
 * A launchable tool for the compact composer tool menu (mobile). Unlike a
 * SlotContribution — a self-contained button that owns its own modal — a tool
 * contribution SPLITS the launcher row from the real interface so the menu can
 * own the open-state: picking a row closes the selector, then the menu mounts
 * the tool's `Modal`. That gives every tool the same flow the model picker has
 * (select → the normal full interface pops up), instead of nesting a mini-UI
 * inside a dropdown.
 */
export interface ToolMenuContribution {
  /** Stable id, unique across tools (conventionally the extension key). */
  id: string;
  priority: number;
  /** The selection row. Calls `onSelect` when the user picks this tool. Return
   *  null to hide (e.g. an installed-but-disabled extension). */
  Row: ComponentType<{ onSelect: () => void }>;
  /** The real interface, opened by the menu after selection. */
  Modal: ComponentType<{ open: boolean; onClose: () => void }>;
}

export interface ExtensionClientContext {
  contribute: (point: ContributionPoint, contribution: SlotContribution) => void;
  /** Register a launchable tool for the compact composer tool menu. */
  contributeTool: (contribution: ToolMenuContribution) => void;
}

interface RegisteredContribution extends SlotContribution {
  /** The owning extension's clientEntry id — gates rendering on install state. */
  entry: string;
}

interface RegisteredToolMenu extends ToolMenuContribution {
  entry: string;
}

const slots = new Map<ContributionPoint, RegisteredContribution[]>();
const toolMenu: RegisteredToolMenu[] = [];
let enabledEntries: ReadonlySet<string> = new Set();
let storeVersion = 0;
const listeners = new Set<() => void>();

function bump(): void {
  storeVersion += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Curried per-extension context so contributions are attributable to their owner. */
export function makeExtensionClientContext(entry: string): ExtensionClientContext {
  return {
    contribute: (point, contribution) => {
      const list = slots.get(point) ?? [];
      // Re-registering the same id replaces (lazy modules register once, but
      // hot-reload in dev may re-run register()).
      const next = list.filter((c) => c.id !== contribution.id);
      next.push({ ...contribution, entry });
      next.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
      slots.set(point, next);
      bump();
    },
    contributeTool: (contribution) => {
      const next = toolMenu.filter((c) => c.id !== contribution.id);
      next.push({ ...contribution, entry });
      next.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
      toolMenu.length = 0;
      toolMenu.push(...next);
      bump();
    },
  };
}

/** Host-pushed install state: only contributions from enabled entries render. */
export function setEnabledExtensionEntries(entries: string[]): void {
  const next = new Set(entries);
  if (next.size === enabledEntries.size && [...next].every((e) => enabledEntries.has(e))) return;
  enabledEntries = next;
  bump();
}

/** One contribution crashing must not take down the chat UI around it. */
export class ContributionErrorBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`[Extensions] Contribution "${this.props.id}" crashed:`, error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Enabled tool-menu contributions, in composition order. Reactive — re-renders
 *  when tools register or the install gate changes. */
export function useToolMenuContributions(): RegisteredToolMenu[] {
  useSyncExternalStore(subscribe, () => storeVersion);
  return toolMenu.filter((c) => enabledEntries.has(c.entry));
}

/** Count of enabled tool-menu contributions — used to decide whether the
 *  composer has any launchable tools worth collapsing into the mobile menu. */
export function useToolMenuCount(): number {
  useSyncExternalStore(subscribe, () => storeVersion);
  return toolMenu.filter((c) => enabledEntries.has(c.entry)).length;
}

/** Renders a slot's enabled contributions in priority order. */
export function SlotOutlet({ point }: { point: ContributionPoint }) {
  useSyncExternalStore(subscribe, () => storeVersion);
  const contributions = (slots.get(point) ?? []).filter((c) => enabledEntries.has(c.entry));
  if (contributions.length === 0) return null;
  return (
    <>
      {contributions.map(({ id, Component: Contribution }) => (
        <ContributionErrorBoundary key={id} id={id}>
          <Suspense fallback={null}>
            <Contribution />
          </Suspense>
        </ContributionErrorBoundary>
      ))}
    </>
  );
}

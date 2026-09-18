/**
 * LoreButton / LorePanel / LoreGroup
 *
 * High-level building blocks for frontend-controlled lorebook injection.
 * All state is persisted via game variables (`__lore_{slotId}`) so the
 * player's choices survive page reloads and branch switches.
 *
 * Ambient globals available in creator TSX (no import needed):
 *   LoreButton, LorePanel, LoreGroup
 *
 * @example Chip toggle
 *   <LoreButton slotId="world-history" label="世界历史" icon="📖" />
 *
 * @example Card toggle with description
 *   <LoreButton slotId="magic-system" label="魔法体系" icon="✨"
 *     description="了解世界的魔法规则" variant="card" />
 *
 * @example Collapsible panel
 *   <LorePanel title="知识库" slots={["lore-a","lore-b"]}>
 *     <LoreButton slotId="lore-a" label="A" />
 *     <LoreButton slotId="lore-b" label="B" />
 *   </LorePanel>
 *
 * @example Exclusive group (radio — only one active at a time)
 *   <LoreGroup slots={[
 *     { id: "combat", label: "战斗", icon: "⚔️" },
 *     { id: "history", label: "历史", icon: "📖" },
 *   ]} />
 */

import React, { useState, useEffect, useRef } from "react";
import { useYumina } from "./sandbox-context";
import { LoreSlot } from "./lore-slot";

const VAR_PREFIX = "__lore_";

// ── Tiny inline SVGs (no lucide dep in sandbox bundle) ─────────────────────

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transition: "transform 0.15s", transform: open ? "rotate(180deg)" : "none" }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function RadioDot({ active }: { active: boolean }) {
  return (
    <div style={{
      width: 16, height: 16, borderRadius: "50%",
      border: `2px solid ${active ? "rgb(56 189 248)" : "rgba(255,255,255,0.2)"}`,
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, transition: "border-color 0.15s",
    }}>
      {active && (
        <div style={{ width: 7, height: 7, borderRadius: "50%", background: "rgb(56 189 248)" }} />
      )}
    </div>
  );
}

// ── Shared sync hook ────────────────────────────────────────────────────────

/** Reads the persisted active state and syncs local state when the server
 *  value changes (engine effects, branch restore, session load). */
function useLoreActive(varKey: string): [boolean, (next: boolean) => void] {
  const api = useYumina();
  const persisted = Boolean(api.variables?.[varKey]);
  const [active, setActive] = useState(persisted);
  const prevPersistedRef = useRef(persisted);

  useEffect(() => {
    if (persisted !== prevPersistedRef.current) {
      prevPersistedRef.current = persisted;
      setActive(persisted);
    }
  }, [persisted]);

  function commit(next: boolean) {
    setActive(next);
    api.setVariable?.(varKey, next);
  }

  return [active, commit];
}

// ── LoreButton ──────────────────────────────────────────────────────────────

export interface LoreButtonProps {
  /** Slot id — must match the `<LoreSlot id>` bound to an entry in the editor. */
  slotId: string;
  /** Display label shown on the button. */
  label: string;
  /** Optional emoji or symbol shown before the label. */
  icon?: string;
  /** Secondary line of text (card variant only). */
  description?: string;
  /**
   * Visual shape:
   * - `"chip"` — compact rounded pill, suitable for toolbars and HUDs (default)
   * - `"card"` — full-width card with a toggle switch, suitable for menus / panels
   */
  variant?: "chip" | "card";
  className?: string;
}

export function LoreButton({
  slotId,
  label,
  icon,
  description,
  variant = "chip",
  className = "",
}: LoreButtonProps) {
  const [active, commit] = useLoreActive(`${VAR_PREFIX}${slotId}`);

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    commit(!active);
  }

  return (
    <>
      {/* Invisible engine signal — mounts only when active */}
      {active && <LoreSlot id={slotId} />}

      {variant === "chip" ? (
        <button
          type="button"
          onClick={handleClick}
          className={`
            inline-flex items-center gap-1.5 select-none
            px-3 py-1.5 rounded-full text-sm font-medium
            border transition-all duration-150 cursor-pointer
            ${active
              ? "bg-sky-500/20 border-sky-400/50 text-sky-300 shadow-[0_0_10px_rgba(56,189,248,0.12)]"
              : "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10 hover:border-white/20 hover:text-foreground"
            }
            ${className}
          `}
        >
          {icon && <span style={{ fontSize: "1em", lineHeight: 1 }}>{icon}</span>}
          <span>{label}</span>
          {active && <span className="text-sky-400"><CheckIcon /></span>}
        </button>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          className={`
            flex items-center gap-3 w-full
            px-4 py-3 rounded-xl border text-left
            transition-all duration-150 cursor-pointer
            ${active
              ? "bg-sky-500/10 border-sky-400/40 shadow-[0_0_14px_rgba(56,189,248,0.08)]"
              : "bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.07] hover:border-white/[0.14]"
            }
            ${className}
          `}
        >
          {icon && (
            <span style={{
              fontSize: "1.5rem", lineHeight: 1, flexShrink: 0,
              opacity: active ? 1 : 0.55, transition: "opacity 0.15s",
            }}>
              {icon}
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={`text-sm font-semibold ${active ? "text-sky-300" : "text-foreground"}`}
              style={{ transition: "color 0.15s" }}>
              {label}
            </div>
            {description && (
              <div className="text-xs text-muted-foreground mt-0.5 truncate">{description}</div>
            )}
          </div>
          {/* Toggle switch */}
          <div style={{
            position: "relative", width: 36, height: 20, flexShrink: 0,
            borderRadius: 10,
            background: active ? "rgb(14 165 233)" : "rgba(255,255,255,0.15)",
            transition: "background 0.2s",
          }}>
            <div style={{
              position: "absolute", top: 2,
              left: active ? 18 : 2,
              width: 16, height: 16, borderRadius: "50%",
              background: "white",
              boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
              transition: "left 0.2s",
            }} />
          </div>
        </button>
      )}
    </>
  );
}

// ── LorePanel ───────────────────────────────────────────────────────────────

export interface LorePanelProps {
  /** Header label. Defaults to "知识库". */
  title?: string;
  /**
   * Slot ids to watch for the active-count badge.
   * Pass the same ids that your inner `<LoreButton>`s use.
   */
  slots?: string[];
  /** Start expanded. Defaults to false. */
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function LorePanel({
  title = "知识库",
  slots,
  defaultOpen = false,
  children,
  className = "",
}: LorePanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  const api = useYumina();

  const activeCount = slots
    ? slots.filter((id) => Boolean(api.variables?.[`${VAR_PREFIX}${id}`])).length
    : 0;

  return (
    <div
      className={`rounded-xl border border-white/10 overflow-hidden ${className}`}
      style={{ background: "rgba(255,255,255,0.02)" }}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-4 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
        style={{ borderBottom: open ? "1px solid rgba(255,255,255,0.06)" : "none" }}
      >
        <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground"
          style={{ flex: 1 }}>
          {title}
        </span>
        {slots && activeCount > 0 && (
          <span style={{
            fontSize: 10, fontWeight: 700,
            background: "rgba(56,189,248,0.15)", color: "rgb(125 211 252)",
            padding: "2px 8px", borderRadius: 999,
          }}>
            {activeCount} 启用
          </span>
        )}
        <span className="text-muted-foreground"><ChevronIcon open={open} /></span>
      </button>

      {/* Body */}
      {open && (
        <div className="p-3 flex flex-col gap-2">
          {children}
        </div>
      )}
    </div>
  );
}

// ── LoreGroup ───────────────────────────────────────────────────────────────

export interface LoreGroupSlot {
  id: string;
  label: string;
  icon?: string;
  description?: string;
}

export interface LoreGroupProps {
  /**
   * Slot descriptors — exactly one (or none) can be active at a time.
   * Selecting an active slot deactivates it (toggle-off).
   */
  slots: LoreGroupSlot[];
  /**
   * Visual shape:
   * - `"chip"` — horizontal pill row (default)
   * - `"card"` — vertical card list with radio dots
   */
  variant?: "chip" | "card";
  className?: string;
}

export function LoreGroup({ slots, variant = "chip", className = "" }: LoreGroupProps) {
  const api = useYumina();

  // Find which slot id is currently persisted as active (at most one)
  const persistedActiveId =
    slots.find((s) => Boolean(api.variables?.[`${VAR_PREFIX}${s.id}`]))?.id ?? null;

  const [activeId, setActiveId] = useState<string | null>(persistedActiveId);
  const prevPersistedRef = useRef(persistedActiveId);

  // Sync external changes
  useEffect(() => {
    if (persistedActiveId !== prevPersistedRef.current) {
      prevPersistedRef.current = persistedActiveId;
      setActiveId(persistedActiveId);
    }
  }, [persistedActiveId]);

  function select(id: string) {
    const next = activeId === id ? null : id;
    const prev = activeId;

    setActiveId(next);

    // Deactivate the previously active slot
    if (prev && prev !== id) {
      api.setVariable?.(`${VAR_PREFIX}${prev}`, false);
    }
    // Toggle the clicked slot
    api.setVariable?.(`${VAR_PREFIX}${id}`, next === id);
  }

  return (
    <div className={variant === "chip" ? `flex flex-wrap gap-2 ${className}` : `flex flex-col gap-2 ${className}`}>
      {/* Mount the active LoreSlot (invisible engine signal) */}
      {activeId && <LoreSlot id={activeId} />}

      {slots.map((slot) => {
        const active = activeId === slot.id;

        if (variant === "chip") {
          return (
            <button
              key={slot.id}
              type="button"
              onClick={() => select(slot.id)}
              className={`
                inline-flex items-center gap-1.5 select-none
                px-3 py-1.5 rounded-full text-sm font-medium
                border transition-all duration-150 cursor-pointer
                ${active
                  ? "bg-sky-500/20 border-sky-400/50 text-sky-300 shadow-[0_0_10px_rgba(56,189,248,0.12)]"
                  : "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10 hover:border-white/20 hover:text-foreground"
                }
              `}
            >
              {slot.icon && <span style={{ fontSize: "1em", lineHeight: 1 }}>{slot.icon}</span>}
              <span>{slot.label}</span>
              {active && <span className="text-sky-400"><CheckIcon /></span>}
            </button>
          );
        }

        // card variant
        return (
          <button
            key={slot.id}
            type="button"
            onClick={() => select(slot.id)}
            className={`
              flex items-center gap-3 w-full
              px-4 py-3 rounded-xl border text-left
              transition-all duration-150 cursor-pointer
              ${active
                ? "bg-sky-500/10 border-sky-400/40 shadow-[0_0_14px_rgba(56,189,248,0.08)]"
                : "bg-white/[0.03] border-white/[0.08] hover:bg-white/[0.07] hover:border-white/[0.14]"
              }
            `}
          >
            {slot.icon && (
              <span style={{
                fontSize: "1.5rem", lineHeight: 1, flexShrink: 0,
                opacity: active ? 1 : 0.5, transition: "opacity 0.15s",
              }}>
                {slot.icon}
              </span>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={`text-sm font-semibold ${active ? "text-sky-300" : "text-foreground"}`}
                style={{ transition: "color 0.15s" }}>
                {slot.label}
              </div>
              {slot.description && (
                <div className="text-xs text-muted-foreground mt-0.5">{slot.description}</div>
              )}
            </div>
            <RadioDot active={active} />
          </button>
        );
      })}
    </div>
  );
}

// ── LoreSwitch (explicit ON / OFF buttons) ───────────────────────────────────

export interface LoreSwitchProps {
  /** Slot id — must match the `<LoreSlot id>` bound to an entry in the editor. */
  slotId: string;
  /** Label for the ENABLE button. Defaults to "开启". */
  onLabel?: string;
  /** Label for the DISABLE button. Defaults to "关闭". */
  offLabel?: string;
  /** Optional emoji/symbol for each button. */
  onIcon?: string;
  offIcon?: string;
  className?: string;
}

/**
 * Two explicit buttons for ONE slot: one turns the bound lore ON, the other
 * turns it OFF — vs. `<LoreButton>`'s single click-to-toggle. The active side is
 * highlighted. State persists via the same `__lore_{slotId}` variable, so the
 * choice survives reloads / branch switches and the engine gates the bound entry
 * on it. Use when you want a deliberate "open / close" pair instead of a toggle.
 *
 * @example
 *   <LoreSwitch slotId="secret-codex" onLabel="翻开典籍" offLabel="合上典籍"
 *     onIcon="📖" offIcon="📕" />
 */
export function LoreSwitch({
  slotId,
  onLabel = "开启",
  offLabel = "关闭",
  onIcon,
  offIcon,
  className = "",
}: LoreSwitchProps) {
  const [active, commit] = useLoreActive(`${VAR_PREFIX}${slotId}`);

  function renderBtn(isOn: boolean) {
    const selected = active === isOn;
    const icon = isOn ? onIcon : offIcon;
    const label = isOn ? onLabel : offLabel;
    const selectedCls = isOn
      ? "bg-sky-500/20 border-sky-400/50 text-sky-300 shadow-[0_0_10px_rgba(56,189,248,0.12)]"
      : "bg-rose-500/15 border-rose-400/40 text-rose-300";
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={(e) => { e.stopPropagation(); commit(isOn); }}
        className={`
          inline-flex items-center gap-1.5 select-none
          px-3 py-1.5 rounded-full text-sm font-medium
          border transition-all duration-150 cursor-pointer
          ${selected
            ? selectedCls
            : "bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10 hover:border-white/20 hover:text-foreground"
          }
        `}
      >
        {icon && <span style={{ fontSize: "1em", lineHeight: 1 }}>{icon}</span>}
        <span>{label}</span>
        {selected && <span className={isOn ? "text-sky-400" : "text-rose-400"}><CheckIcon /></span>}
      </button>
    );
  }

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      {/* Invisible engine signal — mounts only while active */}
      {active && <LoreSlot id={slotId} />}
      {renderBtn(true)}
      {renderBtn(false)}
    </div>
  );
}

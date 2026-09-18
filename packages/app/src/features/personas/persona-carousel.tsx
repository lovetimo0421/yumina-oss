import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Pencil,
  Trash2,
  User,
  UserX,
  Sparkles,
  Loader2,
} from "lucide-react";
import { usePersonasStore, type Persona } from "@/stores/personas";
import { resolveImageUrl, cardImageUrl } from "@/lib/asset-url";
import { FieldError } from "@/components/ui/field-error";

interface PersonaAvatarProps {
  persona: Persona;
  size: number;
  className?: string;
}

function PersonaAvatar({ persona, size, className = "" }: PersonaAvatarProps) {
  const resolved = cardImageUrl(persona.avatarUrl, 128) ?? resolveImageUrl(persona.avatarUrl);
  const sizeClass = size === 64 ? "h-16 w-16" : "h-10 w-10";

  if (resolved) {
    return (
      <img
        src={resolved}
        alt={persona.name}
        loading="lazy"
        decoding="async"
        className={`rounded-xl object-cover ${sizeClass} ${className}`}
      />
    );
  }
  return (
    <div
      className={`flex items-center justify-center rounded-xl bg-gradient-to-br from-gold/20 to-white/5 ${sizeClass} ${className}`}
    >
      <User
        className={`text-gold/50 ${size === 64 ? "h-7 w-7" : "h-4 w-4"}`}
      />
    </div>
  );
}

interface PersonaCarouselProps {
  onEdit: (persona: Persona | null) => void;
  sessionSelection?: { personaId: string | null; hasPersona: boolean; onSelect: (id: string | null) => Promise<void> };
}

export function PersonaCarousel({ onEdit, sessionSelection }: PersonaCarouselProps) {
  const { t } = useTranslation("profile");
  const {
    personas: storedPersonas,
    loading,
    savingSelection,
    fetchPersonas,
    activatePersona,
    deactivatePersonas,
    deletePersona,
  } = usePersonasStore();

  const personas = sessionSelection
    ? storedPersonas.map((p) => ({ ...p, isActive: p.id === sessionSelection.personaId }))
    : storedPersonas;

  // activeIndex tracks which persona index is in the center slot
  const [activeIndex, setActiveIndex] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    fetchPersonas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When personas change, snap activeIndex to the active persona
  useEffect(() => {
    const idx = personas.findIndex((p) => p.isActive);
    setActiveIndex(idx === -1 ? personas.length : idx);
  }, [storedPersonas, sessionSelection?.personaId]);

  const total = personas.length;
  // Slots: personas + "No persona" + "New".
  const totalSlots = total + 2;

  const prev = () => setActiveIndex((i) => (i - 1 + totalSlots) % totalSlots);
  const next = () => setActiveIndex((i) => (i + 1) % totalSlots);

  const leftIndex = (activeIndex - 1 + totalSlots) % totalSlots;
  const rightIndex = (activeIndex + 1) % totalSlots;

  const isNoPersonaSlot = (idx: number) => idx === total;
  const isNewSlot = (idx: number) => idx === total + 1;

  const handleActivate = async (persona: Persona) => {
    if (sessionSelection) return sessionSelection.onSelect(persona.id);
    if (persona.isActive || savingSelection) return;
    setSaveFailed(false);
    setSaveFailed(!await activatePersona(persona.id));
  };

  const handleDeactivate = async () => {
    if (sessionSelection) return sessionSelection.onSelect(null);
    if (savingSelection || !personas.some((p) => p.isActive)) return;
    setSaveFailed(false);
    setSaveFailed(!await deactivatePersonas());
  };

  const handleDelete = async (persona: Persona) => {
    if (!confirm(t("persona.deleteConfirm"))) return;
    await deletePersona(persona.id);
  };

  // ── Loading state ────────────────────────────────────────────────────────────
  if (loading && personas.length === 0) {
    return (
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold text-main">
            <div className="h-4 w-1 rounded-full bg-gold" />
            {t("persona.title")}
          </h2>
        </div>
        <div className="profile-overview-glass profile-overview-glass--soft group/section relative overflow-hidden rounded-2xl transition-all duration-300 hover:border-gold/30">
          <div className="absolute left-0 top-0 h-[2px] w-full bg-gradient-to-r from-gold/20 via-gold to-gold/20 opacity-50 transition-opacity group-hover/section:opacity-100" />
          <div className="flex h-52 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-gold/60" />
          </div>
        </div>
      </section>
    );
  }

  // ── Empty state ──────────────────────────────────────────────────────────────
  if (!loading && personas.length === 0) {
    return (
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold text-main">
            <div className="h-4 w-1 rounded-full bg-gold" />
            {t("persona.title")}
          </h2>
        </div>
        <button
          onClick={() => onEdit(null)}
          className="profile-overview-glass profile-overview-glass--soft group/section relative w-full overflow-hidden rounded-2xl transition-all duration-300 hover:border-gold/30"
        >
          <div className="absolute left-0 top-0 h-[2px] w-full bg-gradient-to-r from-gold/20 via-gold to-gold/20 opacity-50 transition-opacity group-hover/section:opacity-100" />
          <div className="flex h-52 flex-col items-center justify-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border-2 border-dashed border-gold/30 bg-gold/5 transition-colors group-hover/section:border-gold/60 group-hover/section:bg-gold/10">
              <Plus className="h-6 w-6 text-gold/50 transition-colors group-hover/section:text-gold/80" />
            </div>
            <p className="text-sm font-medium text-sub/70 transition-colors group-hover/section:text-sub">
              {t("persona.empty")}
            </p>
          </div>
        </button>
      </section>
    );
  }

  // ── Normal carousel ──────────────────────────────────────────────────────────
  return (
    <section>
      {/* Section header */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-bold text-main">
          <div className="h-4 w-1 rounded-full bg-gold" />
          {t("persona.title")}
        </h2>
      </div>

      {/* Glass card */}
      <div className="profile-overview-glass profile-overview-glass--soft group/section relative overflow-hidden rounded-2xl transition-all duration-300 hover:border-gold/30">
        <div className="absolute left-0 top-0 h-[2px] w-full bg-gradient-to-r from-gold/20 via-gold to-gold/20 opacity-50 transition-opacity group-hover/section:opacity-100" />

        <div className="flex flex-col items-center gap-5 py-7 px-4">
          {/* Carousel row */}
          <div className="flex w-full items-center justify-center gap-3">
            {/* Left arrow */}
            <button
              onClick={prev}
              aria-label="Previous persona"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-sub/60 transition-all hover:border-gold/40 hover:bg-gold/10 hover:text-gold active:scale-95"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

            {/* Left neighbor */}
            <div
              className="hidden w-20 shrink-0 cursor-pointer flex-col items-center gap-2 opacity-40 transition-all duration-300 hover:opacity-60 sm:flex"
              onClick={() => setActiveIndex(leftIndex)}
            >
              <CompactCard
                index={leftIndex}
                personas={personas}
                isNoPersonaSlot={isNoPersonaSlot(leftIndex)}
                isNewSlot={isNewSlot(leftIndex)}
                noPersonaLabel={t("persona.none")}
                newLabel={t("persona.new")}
                onNew={() => onEdit(null)}
              />
            </div>

            {/* Center card (active slot) */}
            <div className="w-44 shrink-0 transition-all duration-300">
              <CenterCard
                index={activeIndex}
                personas={personas}
                isNoPersonaSlot={isNoPersonaSlot(activeIndex)}
                isNewSlot={isNewSlot(activeIndex)}
                noPersonaLabel={t("persona.none")}
                noPersonaDescription={t("persona.noneDescription")}
                newLabel={t("persona.new")}
                activeLabel={t("persona.active")}
                editLabel={t("persona.edit")}
                deleteLabel={t("persona.delete")}
                onNew={() => onEdit(null)}
                onDeactivate={handleDeactivate}
                onEdit={onEdit}
                selectionHasPersona={sessionSelection?.hasPersona}
                allowReselect={!!sessionSelection}
                onActivate={handleActivate}
                onDelete={handleDelete}
              />
            </div>

            {/* Right neighbor */}
            <div
              className="hidden w-20 shrink-0 cursor-pointer flex-col items-center gap-2 opacity-40 transition-all duration-300 hover:opacity-60 sm:flex"
              onClick={() => setActiveIndex(rightIndex)}
            >
              <CompactCard
                index={rightIndex}
                personas={personas}
                isNoPersonaSlot={isNoPersonaSlot(rightIndex)}
                isNewSlot={isNewSlot(rightIndex)}
                noPersonaLabel={t("persona.none")}
                newLabel={t("persona.new")}
                onNew={() => onEdit(null)}
              />
            </div>

            {/* Right arrow */}
            <button
              onClick={next}
              aria-label="Next persona"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-sub/60 transition-all hover:border-gold/40 hover:bg-gold/10 hover:text-gold active:scale-95"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Dots */}
          <div className="flex items-center gap-1.5">
            {Array.from({ length: totalSlots }).map((_, i) => (
              <button
                key={i}
                onClick={() => setActiveIndex(i)}
                aria-label={`Go to persona ${i + 1}`}
                className={`rounded-full transition-all duration-300 ${
                  i === activeIndex
                    ? "h-2 w-4 bg-gold"
                    : "h-2 w-2 bg-white/20 hover:bg-white/40"
                }`}
              />
            ))}
          </div>
          {!sessionSelection && <>
            {savingSelection && <Loader2 aria-label={t("persona.title")} className="h-4 w-4 animate-spin text-gold" />}
            <FieldError message={saveFailed ? t("persona.session.saveError") : null} />
          </>}
        </div>
      </div>
    </section>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

interface CompactCardProps {
  index: number;
  personas: Persona[];
  isNoPersonaSlot: boolean;
  isNewSlot: boolean;
  noPersonaLabel: string;
  newLabel: string;
  onNew: () => void;
}

function CompactCard({
  index,
  personas,
  isNoPersonaSlot,
  isNewSlot,
  noPersonaLabel,
  newLabel,
  onNew,
}: CompactCardProps) {
  if (isNoPersonaSlot) {
    return (
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-white/5">
          <UserX className="h-4 w-4 text-sub/60" />
        </div>
        <span className="max-w-[80px] truncate text-center text-[10px] font-medium text-sub/70">
          {noPersonaLabel}
        </span>
      </div>
    );
  }

  if (isNewSlot) {
    return (
      <div
        className="flex flex-col items-center gap-1.5"
        onClick={(e) => {
          e.stopPropagation();
          onNew();
        }}
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border-2 border-dashed border-white/20 bg-white/5">
          <Plus className="h-4 w-4 text-white/40" />
        </div>
        <span className="max-w-[80px] truncate text-center text-[10px] font-medium text-sub/60">
          {newLabel}
        </span>
      </div>
    );
  }

  const persona = personas[index];
  if (!persona) return null;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <PersonaAvatar persona={persona} size={40} />
      <span className="max-w-[80px] truncate text-center text-[10px] font-medium text-sub/70">
        {persona.name}
      </span>
      {/* Private note — shown on side cards too, so same-named personas are
          distinguishable without flipping each one to the center slot (the
          in-play dialog mostly shows side cards). */}
      {persona.note && (
        <span
          className="-mt-1 max-w-[80px] truncate text-center text-[9px] font-medium text-sub/40"
          title={persona.note}
        >
          {persona.note}
        </span>
      )}
    </div>
  );
}

interface CenterCardProps {
  allowReselect?: boolean;
  selectionHasPersona?: boolean;
  index: number;
  personas: Persona[];
  isNoPersonaSlot: boolean;
  isNewSlot: boolean;
  noPersonaLabel: string;
  noPersonaDescription: string;
  newLabel: string;
  activeLabel: string;
  editLabel: string;
  deleteLabel: string;
  onNew: () => void;
  onDeactivate: () => void;
  onEdit: (persona: Persona | null) => void;
  onActivate: (persona: Persona) => void;
  onDelete: (persona: Persona) => void;
}

function CenterCard({
  allowReselect,
  selectionHasPersona,
  index,
  personas,
  isNoPersonaSlot,
  isNewSlot,
  noPersonaLabel,
  noPersonaDescription,
  newLabel,
  activeLabel,
  editLabel,
  deleteLabel,
  onNew,
  onDeactivate,
  onEdit,
  onActivate,
  onDelete,
}: CenterCardProps) {
  if (isNoPersonaSlot) {
    const selected = selectionHasPersona === undefined ? !personas.some((p) => p.isActive) : !selectionHasPersona;
    return (
      <button
        type="button"
        onClick={() => !selected && onDeactivate()}
        aria-pressed={selected}
        disabled={selected}
        className={`relative flex w-full flex-col items-center gap-3 rounded-2xl border-2 px-4 py-5 text-center transition-all duration-300 ${
          selected
            ? "cursor-default border-gold/30 bg-gold/[0.05] shadow-[0_0_30px_rgba(255,215,0,0.1)]"
            : "cursor-pointer border-white/10 bg-white/[0.02] hover:border-gold/20 hover:bg-white/[0.04]"
        }`}
      >
        {selected && (
          <div className="absolute -top-3 left-1/2 -translate-x-1/2">
            <div className="flex items-center gap-1 rounded-full border border-gold/30 bg-[#1a1a0e] px-2.5 py-0.5 shadow-[0_0_10px_rgba(255,215,0,0.2)]">
              <Sparkles className="h-2.5 w-2.5 text-gold" />
              <span className="text-[10px] font-bold uppercase tracking-wider text-gold">
                {activeLabel}
              </span>
            </div>
          </div>
        )}
        <div className={`flex h-16 w-16 items-center justify-center rounded-xl border ${
          selected ? "border-gold/30 bg-gold/10" : "border-white/15 bg-white/5"
        }`}>
          <UserX className={`h-7 w-7 ${selected ? "text-gold" : "text-sub/60"}`} />
        </div>
        <span className={`text-sm font-bold ${selected ? "text-gold" : "text-main"}`}>
          {noPersonaLabel}
        </span>
        <span className="text-[10px] leading-relaxed text-sub/60">
          {noPersonaDescription}
        </span>
      </button>
    );
  }

  if (isNewSlot) {
    return (
      <button
        onClick={onNew}
        className="group/new flex w-full flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-white/15 bg-white/[0.02] py-6 px-4 transition-all duration-200 hover:border-gold/40 hover:bg-gold/5"
      >
        <div className="flex h-16 w-16 items-center justify-center rounded-xl border-2 border-dashed border-gold/25 bg-gold/5 transition-colors group-hover/new:border-gold/50 group-hover/new:bg-gold/10">
          <Plus className="h-7 w-7 text-gold/40 transition-colors group-hover/new:text-gold/70" />
        </div>
        <span className="text-xs font-semibold text-sub/60 transition-colors group-hover/new:text-sub">
          {newLabel}
        </span>
      </button>
    );
  }

  const persona = personas[index];
  if (!persona) return null;

  return (
    <div
      className={`relative flex flex-col items-center gap-3 rounded-2xl border-2 py-5 px-4 transition-all duration-300 ${
        persona.isActive
          ? "border-gold/30 bg-gold/[0.05] shadow-[0_0_30px_rgba(255,215,0,0.1)]"
          : "cursor-pointer border-white/10 bg-white/[0.02] hover:border-gold/20 hover:bg-white/[0.04]"
      }`}
      onClick={() => (allowReselect || !persona.isActive) && onActivate(persona)}
    >
      {/* Active badge */}
      {persona.isActive && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <div className="flex items-center gap-1 rounded-full border border-gold/30 bg-[#1a1a0e] px-2.5 py-0.5 shadow-[0_0_10px_rgba(255,215,0,0.2)]">
            <Sparkles className="h-2.5 w-2.5 text-gold" />
            <span className="text-[10px] font-bold uppercase tracking-wider text-gold">
              {activeLabel}
            </span>
          </div>
        </div>
      )}

      {/* Avatar */}
      <PersonaAvatar
        persona={persona}
        size={64}
        className={persona.isActive ? "ring-2 ring-gold/30 ring-offset-2 ring-offset-transparent" : ""}
      />

      {/* Name */}
      <span
        className={`max-w-full truncate text-center text-sm font-bold transition-colors ${
          persona.isActive ? "text-gold" : "text-main"
        }`}
      >
        {persona.name}
      </span>

      {/* Private note — user-only label to tell same-named personas apart */}
      {persona.note && (
        <span
          className="-mt-2 max-w-full truncate text-center text-[10px] font-medium text-sub/60"
          title={persona.note}
        >
          {persona.note}
        </span>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit(persona);
          }}
          aria-label={editLabel}
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-sub/60 transition-all hover:border-gold/40 hover:bg-gold/10 hover:text-gold active:scale-95"
        >
          <Pencil className="h-3 w-3" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(persona);
          }}
          aria-label={deleteLabel}
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-sub/60 transition-all hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400 active:scale-95"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

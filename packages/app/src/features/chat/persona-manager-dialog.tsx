import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PersonaCarousel } from "@/features/personas/persona-carousel";
import { PersonaEditModal } from "@/features/personas/persona-edit-modal";
import { useChatStore } from "@/stores/chat";
import { FieldError } from "@/components/ui/field-error";
import { usePersonasStore, type Persona } from "@/stores/personas";
import { createChatPersonaController } from "@/lib/refresh-chat-persona";
import { Lock, Unlock } from "lucide-react";

interface PersonaManagerDialogProps {
  open: boolean;
  onClose: () => void;
  sessionId?: string;
}

/** A chat selection belongs to this save; following the account is explicit. */
export function PersonaManagerDialog({ open, onClose, sessionId }: PersonaManagerDialogProps) {
  const { t } = useTranslation("profile");
  const [editingPersona, setEditingPersona] = useState<Persona | null | undefined>(undefined);

  const [saving, setSaving] = useState(false);
  // R3/R4: the dialog stays open, so the failure belongs inside it — under the
  // carousel the user just clicked, never in a pill.
  const [saveError, setSaveError] = useState<string | null>(null);
  const streaming = useChatStore((s) => s.isStreaming);
  const session = useChatStore((s) => s.session);
  const saved = session && session.id === sessionId ? session.sessionPersona?.persona : undefined;
  const locked = session?.id === sessionId && session?.personaLocked === true;
  const source = usePersonasStore((s) => s.personas.find((p) => locked ? p.id === saved?.id : p.isActive));
  const fetchPersonas = usePersonasStore((s) => s.fetchPersonas);
  // Only committed selection/public-field changes refresh identity.
  const sourceVersion = source ? JSON.stringify([
    source.id, source.name, source.avatarUrl, source.appearance, source.personality, source.backstory,
  ]) : null;
  const controller = useRef<ReturnType<typeof createChatPersonaController> | null>(null);
  useEffect(() => {
    setSaving(false);
    setSaveError(null);
    if (!sessionId) return;
    const current = createChatPersonaController({
      sessionId, apiBase: import.meta.env.VITE_API_URL || "",
      getState: useChatStore.getState,
      apply: (session) => useChatStore.setState({ session }),
      onSaving: setSaving,
      onError: (error) => setSaveError(error ? t("persona.session.saveError") : null),
    });
    controller.current = current;
    return () => { current.dispose(); controller.current = null; };
  }, [sessionId, t]);
  useEffect(() => { controller.current?.setBlocked(streaming); }, [sessionId, streaming, t]);
  // Dismissing the dialog does not cancel an in-flight save or identity refresh.
  useEffect(() => { if (open) controller.current?.refresh(); }, [open, sessionId, t]);
  useEffect(() => {
    if (!sessionId) return;
    const refreshVisible = () => {
      if (document.visibilityState === "hidden") return;
      void fetchPersonas(true);
      controller.current?.refresh();
    };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [sessionId, fetchPersonas]);
  const previousSource = useRef({ sessionId, sourceVersion });
  useEffect(() => {
    const previous = previousSource.current;
    if (previous.sessionId === sessionId && previous.sourceVersion !== sourceVersion) {
      controller.current?.refresh();
    }
    previousSource.current = { sessionId, sourceVersion };
  }, [sessionId, sourceVersion]);
  const select = async (personaId: string | null) => {
    await controller.current?.setLock(true, personaId);
  };
  const toggleLock = async () => {
    await controller.current?.setLock(!locked, saved?.id ?? null);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="border-white/10 bg-[#1F1D21] p-6 text-main shadow-2xl shadow-gold/5 sm:max-w-[500px] sm:rounded-3xl">
          <DialogTitle className="sr-only">{t("persona.title")}</DialogTitle>
          <p className="text-sm text-muted-foreground">{t("persona.session.current", { name: saved?.name ?? t("persona.none") })}</p>
          <button
            type="button"
            role="switch"
            aria-checked={locked}
            disabled={saving || streaming || !sessionId}
            onClick={() => void toggleLock()}
            className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors disabled:opacity-60 ${
              locked ? "border-gold/35 bg-gold/[0.08]" : "border-white/10 bg-white/[0.03] hover:border-white/20"
            }`}
          >
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${locked ? "bg-gold/15 text-gold" : "bg-white/5 text-sub"}`}>
              {locked ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-main">
                {t(locked ? "persona.session.locked" : "persona.session.following")}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                {t(locked ? "persona.session.lockedHint" : "persona.session.followingHint")}
              </span>
            </span>
            <span className={`h-5 w-9 rounded-full p-0.5 transition-colors ${locked ? "bg-gold" : "bg-white/15"}`} aria-hidden="true">
              <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${locked ? "translate-x-4" : "translate-x-0"}`} />
            </span>
          </button>
          <fieldset disabled={saving || streaming || !sessionId} className="min-w-0 disabled:opacity-60">
            <PersonaCarousel onEdit={(persona) => setEditingPersona(persona)}
              sessionSelection={{ personaId: saved?.id ?? null, hasPersona: !!saved, onSelect: select }} />
          </fieldset>
          <FieldError message={saveError} />
        </DialogContent>
      </Dialog>
      <PersonaEditModal
        isOpen={editingPersona !== undefined}
        onClose={() => setEditingPersona(undefined)}
        persona={editingPersona ?? null}
      />
    </>
  );
}

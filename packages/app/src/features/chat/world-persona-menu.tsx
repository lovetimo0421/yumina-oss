import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, UserRound } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field-error";
import { usePersonasStore } from "@/stores/personas";
import { useSession } from "@/lib/auth-client";

/** The session picker shares the profile selection, including existing chats.
 * Keep the prop contract for callers; world bindings no longer override identity. */
export function WorldPersonaIconMenu({ className = "", disabled = false }: {
  worldId: string;
  className?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("profile");
  const { data: session } = useSession();
  const { personas, fetchPersonas, activatePersona, deactivatePersonas, savingSelection } = usePersonasStore();
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = personas.find((p) => p.isActive);
  const authenticated = !!session?.user;
  useEffect(() => {
    if (authenticated) void fetchPersonas();
  }, [authenticated, open, fetchPersonas]);

  if (!authenticated || personas.length === 0) return null;
  const select = async (id: string | null) => {
    setFailed(false);
    const saved = id === null ? await deactivatePersonas() : await activatePersona(id);
    if (saved) setOpen(false);
    else setFailed(true);
  };
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" disabled={disabled || savingSelection}
          title={t("persona.session.current", { name: active?.name ?? t("persona.none") })}
          aria-label={t("persona.session.current", { name: active?.name ?? t("persona.none") })}
          className={`flex h-7 w-7 items-center justify-center rounded-lg text-primary transition-colors hover:bg-primary/10 ${className}`}>
          <UserRound aria-hidden="true" className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-[100] max-h-[60vh] min-w-[15rem] max-w-[19rem] overflow-y-auto rounded-2xl border-white/10 bg-[#201E23] p-2 text-main shadow-2xl">
        <p className="px-2 py-1.5 text-sm font-bold">{t("persona.title")}</p>
        {[null, ...personas].map((persona) => {
          const selected = persona ? persona.id === active?.id : !active;
          return <DropdownMenuItem key={persona?.id ?? "none"} role="menuitemradio" aria-checked={selected}
            disabled={disabled || savingSelection}
            onSelect={(event) => { event.preventDefault(); void select(persona?.id ?? null); }}
            className={`gap-2 rounded-xl px-3 py-2 ${selected ? "bg-gold/10 text-gold" : "text-main"}`}>
            <UserRound aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{persona?.name ?? t("persona.none")}</span>
              {persona?.note && <span className="block truncate text-xs text-sub/70" title={persona.note}>{persona.note}</span>}
            </span>
            {selected && <Check aria-hidden="true" className="h-4 w-4 shrink-0" />}
          </DropdownMenuItem>;
        })}
        <FieldError message={failed ? t("persona.session.saveError") : null} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

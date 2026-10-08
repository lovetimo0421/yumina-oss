import { useTranslation } from "react-i18next";
import { useSession } from "@/lib/auth-client";
import { useEditorStore } from "@/stores/editor";

/** A load that failed leaves serverWorldId null, which the editor routes read as
 *  "still loading" — without this the editor spins forever on someone else's
 *  card or a dropped connection. */
export function EditorUnavailable({ reason }: { reason: "notFound" | "failed" }) {
  const { t } = useTranslation("common");
  return (
    <div className="flex h-full w-full items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <p className="text-sm leading-relaxed text-muted-foreground">
          {reason === "notFound" ? t("studioNotYours") : t("studioLoadFailed")}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {t("action.retry")}
          </button>
          <a
            href="/app/profile"
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground transition-opacity hover:opacity-90"
          >
            {t("backToMyWorlds")}
          </a>
        </div>
      </div>
    </div>
  );
}

/** Whether the loaded card belongs to someone else. A published card's GET
 *  succeeds for any signed-in user, so a 200 alone used to open a stranger's
 *  card in the editor (reached from the Library with browser Back). Admins
 *  read others' cards through read-only inspect, which is exempt. */
export function useEditorOwnership(worldId: string): "pending" | "notMine" | null {
  const { data: session, isPending } = useSession();
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const serverCreatorId = useEditorStore((s) => s.serverCreatorId);
  const readOnlyInspect = useEditorStore((s) => s.readOnlyInspect);
  if (serverWorldId !== worldId || !serverCreatorId || readOnlyInspect) return null;
  if (isPending) return "pending";
  return session?.user?.id === serverCreatorId ? null : "notMine";
}

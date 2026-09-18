import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Suspense, useEffect } from "react";
import { useEditorStore } from "@/stores/editor";
import { Loader2 } from "lucide-react";
import { getSessionSafe } from "@/lib/auth-client";
import { lazyRouteComponent } from "@/lib/lazy-route-component";

const StudioShell = lazyRouteComponent(
  () => import("@/features/studio/studio-shell"),
  (m) => m.StudioShell
);

function StudioLoading() {
  const { t } = useTranslation("common");
  return (
    <div className="flex h-full w-full items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span className="text-sm">{t("loadingStudio")}</span>
      </div>
    </div>
  );
}

function StudioPage() {
  const { worldId } = Route.useParams();
  const loadWorld = useEditorStore((s) => s.loadWorld);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const loadingWorld = useEditorStore((s) => s.loadingWorld);

  useEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [worldId]);

  useEffect(() => {
    if (serverWorldId !== worldId) {
      loadWorld(worldId);
    }
  }, [worldId, loadWorld, serverWorldId]);

  if (loadingWorld || serverWorldId !== worldId) {
    return <StudioLoading />;
  }

  return (
    <Suspense fallback={<StudioLoading />}>
      <StudioShell />
    </Suspense>
  );
}

export const Route = createFileRoute("/app/studio/$worldId")({
  beforeLoad: async () => {
    const session = await getSessionSafe();
    if (!session.data) throw redirect({ to: "/login" });
  },
  component: StudioPage,
});

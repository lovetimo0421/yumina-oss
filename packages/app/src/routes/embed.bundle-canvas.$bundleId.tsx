import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { BundleCanvasEmbed } from "@/edition/slots";

// A resource pack's canvas, read only, as a page of its own. The market shows
// it in a frame: this page has its own copy of the editor store, so looking at
// a pack never touches the card someone has open in Studio. (Lazy, through the
// edition seam: the market is hosted-only.)

function EmbedRoute() {
  const { bundleId } = Route.useParams();
  const { screen } = Route.useSearch();
  return (
    <Suspense fallback={<Loading />}>
      <BundleCanvasEmbed bundleId={bundleId} liveScreen={screen === "live"} />
    </Suspense>
  );
}

export const Route = createFileRoute("/embed/bundle-canvas/$bundleId")({
  validateSearch: (search: Record<string, unknown>): { screen?: "live" } => ({
    screen: search.screen === "live" ? "live" : undefined,
  }),
  component: EmbedRoute,
});

function Loading() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[#0e0f16]">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
    </div>
  );
}

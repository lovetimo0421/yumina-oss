import { createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { requireSession } from "@/lib/require-session";
import { lazyRouteComponent } from "@/lib/lazy-route-component";

const StoryRoomPage = lazyRouteComponent(
  () => import("@/features/story-room/room-page"),
  (m) => m.StoryRoomPage,
);

export const Route = createFileRoute("/app/room/$code")({
  beforeLoad: async ({ location }) => {
    await requireSession(location);
  },
  component: () => {
    const { code } = Route.useParams();
    return (
      <Suspense fallback={<Loading />}>
        <StoryRoomPage code={code.toUpperCase()} />
      </Suspense>
    );
  },
});

function Loading() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
    </div>
  );
}

import { Suspense } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ProfileRoot } from "@/edition/slots";

// `/app/profile` exists in both editions. The seam decides what it shows:
// hosted renders the social profile, local renders the identity page
// (avatar, display name, personas, shortcuts). Both slots are lazy.
export const Route = createFileRoute("/app/profile/")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex h-full w-full items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <ProfileRoot />
    </Suspense>
  ),
});

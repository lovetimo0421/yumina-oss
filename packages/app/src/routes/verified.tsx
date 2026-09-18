import { createFileRoute } from "@tanstack/react-router";
import { VerifiedPage } from "@/features/auth/verified-page";

export const Route = createFileRoute("/verified")({
  component: VerifiedPage,
});

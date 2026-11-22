import { createFileRoute } from "@tanstack/react-router";
import { PublicPage } from "@/components/public-page";

/** One update-log entry in another language. The page is written on the server (see components/public-page.tsx). */
export const Route = createFileRoute("/updates_/$id_/$lang")({ component: PublicPage });

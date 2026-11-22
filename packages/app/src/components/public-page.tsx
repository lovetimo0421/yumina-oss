import { useEffect, useState, type MouseEvent } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/app-shell";
import { NotFoundPage } from "@/components/not-found-page";
import { RouteFallback } from "@/components/route-fallback";
import { setDocumentTitleOverride } from "@/lib/document-title";

const apiBase = import.meta.env.VITE_API_URL || "";

type State = { status: "loading" } | { status: "missing" } | { status: "ready"; title: string; lang: string; html: string };

/**
 * A public intro page (pricing, the Atelier and its model and style pages,
 * one update-log entry, the genre pages such as /ai-rpg). The words are
 * written once, on the server, and sent in the HTML for search engines; the
 * app shows the same fragment here, so a visitor reads exactly what was
 * indexed and the copy lives in one place (the server's lib/pricing-public.ts,
 * atelier-public.ts, updates-public.ts, landing-public.ts).
 *
 * The fragment is built by our own server from constants, the update log and,
 * on the genre pages, the names and descriptions of public worlds. Every value
 * is escaped there, so what a member typed arrives as text, never as markup.
 */
export function PublicPage() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/public-page?path=${encodeURIComponent(pathname)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) return setState({ status: "missing" });
        const { data } = (await res.json()) as { data: { title: string; lang: string; html: string } };
        if (!controller.signal.aborted) setState({ status: "ready", title: data.title, lang: data.lang, html: data.html });
      } catch {
        if (!controller.signal.aborted) setState({ status: "missing" });
      }
    })();
    return () => controller.abort();
  }, [pathname]);

  const title = state.status === "ready" ? state.title : null;
  useEffect(() => {
    if (!title) return;
    setDocumentTitleOverride(title);
    return () => setDocumentTitleOverride(null);
  }, [title]);

  // Links inside the fragment are plain anchors; keep a click on one of the
  // site's own addresses inside the app instead of reloading the page.
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as HTMLElement).closest("a");
    const href = anchor?.getAttribute("href");
    if (!anchor || !href || !href.startsWith("/") || href.startsWith("//") || anchor.target === "_blank") return;
    // The blog is a server-rendered site of its own.
    if (href === "/blog" || href.startsWith("/blog/")) return;
    event.preventDefault();
    router.history.push(href);
  };

  if (state.status === "missing") return <NotFoundPage standalone />;
  return (
    <AppShell>
      {state.status === "loading"
        ? <RouteFallback />
        : <div className="h-full overflow-y-auto" lang={state.lang} onClick={onClick} dangerouslySetInnerHTML={{ __html: state.html }} />}
    </AppShell>
  );
}

/**
 * Small pieces the public pages share (/pricing, /atelier and its model and
 * style pages, the tag pages, the genre pages such as /ai-rpg): escaping, the
 * FAQ block and its structured data, breadcrumbs, a list of worlds.
 */
import { profileAddressPath } from "@yumina/shared";
import { PUBLIC_ORIGIN } from "./env.js";
import { stripLeadingTitle, summarizeText } from "./seo-text.js";
import { canonicalWorldPath } from "./world-address.js";

export function esc(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A question and its answer, both plain text. */
export interface Faq {
  q: string;
  a: string;
}

/** The questions as visible HTML: the same words the FAQPage data carries. */
export function faqHtml(items: Faq[]): string {
  return `<dl class="pre-faq">${items.map((f) => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join("")}</dl>`;
}

/** FAQPage structured data for the same questions. */
export function faqLd(items: Faq[]): Record<string, unknown> {
  return {
    "@type": "FAQPage",
    mainEntity: items.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };
}

/** BreadcrumbList from site paths, outermost first. */
export function breadcrumbLd(trail: Array<{ name: string; path: string }>): Record<string, unknown> {
  return {
    "@type": "BreadcrumbList",
    itemListElement: trail.map((step, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: step.name,
      item: `${PUBLIC_ORIGIN}${step.path === "/" ? "" : step.path}`,
    })),
  };
}

/** The same trail as links at the top of the page. */
export function breadcrumbHtml(trail: Array<{ name: string; path: string }>): string {
  return `<p class="pre-by">${trail.map((step) => `<a href="${esc(step.path)}">${esc(step.name)}</a>`).join(" · ")}</p>`;
}

/** What a list of worlds shows for each one. */
export interface ListedWorld {
  id: string;
  publicId: string | null;
  name: string;
  creatorName: string | null;
  creatorUsername: string | null;
  description: string | null;
}

/** A world's address on this site. */
export function worldHref(card: Pick<ListedWorld, "id" | "publicId" | "name" | "creatorUsername">): string {
  return encodeURI(canonicalWorldPath(card) ?? `/app/hub/${card.id}`);
}

/** A creator's page, by handle when they have one, else by id. */
export function creatorHref(username: string | null | undefined, id?: string): string | null {
  const path = profileAddressPath(username);
  if (path) return encodeURI(path);
  return id ? `/app/users/${encodeURIComponent(id)}` : null;
}

/** Worlds as a numbered list: name linked to the world, creator, and the start of its description. */
export function worldListHtml(worlds: ListedWorld[]): string {
  const items = worlds
    .map((w) => {
      const creator = creatorHref(w.creatorUsername);
      const by = w.creatorName
        ? creator
          ? ` <span class="pre-card__by"><a href="${esc(creator)}">${esc(w.creatorName)}</a></span>`
          : ` <span class="pre-card__by">${esc(w.creatorName)}</span>`
        : "";
      const text = summarizeText(stripLeadingTitle(w.description, w.name), { max: 220, min: 120 });
      return `<li><a href="${esc(worldHref(w))}">${esc(w.name)}</a>${by}${text ? `<p>${esc(text)}</p>` : ""}</li>`;
    })
    .join("");
  return `<ol class="pre-list pre-text">${items}</ol>`;
}

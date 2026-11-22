import { useMemo } from "react";

import { isHtmlDescription, renderCommunityMarkdown, renderHtmlDescription } from "@/lib/markdown";
import { cn } from "@/lib/utils";

/**
 * Decoration for markdown blocks inside a world description. Structural only —
 * the caller still owns the base text size/colour so each surface (Discover
 * modal, library detail, mobile sheet) keeps its own typography.
 */
export const worldDescriptionProseClass = cn(
  "[&_a]:text-primary [&_a]:no-underline [&_a:hover]:underline",
  "[&_code]:bg-white/[0.08] [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs",
  "[&_pre]:bg-white/[0.05] [&_pre]:rounded-lg [&_pre]:p-3",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2",
  "[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2",
  "[&_li]:my-0.5",
  "[&_hr]:border-white/10 [&_hr]:my-4",
  "[&_img]:rounded-lg [&_img]:max-w-full [&_img]:my-2",
);

interface WorldDescriptionProps {
  /** Raw creator-authored markdown. */
  content: string;
  /** Base typography for the block (size, colour, leading). */
  className?: string;
}

/**
 * Renders a world's description/announcement markdown. Every surface that shows
 * the full text goes through here so Discover and Library can't drift apart
 * again — the library panels used to print the raw source.
 */
/**
 * A description written in HTML keeps the creator's own layout, so it is
 * fenced in: `contain: paint` makes this box the containing block for
 * anything positioned inside (a `position: fixed` overlay stays in the box)
 * and clips whatever spills out of it.
 */
const HTML_DESCRIPTION_CONTAINMENT = { contain: "paint", position: "relative", overflowWrap: "anywhere" } as const;

export function WorldDescription({ content, className }: WorldDescriptionProps) {
  const isHtml = useMemo(() => isHtmlDescription(content), [content]);
  const html = useMemo(
    () => isHtml ? renderHtmlDescription(content, { theme: "dark" }) : renderCommunityMarkdown(content, { theme: "dark" }),
    [content, isHtml],
  );

  return (
    <div
      className={cn(worldDescriptionProseClass, className)}
      style={isHtml ? HTML_DESCRIPTION_CONTAINMENT : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

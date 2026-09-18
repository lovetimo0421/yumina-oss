import { useMemo } from "react";
import { renderMessage } from "@/lib/markdown";
import { stripDirectives } from "@/lib/strip-directives";

/** Renders markdown text that grows token-by-token during streaming. */
export function StreamingText({ content }: { content: string }) {
  const html = useMemo(() => (content ? renderMessage(stripDirectives(content)) : ""), [content]);
  if (!content) return null;
  return (
    <div
      className="prose prose-sm prose-invert max-w-none text-xs [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

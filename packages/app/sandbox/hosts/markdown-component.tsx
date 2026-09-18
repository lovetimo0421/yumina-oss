/**
 * MarkdownComponent — Renders markdown content inside the sandbox.
 *
 * Uses the existing sandbox-side markdown renderer (DOMPurify-sanitized).
 * Re-renders when the markdown source changes.
 */

import React, { useMemo } from "react";
import { renderMarkdown } from "../chat/markdown";

export function MarkdownComponent({ code }: { code: string }) {
  const html = useMemo(() => renderMarkdown(code), [code]);

  return (
    <div
      className="prose prose-invert max-w-none"
      style={{ padding: 16 }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

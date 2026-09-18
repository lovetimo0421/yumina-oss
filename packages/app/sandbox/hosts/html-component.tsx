/**
 * HTMLComponent — Renders raw HTML/CSS/JS inside the sandbox.
 *
 * Injects HTML via innerHTML and manually executes <script> tags
 * (browsers don't execute scripts inserted via innerHTML).
 *
 * Scripts run ONCE on install. State updates arrive via window.yumina.onChange()
 * — the HTML is NOT re-rendered on variable changes (that would destroy script state).
 */

import React, { useEffect, useRef } from "react";
import { resolveAssetUrl, resolveAssetRefs } from "../../src/lib/asset-url";

export function HTMLComponent({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const installedCodeRef = useRef<string>("");

  useEffect(() => {
    const el = containerRef.current;
    if (!el || code === installedCodeRef.current) return;
    installedCodeRef.current = code;

    // Clear previous content
    el.innerHTML = "";

    // Parse and inject HTML
    el.innerHTML = code;

    // Resolve @asset: references in style tags and inline styles
    void resolveStyleAssets(el);

    // Harden images: add referrerpolicy, resolve @asset: src, retry on error
    hardenImages(el);

    // Execute <script> tags — innerHTML doesn't run them natively.
    // Clone each script into a new element so the browser executes it.
    const scripts = el.querySelectorAll("script");
    scripts.forEach((oldScript) => {
      const newScript = document.createElement("script");
      // Copy attributes (src, type, etc.)
      for (const attr of oldScript.attributes) {
        newScript.setAttribute(attr.name, attr.value);
      }
      newScript.textContent = oldScript.textContent;
      oldScript.parentNode!.replaceChild(newScript, oldScript);
    });

    return () => {
      el.innerHTML = "";
      installedCodeRef.current = "";
    };
  }, [code]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%" }}
    />
  );
}

// ── Asset helpers (shared patterns from sandbox-host) ──────────────

function hardenImages(root: ParentNode): void {
  const images = root.querySelectorAll<HTMLImageElement>("img");
  images.forEach((img) => {
    if (!img.getAttribute("referrerpolicy")) {
      img.setAttribute("referrerpolicy", "no-referrer");
    }
    const src = img.getAttribute("src");
    if (src && src.startsWith("@asset:") && !img.dataset.yuminaAssetResolved) {
      img.dataset.yuminaAssetResolved = "1";
      resolveAssetUrl(src).then((resolved) => {
        if (resolved !== src) img.src = resolved;
      });
    }
    if (!img.dataset.yuminaRetryBound) {
      img.dataset.yuminaRetryBound = "1";
      img.addEventListener("error", () => {
        if (!img.dataset.yuminaRetried) {
          img.dataset.yuminaRetried = "1";
          const errSrc = img.getAttribute("src");
          if (!errSrc) return;
          const sep = errSrc.includes("?") ? "&" : "?";
          img.src = `${errSrc}${sep}_cb=${Date.now()}`;
        }
      });
    }
  });
}

async function resolveStyleAssets(root: ParentNode): Promise<void> {
  const styleTags = root.querySelectorAll<HTMLStyleElement>("style");
  for (const styleEl of styleTags) {
    const cssText = styleEl.textContent ?? "";
    if (!cssText.includes("@asset:")) continue;
    const resolved = await resolveAssetRefs(cssText);
    if (resolved !== cssText) styleEl.textContent = resolved;
  }
  const styledElements = root.querySelectorAll<HTMLElement>("[style]");
  for (const el of styledElements) {
    const styleAttr = el.getAttribute("style") ?? "";
    if (!styleAttr.includes("@asset:")) continue;
    const resolved = await resolveAssetRefs(styleAttr);
    if (resolved !== styleAttr) el.setAttribute("style", resolved);
  }
}

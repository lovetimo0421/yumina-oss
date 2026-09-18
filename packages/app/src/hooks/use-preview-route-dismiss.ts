import { useLayoutEffect, useRef } from "react";
import { useLocation } from "@tanstack/react-router";

/** A global preview belongs to the page that opened it, including its query state. */
export function usePreviewRouteDismiss(close: () => void) {
  const href = useLocation({ select: (location) => location.href });
  const openedHref = useRef(href);
  useLayoutEffect(() => {
    if (href !== openedHref.current) close();
  }, [href, close]);
}

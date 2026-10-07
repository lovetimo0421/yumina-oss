import { useEffect, useState } from "react";
import { isTokenizerReady, preloadTokenizer } from "@yumina/engine";

/** Flips to true when exact token counts become available, so a memo that
 *  counted with the pre-load heuristic (chars/3 — Chinese comes out ~2.7x too
 *  low) can list this in its deps and recount once. */
export function useTokenizerReady(): boolean {
  const [ready, setReady] = useState(isTokenizerReady);
  useEffect(() => {
    if (ready) return;
    let live = true;
    void preloadTokenizer().then(() => { if (live) setReady(isTokenizerReady()); });
    return () => { live = false; };
  }, [ready]);
  return ready;
}

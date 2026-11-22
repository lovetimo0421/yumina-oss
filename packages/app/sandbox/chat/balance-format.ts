/** Mushie-balance formatters for the composer's model pill: the same number
 * as the site's header pill (src/lib/format-mushies.ts), so a balance reads
 * alike in the story, the Studio and the Atelier. Pure so the app test suite
 * can import them without the sandbox runtime. */
import { formatMushiePill } from "../../src/lib/format-mushies";

export function formatBalance(n: number): string {
  return formatMushiePill(n);
}

/** Narrow toolbars keep the same balance precision as the regular display. */
export function formatBalanceCompact(n: number): string {
  return formatBalance(n);
}

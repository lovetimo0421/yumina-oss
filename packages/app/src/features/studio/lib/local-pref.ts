/**
 * Per-browser Studio preferences (panel widths, which dock is open, the
 * device the board previews on).
 *
 * localStorage throws — not returns null — in a private window or when site
 * data is blocked, and these are read in useState initialisers, so a bare
 * read there took the whole Studio down with it. A preference is only ever a
 * convenience: a browser that will not remember one gets the default.
 */
export function readLocalPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a preference that cannot be kept is simply not kept */
  }
}

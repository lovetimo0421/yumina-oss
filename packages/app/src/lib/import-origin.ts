/** Top-level key a Yumina export stamps into the card JSON: `{ worldId }` of
 *  the project the file was downloaded from, so importing it back can offer to
 *  update that same card. Kept out of import-world so the download path
 *  doesn't pull in the whole importer. Every importer strips it (see
 *  parseImportedJson) — it is never saved into a card. */
export const IMPORT_ORIGIN_KEY = "yuminaOrigin";

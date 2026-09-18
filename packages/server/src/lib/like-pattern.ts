/** Escape LIKE/ILIKE metacharacters so user input matches literally.
 *  Postgres treats `\` as the default escape character, so `%`, `_`, and `\`
 *  itself must be escaped — otherwise a user typing "100%" matches everything. */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

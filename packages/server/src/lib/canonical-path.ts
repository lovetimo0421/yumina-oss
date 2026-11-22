/** See the middleware in index.ts that uses this: a request path is served as spelled, or refused. */
export function isCanonicalPath(path: string): boolean {
  if (path.includes("//") || path.includes("\\")) return false;
  if (/%(?:2e|5c)/i.test(path)) return false;
  return !path.split("/").some((segment) => segment === "." || segment === "..");
}

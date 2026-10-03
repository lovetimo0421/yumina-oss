/** Populate the HTTP cache without importing/evaluating editor tooling in the
 * parent page. Compilation still loads on demand for legacy/edited worlds. */
export async function warmSandboxResources(entryUrl: string, fetcher: typeof fetch = fetch): Promise<void> {
  const options = { credentials: "omit", cache: "force-cache" } as const;
  const response = await fetcher(entryUrl, options);
  if (!response.ok) return;
  const html = await response.text();
  const urls = new Set<string>();
  const pattern = /<(?:script[^>]*\ssrc|link[^>]*\shref)=["']([^"']+)["']/g;
  for (const match of html.matchAll(pattern)) {
    const raw = match[1];
    if (!raw || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) continue;
    const url = raw.startsWith("/") ? raw : `/sandbox/${raw.replace(/^\.\//, "")}`;
    if (url !== entryUrl) urls.add(url);
  }
  await Promise.all([...urls].map((url) => fetcher(url, options).catch(() => undefined)));
}

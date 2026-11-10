export function addViewerLanguage(query: URLSearchParams, language: string): void {
  query.set("lang", language);
}

export function buildCommunityThreadUrl(apiBase: string, threadId: string, language: string): string {
  const query = new URLSearchParams({ lang: language });
  return `${apiBase}/api/community/threads/${encodeURIComponent(threadId)}?${query.toString()}`;
}

export function buildCommunityPostsUrl(
  apiBase: string,
  threadId: string,
  offset: number,
  limit: number,
  language: string,
  sort?: "newest" | "oldest",
): string {
  const query = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    mode: "roots",
    lang: language,
  });
  if (sort) query.set("sort", sort);
  return `${apiBase}/api/community/threads/${encodeURIComponent(threadId)}/posts?${query.toString()}`;
}

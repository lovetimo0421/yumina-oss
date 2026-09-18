/** OpenRouter groups app usage by this URL, independently of the API key.
 * Keep every Yumina inference path on the canonical app identity. */
export const OPENROUTER_APP_HEADERS = {
  "HTTP-Referer": "https://yumina.io",
  "X-OpenRouter-Title": "Yumina",
  "X-OpenRouter-Categories": "roleplay,game",
} as const;

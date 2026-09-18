# Privacy

Yumina is built so you decide what's public, what's private, and -- if you want -- where your AI conversations actually go. This page covers every privacy knob you can flip.

## Profile privacy

Open **Settings → Privacy**. There are three toggles:

| Toggle | Default | Effect |
|---|---|---|
| **Private account** | Off | Only your followers can see your activity. Non-followers see a "this profile is private" placeholder instead of your library, recently played, and stats. |
| **Allow DMs** | On | Controls whether other players can start a direct message conversation with you. Off = your inbox is closed. |
| **Show recent play** | On | Whether the "Recently Played" section appears on your public profile. Off = your active worlds stay private even on a public profile. |

Your favorites, follower count, and published worlds always respect the **Private account** setting -- when it's on, those are hidden from non-followers too.

## Anonymous tipping

Whenever you support a creator (see [Supporting Creators](./06-supporting-creators)), the tip modal has an **Anonymous** toggle:

- **Off (default):** the creator sees your username, avatar, and message
- **On:** the creator sees "Anonymous" and your message; your identity is hidden from them and from any public supporters list

Anonymous is per-tip, so you can be public on one world and private on another. The platform itself still records the tip for refund/dispute handling -- "anonymous" here means anonymous to the recipient and the public, not to Stripe.

## AI privacy: Bring Your Own Endpoint

If you don't want your AI chats running through Yumina's billing system, use **Bring Your Own Key** in **Settings → AI Configuration**. Your messages then go directly from your browser to whichever provider you've chosen, with Yumina relaying the request but never charging you mushies for the tokens.

**Supported providers (full list):**

- **OpenRouter** -- one key, hundreds of models
- **Anthropic** (Claude)
- **OpenAI** (GPT)
- **Google AI** (Gemini)
- **Ollama** -- run models locally on your own machine. Your prompts never leave your network.
- **Custom (OpenAI-compatible)** -- paste any OpenAI-compatible base URL. One-click presets for DeepSeek, xAI (Grok), Mistral, Groq, Together, Fireworks, Moonshot. You can also point at your own proxy.

**How your keys are stored:**

- Encrypted at rest with AES-256-GCM
- The raw key value is **never** returned from the server after you save it -- only metadata (provider, label, last-4 suffix) is sent back to the browser
- You can delete a key at any time; deletion removes the encrypted value immediately

**Ollama tip:** if you run Ollama on the same machine as your browser, point Yumina at `http://localhost:11434` and your AI roleplay runs entirely on your own hardware -- nothing leaves the device.

## Session privacy

- **Sessions are per-user.** Nobody else can see your chats, even on worlds you didn't create. Creators of a world do not see your sessions in it.
- **Delete a session at any time** from the session list. Deletion is immediate; the messages are removed.
- **Branch without forking history** -- when you branch from a message, the new session is its own private copy.

There is no "incognito mode" today: turns are persisted so you can resume later. If you want a throwaway session, delete it when you're done.

## What the platform tracks

For product analytics we track aggregate events (page views, button clicks, errors) and high-level usage stats (tokens used, models picked). We use these to fix bugs and improve the lineup. We don't sell any of it, and we don't read your conversation contents for analytics.

## Account deletion & data export

For account deletion or a copy of your data, email **hello@yumina.io**. We'll process the request manually within 30 days. (We're working on self-serve buttons -- they're not in the product yet.)

## See also

- [AI Settings](./04-ai-settings) — full BYOK and provider setup
- [Profile & Settings](./05-profile-and-settings) — every settings page section
- [Privacy Policy](/legal/privacy-policy) — the legal version

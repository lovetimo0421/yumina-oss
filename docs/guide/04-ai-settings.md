<div v-pre>

# AI Settings

These settings control which AI model powers your experience and how it behaves. They apply globally across all worlds. You'll find them in **Settings > AI Configuration**.

## Choosing a model

Yumina offers a curated lineup of models across four cost tiers:

| Tier | Examples | Notes |
|------|----------|-------|
| **Budget** | Yumina Free, Gemini 2.5 Flash Lite, DeepSeek V4 Flash, DeepSeek V3.2, **Claude 3 Haiku** | Good for casual play. Claude 3 Haiku is the platform default (avg ~5 mushies / message). |
| **Standard** | Gemini 3.1 Flash Lite, Gemini 2.5 Flash, Gemini 3 Flash, DeepSeek V4 Pro | Better writing quality and instruction following. |
| **Premium** | Claude Haiku 4.5, Grok 4.20, Gemini 3.1 Pro | Noticeably better characterization and narrative coherence. Requires Gold plan or above. |
| **Ultra** | Claude Sonnet 4.6, Claude Opus 4.7 | Best writing quality available. Requires Platinum plan or above. |

Higher tiers cost more mushies per response but produce better writing. If you're unsure, start with the default (Claude 3 Haiku) and experiment from there.

::: tip What changed recently
- **Claude 3 Haiku** is now the default model (replacing Grok 4.1 Fast, which was retired).
- **DeepSeek V4 Flash** added at the budget tier with updated pricing.
- The model picker shows colored cost-tier dots (emerald = Budget, blue = Standard, purple = Premium, amber = Ultra) so you can scan the lineup at a glance.
:::

### Pinned models

You can **pin up to 8 models** for quick access in the model picker. Four are pinned by default. Go to **Settings > AI Configuration > Your Models** to manage pins. Click any pinned model to set it as your default.

### Recently used

Models you've used recently appear below your pinned list (if they aren't already pinned). You can pin them from there.

## Context size

**What it is:** How much conversation history the AI can "see" when generating a response, measured in tokens. More context means the AI remembers more of what happened earlier in your session.

**Plan caps:** 64,000 tokens on Free, 96,000 tokens on Gold, uncapped (up to the model's native max — typically 200k, up to ~2M for some models) on **Platinum** and above. BYOK is uncapped on every plan.

**Recommendation:** For most play, 42k–62k is the sweet spot -- enough context for the AI to maintain narrative consistency without unnecessary cost. Going above 96k rarely improves the experience unless you're in a very long session with complex state. The setting is in **Settings > AI Configuration > Context Size**.

## Creativity (temperature)

The **temperature** slider controls how random/creative the AI's responses are:

- **Lower (around 0.7):** More predictable, focused, consistent. Good for strategy games or worlds where precision matters.
- **Higher (1.1–1.2):** More creative, varied. Good for creative writing and exploration.
- **Default: 1.0** -- balanced for most use cases.

The slider in Settings runs from 0.5 to 1.5, but **both ends are extreme**: 1.3 is already quite high and by 1.5 the writing usually starts coming apart; below 0.7 the model gets visibly mechanical. Day-to-day tweaks live in 0.8–1.2 -- only push past 1.3 if you're deliberately chasing a "let loose" effect.

## Response length (max tokens)

Controls the maximum length of a single AI response. Default is 12,000 tokens. Increase for longer, more detailed responses; decrease for snappier, more concise ones. Range: 256 to 32,768.

## Reasoning effort

For models that support reasoning (Claude, GPT-5), this controls how much "thinking" the AI does before responding:

| Level | Effect |
|-------|--------|
| **Minimal** | Least thinking, fastest responses, lowest cost |
| **Low** | Light reasoning (default) |
| **Medium** | More careful responses |
| **High** | Most thorough, slowest, highest cost |

For most roleplay and interactive fiction, Low is fine. Bump it up if the AI is making logical errors or forgetting constraints.

## Streaming

When **on** (default), AI responses appear token by token as they're generated. When **off**, the full response appears at once after generation completes. Keep this on unless your connection is unstable.

## Advanced sampling parameters

Under the **Advanced Parameters** toggle in AI Configuration:

| Parameter | Default | What it does |
|-----------|---------|-------------|
| **Top P** | 1.0 | Nucleus sampling -- limits the candidate pool to the top P% of likely tokens. Lower = more focused. |
| **Frequency Penalty** | 0.0 | Reduces word repetition. Try 0.3-0.5 if the AI keeps repeating itself. |
| **Presence Penalty** | 0.0 | Encourages new topics. Try 0.2-0.3 if the AI keeps circling the same ideas. |
| **Top K** | 0 (off) | Hard limit on candidate tokens. Usually not needed alongside Top P. |
| **Min P** | 0 (off) | Minimum probability threshold. Smarter alternative to Top K. |

**Rule of thumb:** Adjust temperature first. Only touch these if temperature alone doesn't solve your problem, and change one at a time.

## Bring Your Own Key (BYOK)

You can use your own API key instead of Yumina credits. Go to **Settings > AI Configuration** and switch to **Private Key** mode.

**Supported providers:**

| Provider | Where to get a key |
|----------|-------------------|
| **OpenRouter** | [openrouter.ai/keys](https://openrouter.ai/keys) -- one key unlocks hundreds of models |
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com) |
| **OpenAI** | [platform.openai.com](https://platform.openai.com) |
| **Google** | [aistudio.google.dev](https://aistudio.google.dev) |
| **Ollama** | [ollama.com](https://ollama.com) -- run models locally |
| **Custom (OpenAI-compatible)** | Paste any OpenAI-compatible base URL — DeepSeek, xAI (Grok), Mistral, Groq, Together, Fireworks, Moonshot, your own proxy. One-click presets cover the common ones. |

**Setup:**
1. Switch the provider toggle from Yumina API to Private Key
2. Select your provider and enter your key
3. Click verify to test the key

Your key is encrypted at rest (AES-256-GCM). The raw key is never returned from the server after storage -- only metadata (provider, label, masked suffix).

With BYOK, you have no context size cap and access to whatever models your provider offers. Costs go directly to your API provider instead of Yumina credits.

When you open a private model picker, Yumina shows your saved list and refreshes it in the background when its five-minute cache expires. Failed or empty provider responses keep the saved list; manually added models and your default model are preserved. Older saved entries without a recorded source are also kept. Use the connection's **Connect** action to force a refresh. If the provider changes a model ID, select the new model; if it changes its API base URL, update the connection address yourself.

## Custom prompts

An advanced feature for tuning AI behavior across all worlds. Found in **Settings > AI Configuration** at the bottom.

You can inject your own prompts at three positions:
- **System** -- into the system prompt (strongest effect)
- **In-Chat** -- into the middle of the chat history
- **Final** -- at the very end, right before the AI responds

Use this if the AI consistently misbehaves in a specific way (always forgetting a rule, always responding in the wrong language, etc.). Most players won't need this.

## Prompt presets

Every world's creator sets up default prompt presets. You can choose:
- **Use Creator's** -- use what the creator intended (recommended)
- **Use My Own** -- override with your own configuration

Unless you understand the prompt architecture, leave this on Creator's. Changing presets can break worlds in subtle ways.

</div>

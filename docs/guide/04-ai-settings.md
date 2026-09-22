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

## Story memory, and what the AI actually sees

Before we get to the setting, we want to briefly explain what the AI actually sees and remembers, because the number makes a lot more sense once you know this. Here is a very basic example of what the AI sees each time you send a message.

```
// ——  World setup ——
[lore 1: AI Instruction]
You're the narrator of this survival horror game. Cold and
restrained in tone, you never decide the player's actions for them.

[lore 2: World Settings]
The long-abandoned Matsuzaki Sanatorium, sealed off in the winter of 1987.

// —— Conversation history ——
[user]
I push the door open

[assistant]
A hand grabs your wrist — the skin unnaturally cold...

[user]
I drink the potion
```

The world setup, or the lorebook, is what the author decides. It's where authors define the world and the general instructions for the AI, and it's a fixed amount. The conversation history is the part that gradually builds up as you talk. Every time you send a request, the AI basically looks at the lorebook and your conversation history again, from the top. It has no memory between turns, so it is re-reading all of it every single time.

Now, what AI providers do is charge more as your input tokens rise, meaning the more conversation history you have, the more they charge. That is why you can see the mushie cost per round going up the longer you play. It isn't a fee for playing longer, there is just more text to read.

Ideally you would want the AI to see everything that happened in the past plus the full lorebook every turn, so it doesn't forget anything. Yet in the real world, between the cost and the model's own context limit, this can never infinitely build up. That is why we have this config in your settings and on your profile page. Basically, what it does is limit the maximum amount that gets sent, while always keeping the full lorebook. The world the author built never gets cut.

This does mean that as your conversation progresses, the AI will gradually forget what you talked about at the really really start. The good news is that most of the time, as the story goes on, the AI doesn't actually need that much from the very beginning to keep writing a good story, because it still remembers everything you did recently. However, sometimes this can still hurt quality and be annoying, and that is why we have **Session Memory & Story Summary**. It summarizes the earlier conversation instead of discarding it completely, so you lose the exact wording but not the events.

Now, what is an actual good setup? Some of you might think that if you have the budget you can just keep it as high as possible, however, this is wrong. When your conversation history gets too long it can actually distract the AI from the things it really needs to pay attention to, like the lorebook or your most recent messages. This is even more of a problem on smaller models. So we actually recommend everyone, no matter your budget, to lower it.

What you set is the **story memory**, the part of your conversation kept word for word, and we recommend anything from 12,000 to 24,000 alongside the memory plugin. Our default is 16,000. For a typical world, which is around 7,500 tokens on our side, that gives you roughly 7,500 + 15,000, so about 22,500 per turn, and 15,000 of that is pure story. For larger worlds the total goes up because the lorebook half is bigger, but your story memory stays exactly where you set it. That is the whole reason we split this into two numbers, one for the world that your plan carries, and one for the story that is yours.

On plan caps, the lorebook side is capped at 64,000 tokens on Free and 96,000 on Gold. Platinum and above is never trimmed, and if you bring your own key there is no cap on any plan.

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

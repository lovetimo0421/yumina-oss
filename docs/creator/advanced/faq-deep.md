<div v-pre>

# FAQ

> Answers to the most common questions you'll run into while creating.

---

## Getting started

### Q: Do I need to know how to code?

No. Most creators use the visual editor and Studio AI to build everything. Custom UI is the only feature that involves code, and Studio AI can generate that for you too.

### Q: What's the minimum I need to create a world?

Three steps: 1) click **Create** to make a new world; 2) in **Lorebook**, create a `character` entry with the character's profile and turn on **Always Send**; 3) in **First Message**, write an opening line. Click **Save** and you're ready to chat. Variables, rules, and custom UI are all optional.

### Q: How long does it take to build a world?

A simple character with a few variables takes 10-15 minutes with Studio AI. A complex world with custom UI, audio, and detailed mechanics can take a few hours to a few days.

### Q: Which AI models does Yumina support?

Out of the box Yumina ships a curated lineup across four cost tiers:

- **Budget** — default is **Claude 3 Haiku** (~5 mushies / message). Also DeepSeek V4 Flash, V3.2, Gemini 2.5 Flash Lite, Yumina Free.
- **Standard** — Gemini 3 Flash, DeepSeek V4 Pro, etc.
- **Premium** (Gold plan+) — Claude Haiku 4.5, Grok 4.20, Gemini 3.1 Pro.
- **Ultra** (Platinum+) — Claude Sonnet 4.6, Claude Opus 4.7.

The model is chosen by the player at play time — see the [Player Guide: AI Settings](/guide/04-ai-settings) for the full list and selection notes.

You can also bring your own key (Settings → AI Configuration → Private Key) for **Anthropic, OpenAI, Google, OpenRouter, Ollama**, or any OpenAI-compatible endpoint — one-click presets for DeepSeek, xAI (Grok), Mistral, Groq, Together, Fireworks, Moonshot. BYOK uncaps the context size and bills directly to your provider instead of mushies.

### Q: Where is my world data stored?

Your world data is saved on Yumina's server. You can export a world JSON file from the **Overview** section of the editor as a local backup anytime.

---

## Entries & Lorebook

### Q: I have too many entries. How do I organize them?

Use folders. The editor supports creating folders to group entries by logic — by character, by scene, by function. Folders are purely an organizational tool and don't affect runtime behavior. Also make good use of the `tags` field for filtering and searching. See the "Folder organization" section in [Entries & Lorebook](./entries-deep).

### Q: Keyword triggering isn't working. How do I debug?

Check these common causes: 1) verify the entry's `enabled` is `true`; 2) check that `lorebookScanDepth` is large enough — the default only scans the last 2 messages, so keywords in earlier messages won't be found; 3) if you're using secondary keywords (`secondaryKeywords`), make sure the logic is set correctly; 4) if `matchWholeWords` is on, note that Chinese text generally doesn't need whole-word matching. See the "Keyword matching" section in [Entries & Lorebook](./entries-deep).

### Q: What's the difference between alwaysSend entries and keyword-triggered ones?

`alwaysSend: true` entries are included in every prompt no matter what the player says — good for core character profiles and foundational world rules that need to be in effect at all times. Keyword-triggered entries only activate when matching words appear in recent messages — good for specific scenes, locations, NPCs, and other on-demand content. The fundamental difference is "always-on" vs. "on-demand." Using both strategically can save a huge amount of token budget. See [Entries & Lorebook](./entries-deep).

### Q: How do I write effective example dialogue?

Use `<START>` to separate different dialogue segments, and `{{user}}:` and `{{char}}:` to mark speakers. Each example should demonstrate the character's unique speech style, tone, and reactions — not just information exchange. Two or three high-quality examples are worth far more than ten mediocre ones. Set the entry's role to `example` and section to `examples`. See the "Example dialogue format" section in [Entries & Lorebook](./entries-deep).

---

## Variables & Directives

### Q: The AI isn't writing directives in the right format. What do I do?

The engine already automatically tells the AI the directive format, so the problem usually isn't "the AI doesn't know the format" — it's "the AI isn't sure when to use it." A few fixes: 1) make the trigger conditions in `behaviorRules` more specific — "subtract when the player takes damage; deduct 10–30 per hit" is better than "subtract when hurt"; 2) add a reminder entry in the `post-history` section telling the AI not to forget to output directives; 3) lower `temperature` (e.g., 0.5–0.7) to make the AI follow rules more reliably; 4) different models vary significantly in directive compliance — switching models is also worth trying. See [AI Directives & Macros](./directives-macros).

### Q: A variable suddenly has a weird value. How do I debug?

First look at what directives the AI wrote in its raw reply — sometimes the AI writes operations you didn't anticipate. Then check if any rules are quietly modifying this variable in the background (via `modify-variable` actions). For number variables, confirm you've set reasonable `min` and `max` values — the engine auto-clamps out-of-range values. If you still can't find it, check every rule and entry in the editor that references this variable.

### Q: How do I use JSON-type variables?

JSON variables can store complex data structures — objects, arrays, nested structures. The most common uses are inventory (JSON array) and character relationship networks (JSON object). Operations include `merge` (merge object), `push` (append to array), `delete` (remove a key or element), and dot-notation for deep nested paths like `[relationships.aria.trust: +10]`. See the "Nested JSON paths" section in [Variables](./variables-deep).

### Q: How many variables can I have? Is there a limit?

No hard limit at the engine level. But every variable's current value is included in the prompt sent to the AI, so too many variables eat up token budget and shorten the conversation history the AI can "see." In practice, most worlds work fine with 5–20 variables. If you need to store a lot of data, consider packing related data into one JSON variable — more efficient than a pile of individual variables.

---

## Rules engine

### Q: A behavior isn't triggering. How do I debug?

Check these in order: 1) is the behavior enabled — was it disabled by another behavior? 2) is the WHEN trigger type correct — e.g., if you chose "variable crosses threshold" but the variable never crossed that threshold; 3) do all the ONLY IF conditions pass (check whether `conditionLogic` is `"all"` or `"any"`); 4) is it in cooldown (`cooldownTurns`); 5) has it reached max fire count (`maxFireCount`). See the "Evaluation flow" section in [Rules Engine](./rules-deep).

### Q: When multiple behaviors trigger at once, what order do they execute in?

Sorted by `priority` from highest to lowest. Behaviors with higher numbers are evaluated and executed first. For example, a "death check" behavior at priority 100 runs before a "low health warning" at priority 50. If two behaviors have the same priority, they execute in their definition order. Give important behaviors higher priority values. See the "Priority" section in [Rules Engine](./rules-deep).

### Q: Can behaviors control each other?

Yes — this is one of the most powerful features of the rules engine. The "enable/disable behavior" action can turn other behaviors on or off. Typical pattern: Behavior A listens for a "enter dungeon" keyword and, when triggered, enables Behavior B (a monster encounter rule that starts disabled). When the player leaves the dungeon, Behavior A disables B again. You can build "dormant until activated" behavior chains. See the "Rule cross-control" section in [Rules Engine](./rules-deep).

### Q: How do cooldownTurns and maxFireCount work together?

`cooldownTurns` controls the interval — after a behavior fires, it waits this many turns before it can fire again. Good for "shouldn't trigger too often" scenarios, like reminding about hunger no more than once every 5 turns. `maxFireCount` controls the total — a behavior can fire at most this many times ever, then never again. Good for one-time events like tutorial hints. Both can be used simultaneously: a "hidden plot hint" behavior set to `cooldownTurns: 10` + `maxFireCount: 3` means it hints at most 3 times, with at least 10 turns between hints.

---

## Components & Rendering

### Q: I can't code TSX. Can I still build custom UI?

You can try. A few starting points: 1) use **Enter Studio** in the editor, and have the AI Assistant generate code for you; 2) describe your desired effect to an external AI (like Claude) and have it generate the TSX code, then paste it into the editor; 3) copy-paste from the template examples in the docs and adjust colors and text. The editor compiles in real time and shows errors at the bottom (**Compile Status**), so you can adjust as you go. See [Custom UI Guide](./custom-ui-deep).

### Q: What's the Root Component? Do I need one?

The Root Component is the entry point for your world's UI — a file called `index.tsx` under the **Custom UI** section in the editor. It's optional: if you don't define one, the engine uses the default (`return <Chat />`), which gives you the standard chat experience. You define a Root Component when you want to customize anything visual — custom message bubbles (pass `renderBubble` to `<Chat />`), side panels (compose `<Chat />` with your own divs), or a fully custom layout (use `<MessageList />` and `<MessageInput />` directly). See [Custom UI Guide](./custom-ui-deep).

### Q: Where do built-in components (stat-bar, inventory, etc.) display?

Built-in components (stat-bar, text-display, image-panel, inventory-grid, etc.) display in a header bar above the chat window. Component order is controlled by the `order` field — lower numbers appear first. If you need something more flexible — a sidebar, full-screen layout, or a different header entirely — build it in the **Root Component** instead, where you have full control via TSX. See [Custom UI Guide](./custom-ui-deep).

### Q: My old world has a "Message Renderer." Do I need to change it?

No — legacy worlds keep working. On import, the engine auto-migrates the old `messageRenderer` field into your Root Component and the editor shows a **Legacy** badge. The old `customUI[]` array with `surface: "message" | "app"` components also still works. When you're ready to modernize, move the renderer code into `index.tsx` under **Custom UI** and pass it as `<Chat renderBubble={...} />`. See [Custom UI Guide](./custom-ui-deep).

---

## Publishing & sharing

### Q: Can I still make changes after publishing?

Yes. After publishing, you can go back to the editor and modify world content at any time — saving takes effect immediately and new players see the latest version. To temporarily take it down, change status to `unpublished` and active players will see a read-only notice. Note: if you modify variable definitions (like deleting a variable), the engine automatically handles backward compatibility for existing players' saves — new variables get filled with default values, deleted ones are filtered out. Nothing breaks for existing players. See [Publishing, Exporting & Bundles](./publishing-deep).

### Q: How do I get more players to discover my world?

Key points: 1) upload an attractive thumbnail — worlds without covers almost never get clicked in Hub; 2) write a compelling description explaining what the world is and what makes it fun; 3) add 3–5 relevant tags — think about what players would search for; 4) write a great opening message (greeting) — first impressions determine whether players keep playing; 5) play through it yourself before publishing to make sure the experience is smooth. See the "Pre-publish checklist" in [Publishing, Exporting & Bundles](./publishing-deep).

### Q: What's the difference between a Bundle and a full world export?

A full world export is the complete `WorldDefinition` JSON — every entry, variable, rule, component, and setting, nothing left out. Good for backups or sharing an entire world with someone. A Bundle is a "component pack" — you cherry-pick a subset of content (like a combat rules system + related variables + components) and package it. Others can install this package into their own worlds. Simply: a full export is "the whole car"; a Bundle is "the engine assembly." See the "Bundle system" section in [Publishing, Exporting & Bundles](./publishing-deep).

---

## Earnings & Tips

### Q: How much does Yumina take from a money tip?

**20%** of the gross, then Stripe deducts its own processing on top. A $10 tip looks like: Yumina takes $2, Stripe takes about $0.59 (2.9% + $0.30), you net ~$7.41. The exact split shows up in your [Earnings Dashboard](/creator/earnings) for every transaction.

For **mushie gifts the platform fee is 0%** — the full amount lands in your wallet instantly. Mushies don't cash out to money, though; they're spendable on your own AI usage.

### Q: Why is there a 7-day hold on tips?

Stripe gives players 7 days to dispute or refund a card transaction. We park each tip in "pending" during that window so we're not paying out money that could be clawed back. After 7 days it moves to "available" and counts toward the $10 minimum payout. Mushie gifts are never held.

### Q: What's the minimum payout?

**$10** of available balance. Once you cross that, Stripe pays out on its normal schedule (usually 2–7 business days depending on country and bank). Anything below $10 just keeps accruing — there's no fee for letting it sit.

### Q: I'm not in the US. How do I get paid? Do I owe US taxes?

Stripe Connect Express supports creators in 40+ countries. During onboarding it'll ask you to complete an IRS **W-8BEN** (individual) or **W-8BEN-E** (entity). This isn't you paying US tax — it's certifying you're a foreign creator so the US doesn't withhold the default 30%. With a valid W-8 most non-US creators have 0% US withholding under their country's tax treaty. You're still responsible for income tax in your own country. Yumina doesn't see or touch the W-8; it goes directly into Stripe.

### Q: Can I tip myself or use an alt to inflate earnings?

No. The Support button doesn't render on your own worlds at all, and we run periodic checks on patterns that look like wash-tipping (same payment method, repeated round amounts, brand-new accounts only tipping one creator, etc.). Confirmed manipulation = earnings frozen and creator status revoked, per the [Terms of Use](/legal/terms-of-use). Real edge cases (e.g., a family member using their own money) are fine — the patterns above are about deliberate fraud, not honest support.

### Q: A supporter refunded their tip. What happens to my earnings?

If the refund happens during the 7-day hold (most cases), the pending amount just disappears — you never had access to it, so nothing to claw back. If somehow the funds already cleared and you've cashed out, Stripe pulls the disputed amount from future earnings (or from your linked bank if you have no buffer), and Yumina passes through Stripe's chargeback fee. You'll see it as a negative adjustment in earnings history.

### Q: Can I see who supported each of my worlds?

Yes. Each world's public page has a Supporters list (named tippers only — anonymous ones are counted in totals but not listed). Your dashboard's **Recent Support** feed shows the same data per-world plus the messages supporters left, and a **Top Supporters** column for cumulative supporters across all your worlds. Anonymous tips show up as "Anonymous" — you get the amount and message, just not the identity.

### Q: I unpublished a world. Do I keep the tips I earned from it?

Yes. Tips and mushie gifts are tied to your creator account, not the world. Unpublishing or even deleting a world doesn't reverse past earnings. Anyone who tipped you while it was up has already paid, and that's settled.

</div>

<div v-pre>

# FAQ

> Common questions from creators.

---

## Getting started

### Q: Do I need to know how to code?

No. Most creators build everything on the canvas, with help from the Creation assistant. The player interface can be built from templates without code. Hand-written interface code and code behaviors are the only features that involve code, and the Creation assistant can write those for you too.

### Q: What's the minimum I need to create a world?

Three steps: 1) click **Create**, choose **Blank Project** and pick **Canvas**; 2) write the character's profile in **Character and world** (sent to the AI every turn); 3) write an opening in **Greeting**. Click **Save** and you can play. Variables, behaviors and a custom interface are all optional. See [Canvas basics](/creator/canvas).

### Q: How long does it take to build a world?

A simple character with a few variables takes 10-15 minutes with the Creation assistant. A complex world with custom UI, audio, and detailed mechanics can take a few hours to a few days.

### Q: Which AI models does Yumina support?

Yumina offers a curated lineup in four cost tiers: Budget, Standard, Premium and Ultra. Premium and Ultra models need a higher plan. The lineup changes often; see the [Player Guide: AI Settings](/guide/04-ai-settings).

The model is chosen by the player at play time. In an AI's settings you can give that AI its own model; if the player can't use it, it falls back to the player's choice. See [AIs](/creator/ais#model).

Players can also bring their own key (Settings → AI Configuration → Private API Key) for **Anthropic, OpenAI, Google, OpenRouter, Ollama**, or any OpenAI-compatible endpoint — one-click presets for DeepSeek, xAI (Grok), Mistral, Groq, Together, Fireworks, Moonshot. BYOK uncaps the context size and bills directly to the provider instead of mushies. You can turn this off for your card under **Custom API Keys** in the publish dialog.

### Q: Where is my world data stored?

Your world data is saved on Yumina's server. You can download a world JSON file as a local backup anytime: **My Library → My Projects**, select the card, **Download**.

---

## Entries & Lorebook

### Q: I have too many entries. How do I organize them?

Use folders. **Panels → Lorebook** lets you create folders to group entries by logic — by character, by scene, by function. Folders are purely an organizational tool and don't affect runtime behavior. Tags help with filtering and searching too. If whole groups of lore only apply in one place or chapter, they may belong in a [scenario](/creator/modules). See [Folder organization](./entries-deep#folder-organization).

### Q: Keyword triggering isn't working. How do I debug?

Check these common causes: 1) the entry isn't disabled, isn't dragged off the card (**Not in play**), and its scenario is open; 2) **Keyword scan depth** (Context → Advanced) is large enough — the default only scans the last 2 messages, so keywords in earlier messages won't be found; 3) if you're using **Secondary Keywords**, make sure the logic is set correctly; 4) if **Whole Word** is on, note that Chinese and Japanese text generally doesn't need it. In a [playtest](/creator/playtest), **This turn → What the AI got** ends with **Not sent this time**, which lists the entries that weren't sent. See [Designing good keyword lists](./entries-deep#designing-good-keyword-lists).

### Q: What's the difference between always-sent entries and keyword-triggered ones?

Entries with **Always Send** on (the **Character and world** block) are included in every prompt no matter what the player says — good for core character profiles and foundational world rules. Keyword lore only goes out when matching words appear in recent messages — good for specific scenes, locations, NPCs, and other on-demand content. Using both well saves a lot of token budget. See [Writing Great Entries](./entries-deep).

### Q: How do I write effective example dialogue?

Use `<START>` to separate different dialogue segments, and `{{user}}:` and `{{char}}:` to mark speakers. Each example should demonstrate the character's unique speech style, tone, and reactions — not just information exchange. Two or three high-quality examples are worth far more than ten mediocre ones. Set the entry's **Inject into** to **Example dialogue**. See [Example dialogue](./entries-deep#example-dialogue).

---

## Variables & Directives

### Q: The AI isn't changing a variable properly. What do I do?

The engine already tells the AI the directive format, so the problem usually isn't "the AI doesn't know the format" — it's "the AI isn't sure when to use it." A few fixes: 1) turn on **Precise tracking** for the variable if its type allows it, so a dedicated helper decides the change after every reply instead of the story AI; 2) make the **Behavior Rules** more specific — "subtract when the player takes damage; deduct 10–30 per hit" is better than "subtract when hurt"; 3) add an **At the end** entry reminding the AI to write directives; 4) lower the temperature (e.g., 0.5–0.7) to make the AI follow rules more reliably; 5) models vary a lot in directive compliance, so switching models is also worth trying. See [AI Directives & Macros](./directives-macros).

### Q: A variable suddenly has a weird value. How do I debug?

Play a turn in a [playtest](/creator/playtest) and look at **This turn → Each value**: it says whether the AI, Precise tracking, a behavior, a button or a formula changed the value, or why a change was blocked. Then check whether any behaviors change this variable (**Change variable** effects). For number variables, confirm you've set a sensible **Range** — the engine clamps out-of-range values.

### Q: How do I use JSON-type variables?

On the canvas this type is called **List / table**. It stores complex data — objects, arrays, nested structures. The most common uses are inventory (JSON array) and character relationship networks (JSON object). Operations include `merge` (merge object), `push` (append to array), `delete` (remove a key or element), and dot-notation for deep nested paths like `[relationships.aria.trust: +10]`. See [Nested paths for JSON variables](./directives-macros#nested-paths-for-json-variables).

### Q: How many variables can I have? Is there a limit?

No hard limit at the engine level. But by default every variable the AI can see is included in the prompt each turn, so too many variables eat up token budget. **Variables shown to the AI** (Context → Advanced) can be set to **Only changed** or **None**, and variables set to **Engine only** cost the AI nothing. In practice, most worlds work fine with 5–20 variables. If you need to store a lot of data, consider packing related data into one List / table variable.

---

## Behaviors

### Q: A behavior isn't triggering. How do I debug?

Start a [playtest](/creator/playtest): **This turn → Each behavior** says whether each one fired, and if not, what's missing (how far a value is from the threshold, cooling down, used up, its scenario isn't open). Otherwise, check these in order: 1) is the behavior enabled — was it disabled by another behavior? 2) is **When it fires** right — e.g., you chose **Variable crosses threshold** but the variable never crossed that value; 3) do the **ONLY IF** conditions pass (check whether all or any must hold), and is a **STOP WHEN** condition holding; 4) is it in its cooldown; 5) has it reached **Max fires**; 6) is **Chance to fire** below 100. See [How the engine processes behaviors](./rules-deep#how-the-engine-processes-behaviors).

### Q: When multiple behaviors trigger at once, what order do they execute in?

Sorted by **Priority** from highest to lowest. For example, a "death check" behavior at priority 100 runs before a "low health warning" at priority 50. If two behaviors have the same priority, they run in the order they're listed in the card. Give important behaviors higher priority values. See [Priority](./rules-deep#priority).

### Q: Can behaviors control each other?

Yes. The **Enable/disable behavior** effect turns other behaviors on or off. Typical pattern: Behavior A listens for an "enter dungeon" keyword and, when triggered, enables Behavior B (a monster encounter behavior whose **Enabled** switch starts off). When the player leaves the dungeon, Behavior A disables B again. See [Dungeon activation chains](./rules-deep#dungeon-activation-chains).

### Q: How do cooldown and max fires work together?

**Cooldown** controls the interval — after a behavior fires, it waits this many turns before it can fire again. Good for "shouldn't trigger too often" cases, like reminding about hunger no more than once every 5 turns. **Max fires** controls the total — a behavior can fire at most this many times ever, then never again. Good for one-time events like tutorial hints. Both can be used together: a "hidden plot hint" behavior with cooldown 10 and max fires 3 hints at most 3 times, with at least 10 turns between hints.

---

## Interface

### Q: I can't code TSX. Can I still build custom UI?

Yes. A few starting points: 1) the [Player interface](/creator/player-view) editor builds opening pages, status panels, inventories and maps from templates, no code needed; 2) ask the Creation assistant to write interface code for you; 3) describe your desired effect to an external AI (like Claude) and have it write the TSX code, or connect it with **Connect your AI** so it edits the card directly; 4) copy-paste from the template examples in the docs and adjust colors and text. **Panels → Front End Code** shows **OK** when the code compiles, or **Error** with the message. See [Custom UI Guide](./custom-ui-deep).

### Q: What's the Root Component? Do I need one?

The Root Component is the entry point for your world's interface code — a file called `index.tsx` in **Panels → Front End Code**. It's optional: if you don't define one, the engine uses the default (`return <Chat />`), which gives you the standard chat experience. You write a Root Component when you want to customize anything visual in code — custom message bubbles (pass `renderBubble` to `<Chat />`), side panels (compose `<Chat />` with your own divs), or a fully custom layout (use `<MessageList />` and `<MessageInput />` directly). See [Custom UI Guide](./custom-ui-deep).

### Q: My old world has a "Message Renderer." Do I need to change it?

No — legacy worlds keep working. On import, the engine auto-migrates the old `messageRenderer` field into your Root Component and the editor shows a **Legacy** badge. The old `customUI[]` array with `surface: "message" | "app"` components also still works. When you're ready to modernize, move the renderer code into `index.tsx` in **Panels → Front End Code** and pass it as `<Chat renderBubble={...} />`. See [Custom UI Guide](./custom-ui-deep).

---

## Publishing & sharing

### Q: Can I still make changes after publishing?

Yes. Keep editing as usual. Saved changes become **Unpublished changes**; players still see the live version until you submit the update from the publish menu and it passes review. Players who already started a game keep the version they started with. To take the world down, unpublish it from the publish menu; players with existing sessions then see it as "No longer available." If you change variable definitions (like deleting a variable), existing saves are handled automatically — new variables get their starting values, deleted ones are filtered out. See [Publishing](/creator/publishing#updating-a-published-world).

### Q: How do I get more players to discover my world?

Key points: 1) upload an attractive cover — worlds without covers almost never get clicked; 2) write a compelling description explaining what the world is and what makes it fun; 3) add relevant tags — think about what players would search for; 4) write a great opening — first impressions decide whether players keep playing; 5) play through it yourself before publishing to make sure the experience is smooth. See the "Pre-publish checklist" in [Publishing, Exporting & Bundles](./publishing-deep#example-1-pre-publish-checklist).

### Q: What's the difference between a Bundle and a full world export?

A full world export is the complete `WorldDefinition` JSON — every entry, variable, behavior, interface file, and setting. Good for backups or sharing an entire world with someone. A Bundle is a subset you pick (like a combat system's behaviors + related variables + its interface) that others can install into their own worlds. See [Bundle system](./publishing-deep#bundle-system).

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

Yes. Tips and mushie gifts are tied to your creator account, not the world. Unpublishing or even deleting a world doesn't reverse past earnings. Anyone who tipped you while it was up has already paid.

</div>

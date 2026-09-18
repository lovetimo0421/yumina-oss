<div v-pre>

# FAQ

> The questions players actually ask. If yours isn't here, email [support@yumina.io](mailto:support@yumina.io) — real reply, usually within a day.

---

## Getting started

### Q: I just signed up. Where do I start?

Open the Hub (the bookshelf icon in the sidebar), pick a world from the **Trending** or **For You** tabs, and click **Play**. The first session asks which AI model to use — leave it on the default (Claude 3 Haiku) for now. You can swap models any time from the picker above the chat input.

If you'd rather make something than play, click **Create** to open the Studio. [What is Yumina](./01-what-is-yumina) has a longer tour.

### Q: How much can I do without paying?

A lot. Free gives you **2,000 mushies / month** during the launch 2× promo (normally 1,000), plus a **100-mushie daily floor** that tops your balance back up to 100 each day. With the default Claude 3 Haiku that's ~400 messages a month plus the daily floor — enough to play through most worlds at a relaxed pace.

If you're burning through it faster than expected, it's almost always because (a) you switched to a premium model, or (b) the context window is set way above the default. See "How much does a message cost?" below.

### Q: How do I find a world I'll actually like?

A few tricks:

1. **Tags** filter — genre (romance, horror, survival), tone (comedy, serious), mechanic (combat, dating, mystery).
2. **Filters panel** on the right of the Hub — language, content mode, sort by trending / new / most played.
3. **Library Detail panel** — read the description, check ratings, see the creator's other work before committing.
4. **Follow** creators whose stuff lands — their new worlds show up in your Following tab.

---

## When the AI gets weird

### Q: The AI is forgetting things that happened earlier in the chat

Most common cause: **the context window is full**. After a long session the AI can only "see" the most recent N thousand tokens — anything older is genuinely gone.

Three things to try:

1. **Settings → AI Configuration → Context Size**. Default 64k on Free, 96k on Gold, uncapped on Platinum+.
2. Worlds with heavy variables, lorebooks, and rules eat a lot of the context with system prompt before chat history even starts. Worlds with elaborate custom UI / inventory systems are heaviest.
3. **Branch** the session — keep the healthy early part, restart from a clear point. Usually works better than fighting a confused session.
4. Install the **Session Memory & Story Summary (Beta)** extension — it keeps notes for the AI (key facts plus a rolling recap of older chat) so long sessions hold together. Note its background updates cost a little by default; the Memory panel in chat can switch it to the free model.

### Q: The AI keeps going out of character

Different problem from "forgetting." If the AI is playing the character with the wrong voice, wrong personality, wrong vibe — that's **model quality**, not context.

- Bump a tier. Default Claude 3 Haiku → Claude Haiku 4.5 (Gold+) is the most common upgrade. Sonnet 4.6 / Opus 4.7 (Platinum+) gets noticeably better still.
- Drop the **Creativity (temperature)** slider in AI Configuration from the default 1.0 to 0.8–0.9. Adds stability at the cost of slight predictability.
- Make sure the world's creator is using a sane prompt preset — under chat options, **Use Creator's** is usually right. If they configured it poorly, **Use My Own** lets you override.

### Q: My message has been loading forever and nothing comes back

Common causes:

- Your context is huge and the provider is just slow. Wait up to 60 seconds before assuming it's stuck.
- The AI provider is having a temporary outage — switch to a different model and try again (e.g., default Haiku → DeepSeek V4 Pro).
- Network on your end. The chat reconnects automatically when you regain network.

If a generation **completes with no visible content** (rare, but it happens with some models on certain prompts), we don't deduct mushies for it — you can retry for free.

### Q: How do I make the AI write longer / shorter replies?

**Settings → AI Configuration → Response Length** — default 12,000 tokens. Increase for longer scenes; drop to ~2,000 for snappier exchanges. Range 256–32,768.

That's a *ceiling*, not a target. To actually push longer output, also tell the AI in chat ("write a long, detailed scene") or check whether the world's creator configured prompts to encourage long replies.

### Q: How do I switch models mid-chat?

Click the model name above the chat input. The picker shows your pinned models and recently used ones. Switching mid-session is fine — the next response uses the new model. Past responses don't change.

**If there's no model name above the chat input:** some worlds ship a fully custom interface built by their creator, and the creator decides what controls appear — a few don't include a model picker. That's not a bug and not a missing setting on your side. Move your cursor to the top edge of the screen (tap the top edge on mobile) — the play-controls bar that slides out has a **Model** button that works in every world.

---

## Mushies (the currency)

### Q: What does a single message actually cost?

Depends on the model and how much context comes along for the ride:

| Tier | Example | Avg per message |
|---|---|---|
| Budget | Claude 3 Haiku (default) | ~5 mushies |
| Standard | Gemini 3 Flash | ~10–15 |
| Premium | Claude Haiku 4.5 / Grok 4.20 | ~40–65 |
| Ultra | Claude Sonnet 4.6 / Opus 4.7 | ~155–245 |

These are averages. If you're 50k tokens deep into a session, the AI re-reads all of that every turn, so cost climbs roughly linearly with context size. Capping context at 42k–62k in AI Configuration is the sweet spot for most play.

### Q: My free mushies are about to run out — what happens?

The **daily refresh** floors your balance at a per-plan amount (100 Free, 400 Gold, 1,600 Platinum, etc.), so you can't quite go to zero. But you can stall mid-session if your balance drops below the cost of one more message before the next daily refresh kicks in.

Options:

1. Wait until tomorrow for the daily refresh.
2. Switch to a cheaper model — Claude 3 Haiku at ~5 mushies/message goes a long way.
3. One-time mushie pack — Settings → Plans. The launch 2× promo doubles the amount you get.
4. Upgrade your plan if this happens often.
5. **BYOK** — bring your own API key and bypass mushies entirely (Settings → AI Configuration → Private Key).

### Q: My balance dropped a little on its own — what charged me?

If you installed the **Session Memory & Story Summary (Beta)** extension, its background note-taking is the usual answer. After your turns it quietly updates the AI's memory and story recap, and each update is its own small AI call — by default on Gemini 2.5 Flash Lite, usually well under 1 mushie per update. Every charge shows up as its own line in your transaction history ("Session memory update" / "Story summary compaction").

Don't want it to cost anything? Open the **Memory** panel in chat (button above the chat input, or the play-controls bar at the top edge of the screen in fully custom worlds) and switch its model to **Yumina Free**. The setting is per session.

One more thing that *looks* like a charge but isn't: balances are fractional. A 0.2-mushie update takes 2,200 to 2,199.8 — nothing was rounded up.

### Q: Do mushies expire?

Monthly plan credits roll over within reasonable limits — they don't reset to zero each cycle. One-time purchased mushie packs don't expire. Mushies you received as gifts from supporters don't expire.

### Q: Where do I buy mushies?

Settings → Plans page. There's a top-up section for one-time mushie packs (currently 2× launch promo) and the subscription plans. Both via Stripe.

---

## Sessions, branches, and saves

### Q: I deleted a chat. Do I get the mushies back?

No. Mushies are spent on the AI's work, not on storing the resulting messages. Deleting just removes your copy of the history — the AI already generated and was paid for those responses.

### Q: What's the difference between branching and starting a new session?

- **New session** — totally fresh start. World resets to its first message, variables to their defaults. Nothing carries over.
- **Branch from a message** — forks at that exact point. The branched session shares history up to that message, then diverges. Good for "what if I had answered differently here" without losing the original timeline.

Both are unlimited. You can have a dozen branches of the same world running in parallel and switch between them from the session picker.

### Q: How do I export my chat?

Chat top-right menu → Export. You can grab the full transcript (JSON for re-import, or a readable format). You own your chat history; export it whenever.

### Q: Can I recover a session I deleted by accident?

No, deletion is immediate and irreversible. Active data is removed within 7 days and backups purged shortly after, per the [Privacy Policy](/legal/privacy-policy). If a chat matters to you, export it before deleting.

---

## Personas

### Q: What's a Persona?

A reusable character profile *you* play as — name, avatar, appearance, personality, backstory. When active, the AI knows who you are and reacts to that identity, not just your username. Same world plays very differently depending on which Persona you bring. See [Profile & Settings](./05-profile-and-settings) for the full breakdown.

### Q: I changed my active Persona. Will it apply to my ongoing chats?

Yes, for sessions without a persona lock. Profile settings and the world's session picker change the account-wide selection, and unlocked sessions use it for their next request. A session with **Lock persona for this session** enabled keeps its own choice until you unlock it. A response already generating keeps its starting identity.

You can keep playing the same chat. Existing messages, memories, game progress, and audio are preserved. Choosing **No persona** uses your account display name in new and unlocked sessions.

### Q: Do I have to create a Persona?

No. Without one, the AI uses your display name. Plenty of players never make one. Personas are for deeper immersion or for players who keep a consistent character identity across many worlds.

---

## Multiplayer rooms

### Q: How do I play with friends?

Find a world that supports multiplayer (detail panel has a green **ROOM** button), click it, pick an AI trigger mode, and you're the host. Copy the invite link from the right panel and share. Friends opening the link auto-join (after signing in if needed).

### Q: Who pays for the AI in a multiplayer room?

Whoever triggers the AI. So if you're the host but a friend sends the message that triggers a response, that message comes out of your friend's mushies, not yours. Keeps the host from going broke on a chatty group.

### Q: Free-speech vs. turn-based — which do I pick?

- **Free speech** — anyone can type any time; messages queue and the AI responds to them as a batch. Good for casual hanging out.
- **Turn-based** — only the current speaker can type; the host hands turns out. Better for structured stories where everyone gets a moment.

The host can switch modes mid-session.

---

## Content modes & safety

### Q: How do I enable Limitless content?

Two gates, both in **Settings**:

1. **Account eligibility** — your declared birth year must meet the requirement for Limitless mode. You set it during onboarding; changing it later requires emailing support.
2. **Content & Safety → Content Mode** — switch from **Limited** to **Limitless**.

Both must pass before Limitless worlds appear in search and Discover. If the account is not eligible, the Limitless option is unavailable.

### Q: I searched for a world I know exists and can't find it

Most often:

- The world is **Limitless** and your content mode is **Limited** (default). Change it in Settings → Content & Safety.
- The world is in a **language** your Hub filter is hiding. Open the Filters panel and clear language.
- The creator unpublished or renamed it. Check their profile — if unpublished it's gone from search, but if you'd already played it, your library copy still works.

### Q: How do I report a problematic world?

On the world's detail panel, click the **⋮** menu → **Report**. Pick a reason and add detail. We review all reports; the reporter's identity is never disclosed to the creator. For urgent issues (CSAM, real-world threats), email **support@yumina.io** with "URGENT" in the subject — those get prioritized.

---

## Tipping and supporting creators

### Q: How do I tip a creator?

The heart-icon **Support** button shows up in the chat header while playing, on the world preview modal, and on the creator's public profile. You can tip in real money (Stripe) or gift mushies. Full flow: [Supporting Creators](./06-supporting-creators).

### Q: If I tip anonymously, does the creator still see who I am?

No. Anonymous tips show as "Anonymous" in the creator's notifications and the public supporters list. They get your amount and any message you left, but not your name or avatar. The platform retains a record internally for fraud and refund handling — it's never exposed to the creator.

### Q: Can I refund a tip?

Money tips go through Stripe's normal dispute process — open one through your card issuer, or email support within 7 days. Mushie gifts are immediate and non-refundable once sent.

### Q: I bought mushies but want to gift them. Can I?

Yes. In the tip modal, switch to the **Mushies** tab — you can gift any of your mushies above your plan's daily floor to a creator. They get the full amount instantly, no fee.

---

## Account, privacy, and language

### Q: Can a world's creator see my chats?

No. Sessions are private to you. Creators see aggregate stats on their dashboard — play counts, unique players, average session length — but never your actual chat content or which choices you made.

### Q: How do I make my profile private?

**Settings → Privacy → Private Account**. With it on, only your followers see your published worlds, library, and recently played. Non-followers see a "private profile" placeholder.

You can also independently toggle:

- **Allow DMs** — closes your inbox to non-followers
- **Show recent play** — hides what you've been playing even on a public profile

### Q: Is my chat used to train AI?

No. We don't use your messages, world content, or any user content for AI model training. The third-party providers we route through (OpenRouter, Anthropic, OpenAI) operate under API terms that don't train on inputs. For the strictest privacy, use **Ollama** in BYOK mode — that runs entirely on your own device, nothing leaves the machine. See [Privacy](./07-privacy).

### Q: How do I delete my account?

Email **hello@yumina.io** from your account email. We process within 30 days. Self-serve deletion is on the roadmap. All your personal data and user content are removed within 7 days of confirmation; residual backups are purged shortly after.

### Q: How do I change the interface language?

**Settings → Display → Language**. English, Chinese (Simplified), Japanese, Korean. *World content* stays in whatever language the creator wrote it — switching UI language doesn't translate the AI's roleplay text.

---

## Billing and refunds

### Q: How do I cancel my subscription?

**Settings → Subscription → Cancel**. Cancellation takes effect at the end of the current billing cycle — you keep the plan benefits through the period you've already paid for, then revert to Free.

### Q: Can I get a refund?

Within **7 days of payment**, yes — provided you haven't used any paid features that cycle (no premium messages sent, no quota consumed). Email [support@yumina.io](mailto:support@yumina.io). After 7 days or once paid features are used, refunds are case-by-case at our discretion. See [Terms of Use §20](/legal/terms-of-use) for the legal version.

### Q: Auto-renewal charged me when I meant to cancel

If it's within 7 days of the charge AND you haven't used any paid features that cycle, email support@yumina.io for a full refund. We don't fight you on these — most are honest "forgot to cancel" cases.

---

Still stuck? [support@yumina.io](mailto:support@yumina.io). Real human reply, usually within a day.

Building worlds, not just playing? The [Creator FAQ](/creator/advanced/faq-deep) digs into making things.

</div>

# Modules

**A module is the lorebook you have always used.** The name changed because it
holds more than entries now.

It started as a set of entries you could switch on and off. Then it could hold
variables, then behaviours, then a screen of its own, and most recently an AI
and a memory of its own. At that point "book" stopped describing it. It is not
a book any more. It is a **place**.

So: **a module = some entries + variables + behaviours + a screen + an AI and
its memory.** Put only entries in it and it is still a book. Fill it and it is
a dungeon.

## The card is a module

You make a card, write an opening, a character, a setting. None of that sits
"outside the modules" — it is in the card's own module.

That is why the first row on the Modules page is always the card itself. There
is no such thing as "this card has no modules yet". There is only "this card
has one", which is all most cards ever need.

## A second module is a second place

Say you are making an expedition game: a town, and three dungeons.

```
Overworld · Ashcoast    setting · hero · travel rules · HP and death · Ashcoast · rumours
Dungeon A · Rustpit     setting · hero · travel rules · HP and death · Rustpit · corrosion
Dungeon B · Bone Snow   setting · hero · travel rules · HP and death · Bone Snow · body heat
Dungeon C · Mist Tower  setting · hero · travel rules · HP and death · Mist Tower · climbing
```

The first four are in every place. The last two belong to one each.

Those first four are **not four copies**. They belong to the card, and the
card's things reach every module — so the HP the player sees in all four places
is one variable, and editing "travel rules" anywhere edits it everywhere. The
classic editor's Modules page draws them dashed and marked *shared*; a module
tile on the blueprint shows only a *shared · N* count instead of drawing them
again. That is what the marking means.

That is the whole idea: **each one its own, all of them on one foundation.**

## When it opens

Each module decides for itself:

| Mode | Use it when |
|---|---|
| Always on | This is the card's foundation, true everywhere |
| Keywords | The player says "mine" and they are in it |
| Conditions | `location == "mine"` |
| By opening | Only exists in games that started from that opening |
| Manual | A behaviour switches it |

**By opening** deserves a line of its own: it lets one card hold several
different games. In a run started from opening A, a module bound to B does not
exist — not switched off, absent.

## Three new things: AI, memory, context

Everything above is what a book could always do. These three are new, and they
are why it is called a module.

Tick *this module runs the conversation itself* on the module page and it stops
being material and becomes a **station** — an AI of its own.

### Its own AI

It can run a different model from the card. The cold thing narrating the mine
and the chatty one in town can genuinely be two models.

Leave it off and the module just hands its entries and variables to whoever is
narrating — which is what almost every module should do.

### Its own memory

By default there is one memory, shared by the card and every module: wherever
you go, it remembers what happened.

A station can leave that pool:

- **Whole card** (default) — reads the whole conversation.
- **Its own** — sees only what was said inside this module. Walk into the
  tower and its AI has never heard of the town; walk out and the town's
  narrator still knows what happened up there. **The messages never leave the
  transcript. Only this AI's view of it narrows.**
- **Shared with named modules** — A and B share one memory, C and D another.
  Good for several scenes with the same NPC, or one branch of a story.

"Its own" is what makes endless-run formats work: every trip into the dungeon
starts the AI in there clean, uncontaminated by the last run, while the world
outside remembers everything.

### How much it reads

A station can cap itself to the latest N messages, overriding the card's
setting. A fight does not need three hundred turns of small talk.

## What the station panel holds

Click a module tile's title on the blueprint, or open it on the classic
editor's Modules page, tick *this module runs the conversation itself*, and
the panel grows these:

- **Model** — follow the player's choice, or name one.
- **What context comes in** — a one-line summary, "the card + N wired in",
  with **Edit** to wire in other modules' experiences, output or variables.
- **When it runs** — backstage writers only: never on its own, when a module
  closes, every N turns, or when a condition holds. Choosing the condition
  option shows the condition editor right there; it fires once, the moment the
  condition turns true.
- **When this module closes** — archive and summarise, or keep it in context.
- **What to do** — the writer's task, such as "compress the fight we just had
  into three lines".
- **Memory** — the pools from the section above, and how many recent messages
  this narrator reads.

*Or make it a backstage writer that never talks to the player* turns it into a
writer: it does not take over the conversation, it runs once when triggered,
and what it writes becomes context for other modules.

## Most cards need none of this

An ordinary character card wants one module and never has to open this page.

Reach for more when:

- one card holds several **places** (dungeons, chapters, branches)
- one card holds several **ways to start** that lead somewhere different
- you want one stretch to run on a **different model, or with no memory of the
  rest**

If you only want to tidy entries into groups, use folders. That is not a module.

## Existing cards

Nothing to do. The lorebooks you already made are modules; open this page and
they are there. The only addition is the *this module's AI* section — leave it
alone and everything behaves exactly as before.

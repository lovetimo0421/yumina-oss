# Openings and Lore

Openings are written for the player. Lore is written for the AI. These two are the bare minimum of any card: the player opens it and reads an opening, and the AI reads your lore and carries the story on from there.

Everything the AI knows about your world comes from lore and [variables](/creator/variables).

## Openings

The opening is the first thing a player reads after opening your card. The story starts here. On the canvas, click the opening's row to write it.

![Writing the opening](./images/canvas/w-opening.webp)

The AI reads the opening as if it were earlier conversation, so it has a big effect on the style of the whole game. Write a long opening and the AI leans toward writing long. Use "*italic actions*" with "quoted dialogue" and the AI will follow suit. It's best to end with a hook, so the player knows what to say next.

> *The TV screen is nothing but static. An emergency broadcast plays on loop: "Confirmed visitor trait: teeth unusually straight and white. Residents should avoid opening their doors…"*
>
> *You're alone in your apartment. There's a peephole in the front door. There's a pistol in the storage closet.*
>
> *Then the knocking starts.*
>
> *A young woman's voice, trembling: "Please… let me in… something out here is chasing me…"*

**You can have several openings.** Click the ＋ in the top right of the opening block to add another, and players get to pick one when they start. Different openings can be different scenes, different storylines, even different starting values: drag an opening onto a variable and you can set "starting from this opening, Coins begin at 100". Drag it onto a [scenario](/creator/modules) and you get "this scenario only exists in games that start from this opening".

Openings can hold pictures or videos. Click **Insert image or video** in the top right of the text box. Details in [Visuals & audio](/creator/visuals-audio#pictures-in-the-opening).

## Lore

Lore (also called entries) is what the AI sees each turn when it writes a reply: who the characters are, what the world is like, what the rules are, what style to write in.

On the canvas, lore is split into four blocks by "when it's sent to the AI":

![The four lore blocks](./images/canvas/lore-blocks.webp)

| Block | When it's sent |
|---|---|
| **Character and world** | Every turn |
| **Keyword lore** | Only when a certain word shows up in the recent conversation |
| **Conditional lore** | Only when a variable meets a condition |
| **Standby lore** | Never on its own. It waits for a behaviour to open it |

Under each block's title you'll see how many entries it has and roughly how much text it costs per turn.

### Character and world: sent every turn

This is the foundation of your world: character descriptions and personalities, the setting, narration style, game mechanics.

Click a row in this block and it opens up. Name goes on top, content below:

![Writing a character entry](./images/canvas/w-setting.webp)

In a survival horror game, for example, the first entry might be a "Game Master" entry that tells the AI its whole role:

> *You are the GM of a survival horror game. The game lasts 14 nights. Each night, describe a visitor knocking at the door. Give clues fairly but never reveal what they are. End every reply with 3-5 suggested options.*

That one entry sets who the AI is, what it does and how it responds. Everything else builds on it.

One entry per character, one per place. Kept separate, they're harder for the AI to mix up.

### Keyword lore: sent when mentioned

For things the AI doesn't need every turn: an NPC's backstory (keyword: the NPC's name), details about a place (keyword: the place name), a particular mechanic.

![Keyword lore](./images/canvas/lore-keywords.webp)

In the horror game, a "Peephole" entry with the keywords `peephole, peek, look` only shows up when the player wants to look through the peephole. It tells the AI to describe the visitor's face, teeth, eyes and skin, with one small tell hinting at whether they're human or a monster. When the player isn't at the peephole, it stays out. That saves text and keeps the AI focused.

Separate keywords with commas. Any one of them showing up triggers it.

### Conditional lore: sent when a value gets there

For example, "Drunk descriptions" is only sent when `Tipsiness ≥ 5`. The quickest way to set it up is to drag the variable onto the entry on the canvas, then click the line to change the condition.

### Standby lore: waits for a behaviour

Never sent on its own until some [behaviour](/creator/automation) opens it. "Yumina's Feelings" from the Guide works like this: normally the AI can't see it, but when affection reaches 80 a behaviour opens it, and Yumina starts quietly caring about you. Great for hidden storylines and switching between stages.

### Switching how it's sent

Every entry, once opened, has a **When the AI sees this** line at the bottom. Click it to switch between the four kinds above, and the entry moves itself into the matching block.

![When the AI sees this](./images/canvas/entry-delivery.webp)

### More settings

You usually won't need these. Just good to know they exist:

- **Inject into**: which part of the AI's prompt it goes in. **Always sent to the AI**, **Sent when mentioned**, **Example dialogue**, **At the end**. "At the end" lore comes after the whole conversation, right before the AI replies. The AI pays it the most attention, so it's the place for final reminders like output format and style rules
- **Send as**: **Instruction** (default), **User** or **AI**. This decides whose voice the entry speaks in within the AI's messages. Every model handles this a bit differently, so it's usually best left alone
- **Secondary Keywords**, **Scan Depth**: fine-tuning for keyword lore

<div v-pre>

## Macros

You can write `{{macros}}` in lore and openings. When the AI sees them, they're swapped for the matching thing:

| Macro | Becomes |
|-----|--------|
| `{{user}}` | The player's name |
| `{{char}}` | The character's name |
| `{{random::a::b::c}}` | One of the options, picked at random |
| `{{roll::2d6}}` | A dice roll result |
| `{{variable_name}}` | That variable's current value |

Any variable works this way. For a variable called `location`, just write `{{location}}` in your lore.

</div>

## Tips for Writing Good Lore

**Tell the AI what to do, not what not to do.** "Describe fights with rich sensory detail" works. "Don't write boring fights" doesn't.

**Keep it short.** The AI reads every active entry, every turn. Every unnecessary entry makes the one that really matters easier to miss. Don't repeat the same thing across entries.

**Not all lore needs to be sent every turn.** Move background knowledge and NPC backstories into keyword lore, and the AI will handle them better.

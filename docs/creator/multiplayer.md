---
title: "Multiplayer"
description: "Let friends play your card together: a shared story the AI narrates for everyone, or a game with real rules and AI in the empty seats. Off until you turn it on."
---

# Multiplayer

Multiplayer lets friends play your card together. It is off by default: a card shows no way to play together until you turn it on.

On the canvas, click **This card**. **Card settings** opens on the right; scroll down to **Multiplayer** and switch it on. The **Cover & blurb** card on the canvas has a way in too: while multiplayer is off it shows a dashed **Multiplayer** button that opens these settings; once it is on it shows the roles' pictures and **Multiplayer 2–6**, and clicking that brings you back here. In **Full mode** (the ⋮ menu) it is in **Card settings** too.

Players see a **Multiplayer** badge on the card and a **Play with friends** button next to **Start Playing**. Friends join only by invite: from the friends list, a link, or a short code.

## Which one to pick

- **Story together**: a story, an adventure, a tabletop-style scene. Everyone writes what they do, and your card's AI tells the story for all of them. Nothing to build; your card works as it is.
- **Play by rules**: a card game, a board game, bluffing, voting. A rules file decides what is allowed and who wins, and your card's interface is the table. Pick this when the game has exact rules.

## Story together

**Players**: from 2 up to 12. The default is 2 to 6.

Each round, everyone writes what they do at the same time. When everyone online has written or pressed **I'm done**, when the countdown runs out, or when someone presses **AI's turn**, the AI gets one turn with every action, each line starting with the player's name, and writes one reply for the whole table. The host picks the countdown in the room menu: 30 seconds, 1, 2 or 5 minutes, or **No limit** (it waits until everyone is ready or someone sends).

**Roles to pick** are optional: without them, everyone joins as their own current persona, and the AI knows each player's persona name and description. Add the parts a player can take, from your characters in **Character and world** or as a plain name, with a one-line note. Switch on **Must pick a role** to make every joiner take a free one; a table then holds as many people as there are roles. The AI is told who plays whom.

A few lines in your lore help: tell the AI there are several players, to answer each of them, and to keep the group together unless they split up. The [Creation assistant](/creator/studio-ai) can do this for you: ask it to make the card ready for several players.

## Play by rules

A **Rules file** is a small JavaScript file in your interface files that holds the game: who moves when, which moves are allowed, what each player may see, who wins. It runs on Yumina's game server, so nobody can peek at another player's hand.

You don't have to write it. With no rules file yet, click **Ask the assistant** and describe the game. The assistant writes the file, plays a few hundred test games against it on the server to catch errors and hidden cards that leak to the wrong player, and builds the table in your interface.

## AI in empty seats

In a rules game the host can fill empty seats with AI players. Under **AI takes empty seats** you can name them and pick the model they play with. An AI seat sees only what a person in that seat would see.

## Who pays, adult cards

The host picks **Who pays** in the room menu. **My treat**: the host pays for every AI call at the table. **Split**: each round's cost is shared equally by the players who acted in it, from their own mushies; watching is free, and everyone sees and agrees to this before joining. If a player runs out, the host covers their share. The moves of AI seats (in a rules game) are on the host. A story room has a **Spending limit** on the whole room, 5,000 mushies per 24 hours by default; the host sees what the room has spent in the room menu and can change it any time. At the limit the round stops, and one tap from the host raises it and carries on. Each player's own content rules still apply: on an adult card, everyone at the table must be 18 or older with their birth year in their profile.

## Public rooms, the host leaving

On a published card, a player can press **Open a public room** on the card page's **Multiplayer** tab, or turn on **Public room** in the room menu. Public rooms are listed on the card page, and anyone can walk in or press **Quick join**, no invite needed. A public room splits the cost by default; the host can switch it to their treat. In a public room, a player who has been gone for 10 minutes gives up their seat.

The host owns the table: when the host leaves, the room closes, and so it does when the host's page has been closed or offline for over 2 minutes. Everyone sees that the host left. A quick refresh or switching away for a moment does not close it.

## Try a table yourself

Open the card, press **Play with friends**, and invite a friend, or open the invite link in a second account. In a rules game, add an AI seat or two and play a full game. The assistant's playtest plays the story alone; it can't sit at a table.

## For your card's interface

A rules game's table is your card's own code. It joins a table with `api.room.join("rules:CODE")`, plays moves with `api.room.act(move)`, gets each player's view from `api.room.onFrame`, and opens the invite sheet with `api.room.invite({ roomId })`. When a friend comes in through the invite link and presses **Start Playing**, `api.room.pendingTable()` returns that table's code (once), so the card can seat them straight away. The assistant knows the details: ask it, or load its multiplayer skill if you work with your own AI through [Connect your AI](/creator/connect-your-ai).

In story mode the card's own interface keeps working: everyone sees it, its input sends that player's action for the round, and presses on its buttons change the shared game for everyone. The platform shows a thin strip above the interface with who has acted, the countdown and 'AI's turn', so the card needs none of its own. To show the party inside your interface, add `<RoomParty />`: each player's role picture and role name, with a ring on whoever acted this round; outside a room it shows nothing. To draw it yourself, read `api.storyRoom`: each entry in `people` has a name, a role name and the role's picture, and `actedIds` lists who acted this round. Each role can also have a picture: click the box beside the role and pick one of the card's images; a role linked to a character uses its portrait.

# Characters in games

A card doesn't have to be played on the web. It can also be a character inside someone else's game: the player meets that character in the game, and the card answers. The SpireTalk mod for *Slay the Spire 2* works this way; each of the eight Ancients and the Merchant is a Yumina card.

The game and the card talk only through variables. Every turn the game writes its own data into the card's variables; after the AI replies, the game reads back the few variables the AI wrote.

## Turn on the game interface

Click **This card** on the canvas, find **Game interface** in the card's settings, turn on **This card is a character in a game**, and fill in the **Game name**.

Once it's on, the **Player interface** block on the canvas stops drawing a chat and shows three columns instead: what the game tells the AI each turn → who the AI plays → what the AI hands back to the game. Anyone can see at a glance what the card is.

## Mark the game's variables

Every variable's settings gain a **Game interface** row with three choices:

- **Neither**: an ordinary variable that has nothing to do with the game
- **From game**: the game writes it every turn, such as health, gold, the floor, the relics the player carries. The AI only reads it. The value on the card is just sample data for playtests; in the game it's replaced by the real one
- **To game**: the AI writes it every turn and the game acts on it, such as a change in affection, three replies for the player to pick from, or whether to give a reward

A marked variable's ID is locked and can't be renamed: the game finds it by its ID, and a renamed one silently cuts the game off. The Creation assistant and outside AIs know not to touch these variables either.

Anything like rewards or deals, the game must check again against its own rules. The AI only talks; whether something is really given is the game's call.

## For mod authors: running a card

A mod doesn't connect to the Yumina site and needs no account. Bundle the Yumina engine into the game (it's open source: [yumina-oss](https://github.com/lovetimo0421/yumina-oss)), read the card's JSON, and call the model with the player's own key. Each turn is four steps:

1. `startSession({ world, variables })`: start a session and get the initial state and the greeting
2. `applyVariables(world, state, values)`: write the game's data into the variables listed in `game.inputs`
3. `buildTurnPrompt({ world, state, history, userText, model })`: get the messages to send to the model, and send them with the player's key
4. `finishTurn({ world, state, userText, rawText })`: parse the model's reply into the clean line and the new state, then read the variables listed in `game.outputs` from `state.variables`

In the card's JSON, `game` looks like this:

```json
"game": {
  "name": "Slay the Spire 2",
  "inputs": ["hp", "max_hp", "gold", "act"],
  "outputs": ["affection_delta", "choices", "action"]
}
```

Write the card in Studio, download its data-only JSON, and put it in the game. Changing how a character talks is changing a file.

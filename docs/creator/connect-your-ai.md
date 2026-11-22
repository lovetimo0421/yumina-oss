---
title: "Connect your AI (MCP)"
description: "Yumina has an MCP server at yumina.io/mcp. Connect Claude, ChatGPT, Cursor, Claude Code or Codex to your account and it reads, edits and playtests your cards in Studio, live."
---

# Connect your AI

Yumina has an [MCP](https://modelcontextprotocol.io) server at `https://yumina.io/mcp`. Add it to the AI tool you already use, sign in once, and that AI can open your cards, write lore, variables, behaviors and interface code, make pictures and playtest, with every change appearing live on your canvas. It cannot publish. That click stays yours.

The Creation assistant inside Studio does the same work with no setup. Connect your own AI when you want your own model, your own subscription, or an agent that keeps working from a terminal.

## Quick start

1. Open the ⋮ menu at the top right of the canvas and click **Connect your AI**. The card has to be saved once first.
2. Pick your tool. The dialog shows its steps, and they all come down to the address above.
3. Click **Allow** on the Yumina page that opens.
4. Send your AI a first message. The dialog notices the connection and says so.

```text
Use Yumina to open my card "Mushroom Tavern" and tell me what's in it right now.
```

## Per client

### Claude

Desktop or web. Open Settings → Connectors → **Add custom connector**, name it Yumina, paste the address, click Continue, then Add. Click Connect, then Allow on the Yumina page.

### ChatGPT and Codex

Settings → Plugins → Add → **Add MCP server**. Name it yumina, pick Streamable HTTP, paste the address, Save. Sign in to Yumina and click Allow.

### Cursor

Click **Add to Cursor** in the dialog, or add this to `.cursor/mcp.json`, then sign in to Yumina and click Allow:

```json
{ "mcpServers": { "yumina": { "url": "https://yumina.io/mcp" } } }
```

### Claude Code

```bash
claude mcp add --transport http yumina https://yumina.io/mcp
```

Then type `/mcp` in Claude Code, pick yumina, Authenticate, and click Allow in the browser.

### Codex CLI

```bash
codex mcp add yumina --url https://yumina.io/mcp
codex mcp login yumina
```

Then open `~/.codex/config.toml` and add one line under `[mcp_servers.yumina]`, because Codex gives a tool 60 seconds by default and a playtest or a picture takes longer:

```toml
tool_timeout_sec = 300
```

### DeepSeek Harness

It cannot sign in yet, so its tab in the dialog makes a token for the card you have open, gives you a `yumina.yml` to save, and a command to run:

```bash
npx @deepseek-ai/dsh web --patch yumina.yml
```

The token reaches that one card only and expires after 90 days.

### Any other tool

If it cannot sign in, open **Can't sign in? Make a token for this card** in the dialog. Put the address and the Authorization header it shows into your tool. The token is shown once.

## Example usage

```text
Add a sly merchant called Vex who talks in riddles and has trust issues.
```

```text
Make a hunger variable that drops over time. When it hits zero, the player dies.
```

```text
Build a dark fantasy interface with health, mana and inventory slots.
```

```text
Go through the sticky notes on my card and make every change they ask for.
```

```text
Playtest five turns as a cautious player and tell me which variables never moved.
```

```text
Check the card for anything wired wrong and fix it.
```

## Available tools

| Job | Tools |
|---|---|
| Find your cards | `list_my_cards`, `create_card` |
| Read a card | `get_world`, `read_entities`, `grep_world`, `list_assets`, `read_ui_doc`, `load_skill` |
| Check it, for free | `validate_world`, `analyze_token_cost`, `simulate_behaviors` |
| Write the story | `write_entry`, `write_variable`, `write_behavior`, `write_worldbook`, `write_audio`, `write_scene_image`, `write_note`, `update_settings`, `set_card_name`, `delete_entities` |
| Build the interface | `write_custom_ui`, `edit_custom_ui`, `edit_ui_doc`, `set_ui_knobs` |
| Try it | `playtest`, up to 10 moves at a time, and `screenshot_ui` |
| Make pictures | `generate_image`, `set_cover` |

Most tools take a `variant`, so it can work on a card's other language versions. It reads your sticky notes and knows where each one is stuck. The server tells every AI to start with `get_world`, and `delete_entities` is marked destructive, so clients that respect that hint ask you first.

## What it costs

Reading, writing and checking are free. Playtest moves, screenshots with moves, and pictures cost mushies at the normal price, the same as when you click them yourself, and failures are refunded.

## Security

- **No password in any config file.** Sign-in is OAuth 2.1 with PKCE. The AI holds a short-lived token with the "cards" permission and nothing else, and the consent page lists exactly what that covers.
- **It cannot publish or touch your account.** On a published card, its edits wait as unpublished changes until you submit them. No balance, password or settings.
- **A checkpoint before every change.** ⋮ → Change History shows "Before: Claude", or whichever AI it was, and you can roll back to it. At most one per AI every 15 minutes.
- **Limits catch a runaway agent.** 30 playtest turns, 20 pictures and 30 screenshots an hour, and 20 new cards a day.

You should still:

- **Read what it wrote** before you publish, the same as with the Creation assistant.
- **Disconnect what you no longer use.** Connected AIs in the dialog, or Settings → Account → Connected apps, lists each one with when it was last used. Disconnect and it loses access that second. Card tokens are listed and revoked the same way.
- **Switch accounts cleanly.** Disconnect, sign out of Yumina in your browser, sign in to the other account, and connect again. For Codex CLI run `codex mcp logout yumina`, then `codex mcp login yumina`.

## Without a connector

If your tool has no MCP support at all, give it the [world file format](/world-spec/) instead. It writes the card's JSON and you import it.

If it can read the web, add this to your request, so it checks its work against the real engine instead of guessing:

```text
Before you give me the card, read the Yumina engine source at https://github.com/lovetimo0421/yumina-oss and check the world against it.
```

After you import it, ask the Creation assistant in Studio to check the card for anything wired wrong.

## Related

- [The Creation assistant](./studio-ai.md)
- [World file format](/world-spec/)

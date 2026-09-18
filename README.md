# Yumina

An open-source engine for AI-native interactive fiction. A Yumina world is not a character card with a prompt; it is a small game. The model writes the story, and the engine gives it typed state, rules that fire on that state, a lorebook that activates by keyword and condition, a custom interface, sound, and, if the creator wants it, a 3D scene. You run it on your own machine with your own model keys.

Yumina began as a SillyTavern fork. It imports SillyTavern V2 and V3 cards and worldbooks, so existing collections carry over. The hosted service at [yumina.io](https://yumina.io) runs this same engine and adds discovery, a creator revenue share, and community. This repository is the engine, the editor, and the player. Why both exist is in the [vision](https://docs.yumina.io/vision/).

## What the engine controls

Everything below is data in a world file. The model never executes code; it emits directives, and the engine applies them.

| Area | What a world can declare |
|---|---|
| Story | `entries[]`: prompt and lore units with a role (system, character, scenario, lore, greeting, example), a section (system presets, examples, chat history, post-history), insertion depth, keyword and secondary-keyword logic, conditions on state, and grouping into activatable worldbooks. Multiple greetings, each with its own starting state. |
| State | `variables[]`: typed `number`, `string`, `boolean`, `json` with min/max, default, behavior rules the model reads, and per-variable AI access (write, read, none). The model changes state with `[variable: op value]` directives; nine operations including `merge`, `push`, `delete` on dot paths like `inventory.weapons[0].durability`. |
| Rules | `rules[]` and `reactions[]`: triggers (state change, threshold crossed, turn count, keyword, action, every turn, session start), conditions with AND/OR, and effects (modify variables, inject or remove directives, send context, toggle entries or rules, notify the player, play audio). Reactions add dice and weighted random, cooldowns, and chained events. |
| Systems | `systems[]`: opt-in engine modules. Spatial (scenes, zones, exits), timer, turn-based combat, a social simulator for multi-agent worlds. |
| Interface | `components[]`: stat bars, text displays, image panels, inventory grids, web panels. `uiBlueprint`: a declarative layout with bindings and triggers. `rootComponent`: a multi-file React app in TypeScript that runs in a sandboxed iframe and talks to the engine through `useYumina()`. It can render anything the browser can, including WebGL scenes. |
| Audio | `audioTracks[]`, playlists, and conditional background music. The model can cue tracks with `[audio: track play]`. |
| Memory | Session summaries and a first-party session-memory extension keep long stories coherent. Branches, rewind, and checkpoints are built in. |

The full schema is in [`docs/world-spec`](docs/world-spec/) and online at [docs.yumina.io/world-spec](https://docs.yumina.io/world-spec/). It is written to be handed to an AI coding tool: paste the spec, describe the world, get valid JSON.

## Architecture

```
packages/
  shared/   Zod schemas, types, constants
  engine/   framework-free TypeScript: state manager, rules and reactions,
            prompt builder, lorebook matcher, response parser, migrations,
            validation. Depends only on zod and js-tiktoken.
  server/   Hono API. Drizzle ORM on embedded PostgreSQL (PGlite) or a real
            Postgres. Providers for OpenRouter, Anthropic, OpenAI, Google,
            Ollama and any OpenAI-compatible endpoint. SSE streaming. Better Auth.
  app/      React 19, Vite, TanStack Router, Zustand. The player, the editor,
            the Studio agent, and the sandbox that runs creator interfaces.
docs/       world spec, creator guide, player guide
```

One turn: the client sends a message, the server builds the prompt (system presets, activated lore within a token budget, memory blocks, game state), streams the model's reply, parses directives out of the stream, applies effects through the state manager, runs reactions and systems, persists, and pushes the new state into the sandbox where the world's interface re-renders.

## Run it

Requirements: Node.js 22 or newer, and pnpm (`corepack enable` gives you pnpm).

```
git clone https://github.com/lovetimo0421/yumina-oss.git
cd yumina-oss
pnpm install
pnpm start
```

The first `pnpm start` builds the app, which takes a few minutes. Then open http://localhost:3000. There is no login: the local edition signs you into one local account. Open Profile or Settings, add a key for your provider, and create or import a world.

Data lives in `packages/server/data` by default: the embedded PostgreSQL database and every image and audio file you upload. Back that folder up and you have everything.

### Connecting a model

Keys are added in the app, not in config files. Supported: OpenRouter, Anthropic, OpenAI, Google, Ollama (local, default `http://localhost:11434`), and any OpenAI-compatible URL such as DeepSeek, LM Studio, KoboldCpp, TabbyAPI or vLLM. Keys are encrypted at rest with AES-256-GCM using a key derived from `BETTER_AUTH_SECRET`.

### Cards

Import: Yumina `.png` or `.json` cards, SillyTavern V2 and V3 character cards, SillyTavern worldbooks. Export: any world as a Yumina PNG card (JSON embedded in a `tEXt` chunk) or plain JSON.

### Environment

`pnpm start` writes a `.env` with a generated `BETTER_AUTH_SECRET` on first run. Everything else is optional.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Bind address. Single-user mode has no login, so only bind `0.0.0.0` on a network you trust, or switch to multi-user mode. |
| `YUMINA_DATA_DIR` | `./data` (under `packages/server`) | Database and uploaded assets |
| `YUMINA_STORAGE_DIR` | `<data dir>/assets` | Uploaded files, when no S3 bucket is configured |
| `YUMINA_AUTH_MODE` | `single-user` | `multi-user` turns on email and password accounts |
| `PUBLIC_ORIGIN` | derived from `BETTER_AUTH_URL` | The origin browsers use to reach this server |
| `BETTER_AUTH_SECRET` | generated | Signs sessions and encrypts stored API keys. Keep it. |
| `DATABASE_URL` | unset | Set to use a real PostgreSQL instead of the embedded one. An empty database is provisioned on first start. |
| `AWS_S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL` | unset | Store uploads in any S3-compatible bucket instead of on disk |

### Docker

```
docker build -t yumina .
docker run -d --name yumina -p 127.0.0.1:3000:3000 -v yumina-data:/data \
  -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) yumina
```

## Development

```
pnpm dev         # server + app with hot reload
pnpm typecheck
pnpm test
pnpm build
```

Rules that keep the engine portable: `packages/engine` never imports React or the server; the model never executes code, it only emits directives the engine applies from structured data. See [CONTRIBUTING.md](CONTRIBUTING.md).

## This repository and yumina.io

This tree is generated from Yumina's private monorepo on every release. The engine, editor, player, providers, and import/export are the same files the hosted service runs, so improvements there land here. What is not here: the discovery feed and recommendations, community, billing and credits, platform-paid models, publishing review, and the creator dashboard. Those are yumina.io's job, and the [vision](https://docs.yumina.io/vision/) explains why they stay centralised while the engine is open.

Issues and pull requests are welcome here. Accepted changes are ported into the private monorepo with authorship preserved and come back in the next release.

## Documentation

- [World spec](docs/world-spec/) — the schema, written for AI coding tools and advanced creators
- [Creator guide](docs/creator/) — entries, variables, rules, visuals and audio, Studio
- [Player guide](docs/guide/)
- Online: [docs.yumina.io](https://docs.yumina.io)
- Community: [Discord](https://discord.gg/gPhncrugz3), [Reddit](https://www.reddit.com/r/yuminaAI/)

## Security

Report vulnerabilities privately through the repository's Security tab, or to `support@yumina.io`. Details and the threat model are in [SECURITY.md](SECURITY.md).

## License

Code: [AGPL-3.0-only](LICENSE). Documentation under `docs/`: [CC BY 4.0](LICENSE-DOCS.md). "Yumina" and the logo are trademarks and not covered by either license; see [TRADEMARK.md](TRADEMARK.md).

# Contributing to Yumina

Thanks for wanting to help. This page tells you how the project works, what we take, and how to get
a change in.

## Dev setup

You need Node.js 22 or newer and pnpm 10 (`corepack enable` gives you pnpm).

Cover encoding tests also need Python 3 with Pillow (`>=9.4,<13`) and FFmpeg,
including `ffprobe`, on PATH. The tests use `python` on Windows and `python3`
elsewhere. Install Pillow into that interpreter before running `pnpm test`.

```
pnpm install       # install everything
pnpm dev           # run server and app in watch mode
pnpm typecheck     # TypeScript, all packages
pnpm test          # unit tests, all packages
pnpm build         # production build
```

Copy `.env.example` to `.env` and set `BETTER_AUTH_SECRET` before `pnpm dev`. The dev server runs on
http://localhost:3000 with the same single-user local account as `pnpm start`.

## Repo layout

```
packages/
  shared/    types, Zod schemas, constants shared by everything else
  engine/    the game engine: state, rules, prompt builder, response parser, components.
             Pure TypeScript. No framework.
  server/    Hono API + Drizzle (PostgreSQL or embedded PGlite) + Better Auth
  app/       React 19 + Vite + Tailwind + TanStack Router + Zustand
docs/
  world-spec/  the card format, for people and for AI tools
  creator/     how to build a world
  guide/       how to play
```

## How this repo relates to the private monorepo

The hosted service (yumina.io) is built from a private monorepo that holds everything in this repo
plus the hosted-only modules (billing, hub, moderation). File paths are the same on both sides.

What that means for you:

- **Your PR is reviewed and merged here**, like in any other open-source project. We squash-merge,
  so your PR lands on `main` as one commit with you as its author.
- **We mirror it into the private monorepo.** After the merge a maintainer applies the same commit
  there with `git am`, so yumina.io gets your change too and your name stays on it.
- **Our own changes arrive as releases.** Work done on the private side lands here as one commit
  per release, "Yumina vX.Y.Z", on top of what is already on `main`. A release never undoes a
  merged PR: the release script refuses to publish while a merged PR is not mirrored yet.

## What is in scope

Anything in this repo:

- the engine and the card format
- the editor, Studio, and the chat canvas
- the sandbox
- model providers (new providers welcome)
- import and export (new card formats welcome)
- the docs and the kit
- bugs, performance, accessibility, translations

## What is out of scope

Things that exist only on the hosted service:

- the hub, discover, search, recommendations
- community, DMs, notifications, achievements, quests
- billing, credits, plans, trials, official models
- publishing review and moderation
- creator dashboard and payouts
- admin tools and analytics

PRs that add hosted-style features (a hub client, accounts sync, payments) will be closed with a
pointer here. If you are not sure, open an issue first and ask.

## Coding rules

Three rules are hard. Everything else is taste.

1. **The engine stays framework-agnostic.** Nothing in `packages/engine` imports React, Vue, the
   DOM, or Node APIs. It is plain TypeScript and Zod. It runs on the server, in the browser, and one
   day in a desktop shell.
2. **The AI never executes code.** The model emits directives. The engine parses them and applies
   them. Do not add a path where model output is evaluated, interpolated into a shell, or run as a
   script.
3. **`pnpm typecheck` must pass.** CI runs typecheck, tests, and build on every PR. Red CI does not
   get reviewed.

Softer rules:

- Keep changes small. One PR, one thing.
- Match the code around you. We do not argue about formatting.
- Add a test when you fix a bug so it stays fixed.
- If you touch the card schema, update `docs/world-spec/` in the same PR.
- Write docs like a person. Short sentences. No marketing.

## Commit style

```
type(scope): what changed, as a plain sentence
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. Scope is the package or area:
`engine`, `server`, `app`, `studio`, `editor`, `sandbox`, `docs`.

Examples:

```
fix(engine): merge effect keeps sibling keys on nested json paths
feat(server): add Mistral as a provider
docs(world-spec): document dice syntax in rule conditions
```

The body explains why, not what. The diff already says what.

## The CLA

Before we can merge your first PR you need to sign the Contributor License Agreement in `CLA.md`.
Signing is one comment on the PR:

> I have read the CLA Document and I hereby sign the CLA

The CLA bot posts that sentence on your first PR and turns its check green once you have posted it.
You sign once; it covers all your later PRs.

**Why we need it.** The code is AGPL-3.0. AGPL says that if you run modified code as a network
service, you must offer the whole corresponding source to the people who use it. The hosted service
at yumina.io runs this code plus proprietary modules (billing, hub, moderation). If you contribute a
change to a core file under AGPL alone, that change would bind the hosted deployment to publish the
proprietary modules too. The CLA gives the company the right to also use your contribution under
other terms in the hosted build. You keep your copyright. The public repo stays AGPL. Nothing in the
CLA lets us take the open-source edition closed.

## Reporting bugs

Use the bug template. It asks for the version, your OS, how you run Yumina, and the model provider.
Those four things answer most questions before we ask them.

## Security problems

Do not open an issue. Read `SECURITY.md` and email `support@yumina.io`.

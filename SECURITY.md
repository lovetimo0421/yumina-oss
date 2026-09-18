# Security

## Supported versions

Only the latest release gets security fixes. If you run an older release, update first and check
whether the problem is still there.

## How to report a vulnerability

Use the "Report a vulnerability" button on the repository's Security tab (GitHub keeps it private), or email `support@yumina.io`. Do not open a public issue for a security problem.

Tell us:

- what you found and why it matters
- steps to reproduce, or a proof of concept
- the release or commit you tested
- how you ran Yumina (`pnpm start`, Docker, single-user or multi-user)

We will acknowledge your report within 3 business days. We will tell you what we plan to do and
keep you updated until it is fixed. We will credit you in the release notes unless you ask us not
to.

## Threat model

This section explains what the local edition protects and what it expects you to protect. Read it
before you expose an install to a network.

### Creator custom UI runs in a sandbox

A world card can carry a custom UI: TypeScript and React written by the world's creator. When you
play that world, this code runs in your browser inside an `<iframe sandbox="allow-scripts">`. The
iframe has an opaque origin and a Content Security Policy with `connect-src 'none'`. That means:

- it cannot read your cookies, local storage, or the main page
- it cannot make network requests of its own
- it can only talk to Yumina through the message channel the engine gives it

The sandbox is the trust boundary between you and a world you downloaded. If you find a way out of
it, that is a vulnerability. Please report it.

### The Studio preview of your own code is not sandboxed

When you build a world in Studio, the live preview of your own custom UI runs unsandboxed. This is
by design: it gives you hot reload and full devtools. The code is yours, so there is nothing to
protect you from. Do not paste custom UI code you do not trust into Studio. Import the card and play
it instead, where the sandbox applies.

### Single-user mode has no login

The local edition signs you into one local account. There is no password. Anyone who can reach the
port is you. That is why the server binds `127.0.0.1` by default: only programs on your own machine
can connect.

If you set `HOST=0.0.0.0`, everyone on that network becomes you. They can read your chats, use your
API keys, and delete your worlds. Do this only on a network you trust, or switch to
`YUMINA_AUTH_MODE=multi-user` first, which turns on a login screen.

The Docker image sets `HOST=0.0.0.0` because a container has to. Keep the published port on
localhost (`-p 127.0.0.1:3000:3000`), put a reverse proxy with authentication in front, or use
multi-user mode.

### Your API keys

Model API keys you add in Settings are stored in the local database, encrypted with AES-256-GCM. The
encryption key is derived from `BETTER_AUTH_SECRET`. Two things follow:

- Anyone who has both your data folder and your `.env` can decrypt the keys. Protect both.
- If you rotate `BETTER_AUTH_SECRET`, every stored key becomes unreadable. This is intentional. You
  will have to enter them again.

Keys are decrypted only on the server, only to make the model request. They are never sent to the
browser.

### `/cdn/*` is public on purpose

Uploaded images and audio are served from `/cdn/<asset-id>` with `Access-Control-Allow-Origin: *`.
This is intentional. The sandboxed custom UI has an opaque origin and needs CORS to load a world's
pictures and sounds. Asset IDs are random UUIDs and are not listed anywhere, but anyone with an ID
can fetch that file. Do not upload things you would not want served without a login.

### What is out of scope

- Prompt injection against the AI model. The model can be talked into anything. That is why the
  engine, not the model, applies state changes, and why the model can only emit directives, never
  code.
- Content produced by a model you connected. That is between you and your provider.
- Vulnerabilities in a model provider's API.
- Problems that need `HOST=0.0.0.0` in single-user mode on an untrusted network. That
  configuration is documented as unsafe.

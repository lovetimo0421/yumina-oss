# Yumina open-source edition - container image
#
# Build:
#   docker build -t yumina .
#
# Run (data in a named volume, port only on this machine):
#   docker run -d --name yumina \
#     -p 127.0.0.1:3000:3000 \
#     -v yumina-data:/data \
#     -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
#     yumina
#
# About HOST=0.0.0.0: inside a container the server has to listen on the
# container's own network interface, or Docker's port mapping cannot reach it.
# 127.0.0.1 (the default outside Docker) would be unreachable. So this image
# binds 0.0.0.0. Single-user mode has no login, which means the image relies on
# YOU not publishing the port to an untrusted network. Bind the published port
# to localhost (-p 127.0.0.1:3000:3000), put a reverse proxy with its own login
# in front, or run with -e YUMINA_AUTH_MODE=multi-user.

# ---- Base: Node 22 + pnpm via corepack ------------------------------------
FROM node:22-slim AS base
# One clock for everything. Timestamps are stored as UTC.
ENV TZ=UTC
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

# ---- Install dependencies -------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/app/package.json packages/app/
RUN pnpm install --frozen-lockfile

# ---- Build ----------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm build
# The app dist is served publicly. Source maps are not needed at runtime.
RUN find packages/app/dist -name "*.map" -delete

# ---- Runtime image --------------------------------------------------------
FROM base AS runner
WORKDIR /app

# Production dependencies only. The app package is not needed at runtime; its
# built files are copied into the server's public folder below.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --prod

# Built packages.
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/packages/server/dist packages/server/dist

# Built frontend, served by the server as static files.
COPY --from=build /app/packages/app/dist packages/server/public

# Studio AI skills (.md files the server reads at runtime).
COPY --from=build /app/packages/server/skills packages/server/skills

# Everything the install persists lives in /data: the embedded PGlite
# database and uploaded images and audio. Mount a volume there.
ENV YUMINA_EDITION=local \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    YUMINA_DATA_DIR=/data \
    PGLITE_DATA_DIR=/data/pglite
VOLUME /data
EXPOSE 3000

WORKDIR /app/packages/server

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT (this is a pnpm-workspace package), e.g.:
#   docker build -f packages/server-node/Dockerfile -t weaver-sync-node .

# --- build: install the workspace, then flatten this package + its workspace
#     deps (@weaver/sync-core) into a self-contained /out via `pnpm deploy`. ---
FROM node:20-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# tsx + loro-crdt + ws are runtime `dependencies` (not dev), so --prod keeps them.
RUN pnpm --filter @weaver/server-node deploy --prod /out

# --- runtime: just the deployed package; run the TS entry under tsx directly
#     (no pnpm/corepack at runtime — invoking pnpm here re-bootstraps a newer
#     pnpm via corepack and crashes). ---
FROM node:20-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app
COPY --from=build /out /app
EXPOSE 8787
# Optional: mount a volume and set WEAVER_DATA_DIR=/data for snapshot persistence.
CMD ["node", "--import", "tsx", "src/main.ts"]

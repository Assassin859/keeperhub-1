FROM node:24-alpine AS base
RUN npm install -g pnpm@9
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sandbox/package.json ./sandbox/
RUN --mount=type=cache,id=pnpm-sandbox,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @keeperhub/sandbox

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sandbox/package.json sandbox/tsconfig.json ./sandbox/
COPY sandbox/src ./sandbox/src
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/sandbox/node_modules ./sandbox/node_modules
RUN pnpm --filter @keeperhub/sandbox build

FROM node:24-alpine AS runtime
RUN apk add --no-cache tini
RUN addgroup -g 1001 -S sandbox && \
    adduser -S sandbox -u 1001 -G sandbox
WORKDIR /app
COPY --from=build --chown=sandbox:sandbox /app/sandbox/dist ./dist
COPY --from=build --chown=sandbox:sandbox /app/sandbox/package.json ./package.json
USER sandbox
ENV NODE_ENV=production
ENV SANDBOX_PORT=8787
EXPOSE 8787
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

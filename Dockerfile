# Multi-stage Dockerfile for Next.js application
# Stage 1: Dependencies
FROM node:24-alpine AS deps
RUN apk add --no-cache libc6-compat && \
    wget -q -O /etc/ssl/certs/rds-combined-ca-bundle.pem \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Copy package files
COPY package.json pnpm-lock.yaml* ./
COPY .npmrc* ./

# Install dependencies with cache mount for faster rebuilds
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Stage 2: Source (dependencies + source files, no build)
FROM node:24-alpine AS source
WORKDIR /app
RUN npm install -g pnpm@9

# Copy dependencies from deps stage
COPY --link --from=deps /app/node_modules ./node_modules

# Source files split into granular COPYs so BuildKit caches each
# directory independently. A PR touching only plugins/ invalidates
# only that layer; unchanged directories stay cached.
COPY app/ ./app/
COPY components/ ./components/
COPY deploy/scripts/ ./deploy/scripts/
COPY drizzle/ ./drizzle/
COPY hooks/ ./hooks/
COPY keeperhub-events/ ./keeperhub-events/
COPY keeperhub-executor/ ./keeperhub-executor/
COPY keeperhub-scheduler/ ./keeperhub-scheduler/
COPY lib/ ./lib/
COPY plugins/ ./plugins/
COPY protocols/ ./protocols/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY next.config.ts tsconfig.json package.json drizzle.config.ts ./
COPY instrumentation.ts instrumentation-client.ts ./
COPY sentry.server.config.ts sentry.edge.config.ts ./
COPY postcss.config.mjs components.json ./

# Stage 2.5: Builder (runs Next.js build, only needed for runner stage)
FROM source AS builder

# Create README.md if it doesn't exist to avoid build errors
RUN touch README.md || true

# Set environment variables for social providers
ARG NEXT_PUBLIC_AUTH_PROVIDERS
ARG NEXT_PUBLIC_GITHUB_CLIENT_ID
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID
ARG NEXT_PUBLIC_BILLING_ENABLED
ENV NEXT_PUBLIC_AUTH_PROVIDERS=$NEXT_PUBLIC_AUTH_PROVIDERS
ENV NEXT_PUBLIC_GITHUB_CLIENT_ID=$NEXT_PUBLIC_GITHUB_CLIENT_ID
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID
ENV NEXT_PUBLIC_BILLING_ENABLED=$NEXT_PUBLIC_BILLING_ENABLED

# Sentry DSN baked into client bundle for error reporting.
# SENTRY_ORG/PROJECT/AUTH_TOKEN/RELEASE are intentionally NOT set here
# so this stage is cache-deterministic across commits (see sentry-upload stage).
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV CI=true

# Build the application with Turbopack (source maps generated but not uploaded).
# Cache mount persists .next/cache across builds on the same BuildKit instance,
# enabling Turbopack's incremental compilation.
RUN --mount=type=cache,target=/app/.next/cache pnpm build

# Stage 2.5b: Sentry source map upload (side-effect only, not consumed by other stages)
FROM builder AS sentry-upload
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_AUTH_TOKEN
ARG SENTRY_RELEASE
RUN if [ -n "$SENTRY_AUTH_TOKEN" ]; then \
      ./node_modules/.bin/sentry-cli releases new "$SENTRY_RELEASE" \
        --org "$SENTRY_ORG" --project "$SENTRY_PROJECT" && \
      ./node_modules/.bin/sentry-cli sourcemaps upload \
        --org "$SENTRY_ORG" \
        --project "$SENTRY_PROJECT" \
        --release "$SENTRY_RELEASE" \
        .next && \
      ./node_modules/.bin/sentry-cli releases finalize "$SENTRY_RELEASE" \
        --org "$SENTRY_ORG" --project "$SENTRY_PROJECT"; \
    fi

# Stage 2.6: Migration stage (for running migrations and seeding)
FROM node:24-alpine AS migrator
WORKDIR /app
RUN npm install -g pnpm@9 tsx@4
COPY --link --from=deps /etc/ssl/certs/rds-combined-ca-bundle.pem /etc/ssl/certs/rds-combined-ca-bundle.pem

# Copy dependencies, migration files, and seed scripts
COPY --link --from=deps /app/node_modules ./node_modules
COPY --link --from=source /app/drizzle ./drizzle
COPY --link --from=source /app/drizzle.config.ts ./drizzle.config.ts
COPY --link --from=source /app/lib ./lib
COPY --link --from=source /app/plugins ./plugins
COPY --link --from=source /app/scripts ./scripts
COPY --link --from=source /app/package.json ./package.json
COPY --link --from=source /app/tsconfig.json ./tsconfig.json

# This stage runs migrations and seeds default data
# Build with: docker build --target migrator -t keeperhub-migrator .
# Run setup (migrations + seed): docker run --env DATABASE_URL=xxx keeperhub-migrator pnpm db:setup
# Run migrations only: docker run --env DATABASE_URL=xxx keeperhub-migrator pnpm db:migrate
# Run seed only: docker run --env DATABASE_URL=xxx keeperhub-migrator pnpm db:seed

# Stage 2.7a: Scheduler Dependencies (uses main project deps)
# The scheduler scripts now live in scripts/scheduler/ and import from
# the main project's dependencies, so we reuse the full deps stage.
FROM node:24-alpine AS scheduler-deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9

# Use scheduler's own package.json for its specific dependencies
COPY keeperhub-scheduler/package.json keeperhub-scheduler/pnpm-lock.yaml ./

# Install only production dependencies with cache mount
RUN --mount=type=cache,id=pnpm-scheduler,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile

# Stage 2.7b: Scheduler base (shared deps for all scheduler services)
FROM node:24-alpine AS scheduler-base
RUN addgroup -g 1001 -S scheduler && \
    adduser -S scheduler -u 1001
WORKDIR /app
RUN npm install -g tsx@4
COPY --link --from=deps /etc/ssl/certs/rds-combined-ca-bundle.pem /etc/ssl/certs/rds-combined-ca-bundle.pem
COPY --link --from=scheduler-deps /app/node_modules ./node_modules
ENV NODE_ENV=production

# Stage 2.7c: Schedule Dispatcher
FROM scheduler-base AS schedule-dispatcher
COPY --link --from=source /app/keeperhub-scheduler/schedule-dispatcher/ ./schedule-dispatcher/
COPY --link --from=source /app/keeperhub-scheduler/lib/ ./lib/
COPY --link --from=source /app/keeperhub-scheduler/package.json ./keeperhub-scheduler/package.json
COPY --link --from=source /app/keeperhub-scheduler/tsconfig.json ./keeperhub-scheduler/tsconfig.json
COPY --link --from=source /app/keeperhub-scheduler/package.json ./package.json
COPY --link --from=source /app/keeperhub-scheduler/tsconfig.json ./tsconfig.json
RUN chown -R scheduler:scheduler /app
USER scheduler
EXPOSE 3000
CMD ["tsx", "schedule-dispatcher/index.ts"]

# Stage 2.7d: Block Dispatcher
FROM scheduler-base AS block-dispatcher
COPY --link --from=source /app/keeperhub-scheduler/block-dispatcher/ ./block-dispatcher/
COPY --link --from=source /app/keeperhub-scheduler/lib/ ./lib/
COPY --link --from=source /app/keeperhub-scheduler/package.json ./package.json
COPY --link --from=source /app/keeperhub-scheduler/tsconfig.json ./tsconfig.json
RUN chown -R scheduler:scheduler /app
USER scheduler
EXPOSE 3000
CMD ["tsx", "block-dispatcher/index.ts"]

# Stage 2.8: Workflow Runner stage (for executing workflows in K8s Jobs)
FROM node:24-alpine AS workflow-runner
WORKDIR /app
RUN npm install -g pnpm@9 tsx@4
COPY --link --from=deps /etc/ssl/certs/rds-combined-ca-bundle.pem /etc/ssl/certs/rds-combined-ca-bundle.pem

# Copy dependencies and workflow execution files
COPY --link --from=deps /app/node_modules ./node_modules
COPY --link --from=source /app/keeperhub-executor ./keeperhub-executor
COPY --link --from=source /app/lib ./lib
COPY --link --from=source /app/plugins ./plugins
COPY --link --from=source /app/protocols ./protocols
COPY --link --from=source /app/package.json ./package.json
COPY --link --from=source /app/tsconfig.json ./tsconfig.json

# Copy auto-generated files from builder stage (step-registry.ts, etc. are in .gitignore)
COPY --link --from=builder /app/lib/step-registry.ts ./lib/step-registry.ts
COPY --link --from=builder /app/lib/codegen-registry.ts ./lib/codegen-registry.ts
COPY --link --from=builder /app/lib/output-display-configs.ts ./lib/output-display-configs.ts
COPY --link --from=builder /app/lib/types/integration.ts ./lib/types/integration.ts
COPY --link --from=builder /app/plugins/index.ts ./plugins/index.ts
COPY --link --from=builder /app/protocols/index.ts ./protocols/index.ts

# Create a shim for 'server-only' package - the runner runs outside Next.js
# so we replace the package with an empty module that doesn't throw
# We need to replace it in the .pnpm folder where the actual package lives
SHELL ["/bin/ash", "-o", "pipefail", "-c"]
RUN find /app/node_modules -path "*server-only*/index.js" | while read -r f; do echo 'module.exports = {};' > "$f"; done

ENV NODE_ENV=production

# This stage runs inside K8s Jobs to execute individual workflows
# Environment variables are passed by the executor:
#   WORKFLOW_ID, EXECUTION_ID, SCHEDULE_ID, WORKFLOW_INPUT, DATABASE_URL
#
# Build with: docker build --target workflow-runner -t keeperhub-runner .
CMD ["tsx", "keeperhub-executor/workflow-runner.ts"]

# Stage 2.9: Unified Executor (polls SQS, dispatches to K8s Jobs or in-process)
FROM node:24-alpine AS executor
WORKDIR /app
RUN npm install -g pnpm@9 tsx@4
COPY --link --from=deps /etc/ssl/certs/rds-combined-ca-bundle.pem /etc/ssl/certs/rds-combined-ca-bundle.pem

# Full deps needed for in-process workflow execution + @kubernetes/client-node
COPY --link --from=deps /app/node_modules ./node_modules
COPY --link --from=source /app/keeperhub-executor ./keeperhub-executor
COPY --link --from=source /app/lib ./lib
COPY --link --from=source /app/plugins ./plugins
COPY --link --from=source /app/protocols ./protocols
COPY --link --from=source /app/package.json ./package.json
COPY --link --from=source /app/tsconfig.json ./tsconfig.json

# Copy auto-generated files from builder stage
COPY --link --from=builder /app/lib/step-registry.ts ./lib/step-registry.ts
COPY --link --from=builder /app/lib/codegen-registry.ts ./lib/codegen-registry.ts
COPY --link --from=builder /app/lib/output-display-configs.ts ./lib/output-display-configs.ts
COPY --link --from=builder /app/lib/types/integration.ts ./lib/types/integration.ts
COPY --link --from=builder /app/plugins/index.ts ./plugins/index.ts
COPY --link --from=builder /app/protocols/index.ts ./protocols/index.ts

# Shim server-only (runs outside Next.js)
SHELL ["/bin/ash", "-o", "pipefail", "-c"]
RUN find /app/node_modules -path "*server-only*/index.js" | while read -r f; do echo 'module.exports = {};' > "$f"; done

ENV NODE_ENV=production

# Build with: docker build --target executor -t keeperhub-executor .
CMD ["tsx", "keeperhub-executor/index.ts"]

# Stage 3: Runner (main Next.js app)
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --link --from=deps /etc/ssl/certs/rds-combined-ca-bundle.pem /etc/ssl/certs/rds-combined-ca-bundle.pem

# Create non-root user and install curl (used by healthcheck and cronjob scripts)
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    apk add --no-cache curl

# Copy built application (source maps removed - uploaded by sentry-upload stage)
COPY --link --from=builder /app/public ./public
COPY --link --from=builder --chown=1001:1001 /app/.next/standalone ./
COPY --link --from=builder --chown=1001:1001 /app/.next/static ./.next/static
RUN find .next -name '*.map' -delete 2>/dev/null || true

# Copy OG image fonts for server-side image generation
COPY --link --from=source --chown=1001:1001 /app/app/api/og/fonts ./app/api/og/fonts

# Copy deploy scripts (used by cronjobs)
COPY --link --from=source /app/deploy/scripts ./deploy/scripts

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

# Start the application
CMD ["node", "server.js"]

# ─── Stage 1: Install production dependencies ─────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Install libc6-compat for native modules (e.g. sharp, better-sqlite3)
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ─── Stage 2: Build the application ───────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache libc6-compat openssl

# Copy production deps from stage 1
COPY --from=deps /app/node_modules ./node_modules

# Copy all source files
COPY . .

# Install all deps (including devDependencies needed for build)
RUN npm ci

# Build Next.js in standalone mode.
# `npm run build` regenerates prisma/{postgres,sqlite}/schema.prisma from
# schema.base.prisma, generates BOTH Prisma clients (@prisma/client = Postgres,
# node_modules/.prisma/client-sqlite = SQLite), migrates a throw-away SQLite DB
# and prerenders against it. The build never needs a running Postgres.
# Version string (YYYY.M.D-sha7). Inlined into client bundles at build time.
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
ENV NEXT_TELEMETRY_DISABLED=1
ENV DB_PROVIDER=sqlite
ENV BUILD_DATABASE_URL="file:/tmp/prisma-build.db"
RUN npm run build

# ─── Stage 3: Production runner ───────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache libc6-compat openssl

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION

# Create a non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy Prisma schemas and migrations (both providers) so we can run
# migrate deploy at startup. node_modules/.prisma carries BOTH generated
# clients: .prisma/client (Postgres) and .prisma/client-sqlite (SQLite).
# WORKDIR must stay /app: the SQLite client locates its query engine
# relative to process.cwd().
COPY --from=builder /app/prisma/postgres ./prisma/postgres
COPY --from=builder /app/prisma/sqlite ./prisma/sqlite
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma

# Create persistent data directories
RUN mkdir -p /app/data /app/uploads && \
    chown -R nextjs:nodejs /app/data /app/uploads /app

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
# Provider: an explicit DB_PROVIDER wins (case-insensitive; anything but
# "sqlite" is postgres, so "postgresql" works). When DB_PROVIDER is unset or
# empty, a file: DATABASE_URL means sqlite and anything else postgres. This
# mirrors resolveProvider() in src/lib/db/provider.ts. No DB_PROVIDER default
# is baked in, so `docker run -e DATABASE_URL=file:/app/data/vault.db` works.
#
# Run the chosen provider's migrations, then start the server.
CMD ["sh", "-c", "\
p=$(printf '%s' \"$DB_PROVIDER\" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]'); \
case \"$p\" in \
  sqlite) ;; \
  '') case \"$DATABASE_URL\" in [Ff][Ii][Ll][Ee]:*) p=sqlite ;; *) p=postgres ;; esac ;; \
  *) p=postgres ;; \
esac; \
export DB_PROVIDER=\"$p\"; \
node node_modules/prisma/build/index.js migrate deploy --schema \"prisma/$p/schema.prisma\" && node server.js"]

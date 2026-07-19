// ============================================================================
// ClearPort — Production Dockerfile
// ============================================================================
// Multi-stage build that produces a minimal production image.
// Installs poppler-utils (provides pdftoppm) so the PDF OCR route works
// out of the box — no host-level apt-get required.
//
// Runs BOTH the Next.js web server AND the queue worker — a half-alive
// container that only runs the web server is worse than a dead one, because
// it still passes the HEALTHCHECK while silently processing nothing.
// ============================================================================

# --- Stage 1: deps (use bun for deterministic lockfile-based install) ---
FROM oven/bun:1-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    openssl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# --- Stage 2: build ---
FROM oven/bun:1-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN bun run build

# --- Stage 3: runner (minimal production image, runs BOTH processes) ---
FROM node:22-slim AS runner
WORKDIR /app

# Install runtime OS deps + bun (for the worker process)
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Install bun in the node:22-slim runner (npm package, no apt repo needed)
RUN npm install -g bun

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Create a non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs
USER nextjs

# Copy the standalone build output
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/mini-services ./mini-services

EXPOSE 3000

# Health check — Caddy / orchestrators can hit this
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Start BOTH the web server and the worker. If either dies, the container
# exits (via wait -n) so the orchestrator restarts it — no half-alive state.
CMD ["sh", "-c", "node server.js & bun mini-services/worker/index.ts & wait -n"]

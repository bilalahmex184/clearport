# ============================================================================
# ClearPort — Production Dockerfile
# ============================================================================
# Multi-stage build that produces a minimal production image.
# Installs poppler-utils (provides pdftoppm) so the PDF OCR route works
# out of the box — no host-level apt-get required.
# ============================================================================

# --- Stage 1: deps ---
FROM node:22-slim AS deps
WORKDIR /app

# Install OS-level dependencies needed at runtime:
#   - poppler-utils: provides `pdftoppm` for PDF rasterization in /api/internal/ocr
#   - openssl: needed by some Node crypto paths + secret generation
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    openssl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy lockfile + package.json for deterministic install
COPY package.json bun.lock* ./
COPY .npmrc* ./

# Install with npm (fallback if bun isn't available in the base image)
RUN npm install --frozen-lockfile 2>/dev/null || npm install

# --- Stage 2: build ---
FROM node:22-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the Next.js standalone output
# Self-hosted fonts (next/font/local) — no Google Fonts CDN dependency at build time
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# --- Stage 3: runner (minimal production image) ---
FROM node:22-slim AS runner
WORKDIR /app

# Install runtime OS deps in the final image too
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

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

EXPOSE 3000

# Health check — Caddy / pm2 / orchestrators can hit this
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

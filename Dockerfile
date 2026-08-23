# ── Build Stage ──────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Production Stage ────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy compiled output
COPY --from=builder /app/dist ./dist
COPY config/ ./config/

# Run as non-root for security
RUN addgroup -S openbrain && adduser -S openbrain -G openbrain
USER openbrain

# Expose ports: API (8000) and MCP (8080)
EXPOSE 8000 8080

# Health check
# S275 (task_1785713207341): points at /health/deep, NOT /health. /health is a
# static handler that CANNOT FAIL -- measured green by `docker inspect` throughout
# the S204 and S231 outages while search was dead. /health/deep probes the embedder
# dependency and returns 503 when it is measurably unreachable, so wget exits
# non-zero and Docker finally has something to act on. start-period widened to 30s:
# a container marked unhealthy during normal startup teaches everyone to ignore it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://localhost:8000/health/deep || exit 1

# Run
CMD ["node", "dist/index.js"]

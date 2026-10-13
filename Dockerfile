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
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
# S465 (task_1790726722682, ruled option (b)): the runtime stage carries NO npm. The base image's
# bundled npm CLI shipped ip-address 10.1.0 (GHSA-v2v4-37r5-5v8g range) outside the app graph; the
# app runs `node dist/index.js` and never needs npm at runtime. A scanner reading the IMAGE (not the
# manifest) flags it, and Patch Tuesday's manifest audit cannot see it by construction.

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

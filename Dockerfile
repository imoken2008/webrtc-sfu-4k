# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-bullseye-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 python3-pip make g++ pkg-config \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY public/ ./public/
COPY build.js ./
RUN node build.js

RUN npm prune --production

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:22-bullseye-slim AS runner

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/public       ./public
COPY package.json   ./
COPY server.js      ./

ENV NODE_ENV=production
ENV PORT=8080
ENV RTC_PORT=10000

EXPOSE 8080
EXPOSE 10000/udp
EXPOSE 10000/tcp

CMD ["node", "server.js"]

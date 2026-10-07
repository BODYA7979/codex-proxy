# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim

ARG CODEX_CLI_VERSION=0.160.0
ENV NODE_ENV=production \
    CODEX_HOME=/home/node/.codex \
    CODEX_PROXY_HOST=0.0.0.0 \
    CODEX_PROXY_PORT=3466

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --no-audit --no-fund "@openai/codex@${CODEX_CLI_VERSION}" \
    && mkdir -p /home/node/.codex \
    && chown node:node /home/node/.codex
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist

USER node
VOLUME ["/home/node/.codex"]
EXPOSE 3466
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "const port = Number(process.env.CODEX_PROXY_PORT || 3466); const req = require('node:http').get({ hostname: '127.0.0.1', port, path: '/health', timeout: 4000 }, res => { res.resume(); if (res.statusCode !== 200) { console.error('health returned HTTP ' + res.statusCode); process.exitCode = 1; } }); req.on('timeout', () => { console.error('health timed out on port ' + port); req.destroy(); }); req.on('error', err => { console.error('health failed on port ' + port + ': ' + err.message); process.exitCode = 1; });"]

CMD ["node", "dist/server/standalone.js"]

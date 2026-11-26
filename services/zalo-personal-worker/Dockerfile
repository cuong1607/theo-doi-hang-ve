# ============================================================
# PHASE 07 (OPS-10) — Zalo Personal worker image for a Linux VPS.
# NOT deployed by this phase. Never put a session, secret or .env in the image:
# everything sensitive lives in the /data volume or the environment at run time.
#   build:  docker build -t congtrangbedding/zalo-worker:0.2.0 services/zalo-personal-worker
#   run:    see ops/docker/docker-compose.yml + docs/zalo-ai/phase-07-operations.md
# ============================================================
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    ZP_DATA_DIR=/data \
    ZP_SESSION_PROTECTION=aes-key \
    ZP_QR_AUTO_OPEN=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY ops/docker/entrypoint.sh /usr/local/bin/zp-entrypoint
# /data: session (AES-encrypted), outbox, send journal, health, logs, QR images — 0700, owned by "node"
RUN chmod 0755 /usr/local/bin/zp-entrypoint && mkdir -p /data && chown node:node /data && chmod 0700 /data
USER node
VOLUME ["/data"]
# healthy = health file fresh AND Zalo listener connected (not just "process alive")
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 CMD ["node", "dist/main.js", "healthcheck"]
ENTRYPOINT ["zp-entrypoint"]
CMD ["run"]

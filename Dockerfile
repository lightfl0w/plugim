ARG NODE_VERSION=22
ARG RUST_VERSION=1.90

FROM node:${NODE_VERSION}-bookworm-slim AS web
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
RUN pnpm install --frozen-lockfile --filter @plugim/web... || pnpm install --filter @plugim/web...
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm --filter @plugim/web build

FROM rust:${RUST_VERSION}-bookworm AS server
WORKDIR /build
COPY apps/server/Cargo.toml apps/server/Cargo.lock ./
RUN mkdir -p src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY apps/server/src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl postgresql-client tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /build/target/release/plugim-server /app/plugim-server
COPY --from=web /build/apps/web/dist /app/web
RUN mkdir -p /app/data /app/data/logs /app/data/uploads /app/data/backups
ENV PORT=3000 \
    PLUGIM_WEB_DIST=/app/web \
    PLUGIM_DB_FILE=/app/data/plugim.db \
    PLUGIM_STORAGE_DIR=/app/data/uploads \
    PLUGIM_LOG_DIR=/app/data/logs \
    PLUGIM_BACKUP_DIR=/app/data/backups \
    PLUGIM_INSTALL_FILE=/app/data/install.json
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["/app/plugim-server"]

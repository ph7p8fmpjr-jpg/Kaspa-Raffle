# Stage 1: build raffle-cli (Rust) — reuses the SilverScript compiler library
FROM rust:1.85-slim AS rust-builder
RUN apt-get update && apt-get install -y git pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Layout must mirror the repo: silverscript/ and kaspa-raffle-website/ side by side
COPY silverscript/ silverscript/
COPY kaspa-raffle-website/covenant/ kaspa-raffle-website/covenant/
RUN cd silverscript && cargo build --release -p raffle-cli

# Stage 2: runtime — Node service + raffle-cli binary
FROM node:22-slim
WORKDIR /app
COPY kaspa-raffle-website/package.json ./
COPY kaspa-raffle-website/kaspa-sdk-v2.0.1/ kaspa-sdk-v2.0.1/
RUN npm install --omit=dev
COPY kaspa-raffle-website/backend/ backend/
COPY kaspa-raffle-website/covenant/ covenant/
COPY kaspa-raffle-website/index.html ./
COPY --from=rust-builder /build/silverscript/target/release/raffle-cli bin/raffle-cli
ENV RAFFLE_CLI=/app/bin/raffle-cli
ENV DATA_DIR=/app/data
CMD ["node", "backend/server.js"]

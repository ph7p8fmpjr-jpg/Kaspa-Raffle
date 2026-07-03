# Runtime-only image: the raffle-cli Linux binary is built by GitHub Actions
# (.github/workflows/build-raffle-cli.yml) and published as the `bin-latest`
# release — Render's build stays fast and light.
FROM node:22-slim
RUN apt-get update && apt-get install -y curl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY kaspa-raffle-website/package.json ./
# Only the nodejs WASM package is needed at runtime (the `kaspa` file: dep).
COPY kaspa-raffle-website/kaspa-sdk-v2.0.1/kaspa-wasm32-sdk/nodejs/kaspa/ kaspa-sdk-v2.0.1/kaspa-wasm32-sdk/nodejs/kaspa/
RUN npm install --omit=dev
COPY kaspa-raffle-website/backend/ backend/
COPY kaspa-raffle-website/covenant/ covenant/
COPY kaspa-raffle-website/index.html ./
ADD https://github.com/ph7p8fmpjr-jpg/Kaspa-Raffle/releases/download/bin-latest/raffle-cli /app/bin/raffle-cli
RUN chmod +x /app/bin/raffle-cli
ENV RAFFLE_CLI=/app/bin/raffle-cli
ENV DATA_DIR=/app/data
CMD ["node", "backend/server.js"]

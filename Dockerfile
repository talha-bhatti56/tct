
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fL --retry 3 https://github.com/i-tct/tct/releases/latest/download/tct-linux -o /app/tct-linux \
    && chmod 755 /app/tct-linux \
    && rm -rf /var/lib/apt/lists/*

COPY index.js /app/index.js

CMD ["node", "/app/index.js"]

FROM node:20-bookworm-slim

WORKDIR /app

COPY index.js /app/index.js

CMD ["node", "/app/index.js"]

FROM node:18-bookworm-slim

# Install a real system Chromium (fast, reliable apt package) instead of letting Puppeteer
# download its own private copy at npm-install time — that download has no timeout and can
# hang indefinitely on a slow/flaky connection (this is what caused the earlier stuck build).
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ca-certificates fonts-liberation \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data/uploads

ENV NODE_ENV=production
EXPOSE 3050

CMD ["node", "app.js"]

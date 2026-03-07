# force rebuild v53
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf $(which node) /usr/bin/nodejs || true && \
    ln -sf $(which node) /usr/local/bin/nodejs || true && \
    ln -sf $(which node) /usr/bin/node || true

RUN python3 -m pip install --break-system-packages --no-cache-dir yt-dlp

RUN echo "=== yt-dlp version ===" && yt-dlp --version && \
    echo "=== node ===" && node --version && \
    echo "=== nodejs ===" && nodejs --version && \
    echo "=== which nodejs ===" && which nodejs && \
    echo "=== BUILD TEST PASSED ==="

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

# Force fresh copy of source files
RUN echo "cachebust=$(date +%s)" > /tmp/cachebust
COPY . .

RUN mkdir -p /tmp/clipspeed/downloads /tmp/clipspeed/clips /tmp/clipspeed/captions

EXPOSE 8080
ENV PORT=8080
CMD ["node", "index.js"]

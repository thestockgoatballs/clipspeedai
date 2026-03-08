# force rebuild v57
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg python3 python3-pip python3-venv curl \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages --no-cache-dir yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN echo "=== FILES IN /app ===" && ls -la /app

RUN mkdir -p \
    /tmp/clipspeed/downloads \
    /tmp/clipspeed/clips \
    /tmp/clipspeed/captions \
    /tmp/clipspeed/audio \
    /tmp/clipspeed/reframe \
    /tmp/clipspeed/thumbnails

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "index.js"]

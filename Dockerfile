FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Make nodejs findable BEFORE installing yt-dlp
RUN ln -sf $(which node) /usr/bin/nodejs || true && \
    ln -sf $(which node) /usr/local/bin/nodejs || true && \
    ln -sf $(which node) /usr/bin/node || true

# Install yt-dlp via pip (gets latest version with best YouTube support)
RUN python3 -m pip install --break-system-packages --no-cache-dir yt-dlp

# Verify everything works during build
RUN echo "=== yt-dlp version ===" && yt-dlp --version && \
    echo "=== node ===" && node --version && \
    echo "=== nodejs ===" && nodejs --version && \
    echo "=== which nodejs ===" && which nodejs && \
    echo "=== Test: extract video info ===" && \
    yt-dlp --dump-json --no-download "https://www.youtube.com/watch?v=jNQXAC9IVRw" 2>&1 | head -c 500 && \
    echo "" && echo "=== BUILD TEST PASSED ==="

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --production

# Copy source code
COPY . .

# Create temp directories for video processing
RUN mkdir -p /tmp/clipspeed/downloads /tmp/clipspeed/clips /tmp/clipspeed/captions

EXPOSE 8080

CMD ["node", "index.js"]

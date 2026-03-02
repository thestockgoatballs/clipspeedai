FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp (downloads YouTube videos)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+x /usr/local/bin/yt-dlp \
    && ln -sf /usr/local/bin/node /usr/bin/nodejs \
    && ln -sf /usr/local/bin/node /usr/local/bin/nodejs

# Verify node is findable as nodejs
RUN yt-dlp --version && node --version && nodejs --version

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

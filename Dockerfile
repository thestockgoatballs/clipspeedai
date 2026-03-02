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
  && chmod a+rx /usr/local/bin/yt-dlp

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

# force rebuild v56
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg python3 python3-pip python3-venv curl && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --break-system-packages --no-cache-dir yt-dlp
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
RUN echo "=== FILES IN /app ===" && ls -la /app
RUN mkdir -p /tmp/clipspeed/downloads /tmp/clipspeed/clips /tmp/clipspeed/captions
EXPOSE 8080
ENV PORT=8080
CMD ["node", "index.js"]

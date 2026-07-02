FROM node:20-slim

# ffmpeg lets yt-dlp merge/convert the occasional stream that isn't already a
# single progressive MP4. ca-certificates + curl are needed to fetch yt-dlp.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first so this layer caches when only app code changes.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

# Fetch the Linux build of yt-dlp (bundles its own Python). The mac binary from
# the repo is excluded via .dockerignore, so this is the only yt-dlp in the image.
RUN mkdir -p /app/bin \
  && curl -L -o /app/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
  && chmod +x /app/bin/yt-dlp \
  && /app/bin/yt-dlp --version

ENV NODE_ENV=production
# Most hosts (Render, Railway, Fly) inject their own PORT; server.js honors it.
EXPOSE 3005

CMD ["node", "server.js"]

# Build context must be the SERVER REPO ROOT (needs ../prisma and the workspace lockfile).
# In Coolify: Base Directory = /, Dockerfile Location = /api/Dockerfile.
FROM oven/bun:1 AS base
WORKDIR /app

# yt-dlp and ffmpeg power /v1/video/resolve and /v1/video/transcode.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates curl ffmpeg \
    && curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Install workspace deps (root + api + gateway manifests) with the lockfile for reproducibility.
COPY package.json bun.lock ./
COPY api/package.json ./api/
COPY gateway/package.json ./gateway/
RUN bun install --frozen-lockfile

COPY . .

# Generate the Prisma client against the schema (engine is downloaded here).
RUN cd api && bunx prisma generate --schema ../prisma/schema.prisma

EXPOSE 4100

# Apply any pending migrations, then serve. Env (DATABASE_URL, REDIS_URL, secrets, B2_*,
# ACCOUNTS_*) is injected by Coolify — the app reads process.env directly, no .env file.
CMD ["sh", "-c", "cd api && bunx prisma migrate deploy --schema ../prisma/schema.prisma && bun src/index.ts"]

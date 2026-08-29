# Build context must be the SERVER REPO ROOT (needs ../prisma and the workspace lockfile).
# In Coolify: Base Directory = /, Dockerfile Location = /api/Dockerfile.
FROM oven/bun:1 AS base
WORKDIR /app

# yt-dlp and ffmpeg power /v1/video/resolve, /v1/video/session and /v1/video/transcode.
#
# ffmpeg comes from apt, NOT from the johnvansickle static tarball this used to fetch.
#
# That static build is linked against glibc statically, and a statically-linked glibc cannot
# resolve hostnames: `getaddrinfo` needs NSS, NSS needs `dlopen`, and a static binary has no
# dynamic loader. It does not fail gracefully — it SEGFAULTS. Verified on the exact artefact
# this line used to install: handed `https://test-videos.co.uk/...` it dumps core before
# printing a single frame, while the same URL through a distro ffmpeg works. Since every input
# here is a remote CDN URL that yt-dlp resolved (googlevideo.com and friends), the server-side
# transcode could never have worked; that is why Quest had no video at all rather than slow
# video. The game client hits the identical trap and works around it with
# `game/World/Video/LoopbackMediaProxy.cs`, which does DNS and TLS in .NET and relays over
# 127.0.0.1 — see the note there.
#
# The old comment justified the static build as avoiding ~400MB of dependencies. With
# --no-install-recommends the real cost is far smaller, and it is not a trade worth making
# against a feature that otherwise cannot function.
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

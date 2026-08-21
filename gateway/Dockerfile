# Build context = SERVER REPO ROOT. Coolify: Base Directory = /, Dockerfile = /gateway/Dockerfile.
FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
COPY api/package.json ./api/
COPY gateway/package.json ./gateway/
RUN bun install --frozen-lockfile

COPY . .

EXPOSE 4110

# SESSION_JWT_SECRET and REDIS_URL are injected by Coolify.
CMD ["sh", "-c", "cd gateway && bun src/index.ts"]

# Build context must be the SERVER REPO ROOT (needs ../prisma and the workspace lockfile).
# In Coolify: Base Directory = /, Dockerfile Location = /api/Dockerfile.
FROM oven/bun:1 AS base
WORKDIR /app

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

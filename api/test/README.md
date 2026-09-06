# Home and instance access integration tests

The suite exercises actual Elysia routes, JWT verification, Prisma queries, Redis grants,
and a real gateway WebSocket against disposable local datastores. It refuses any other
Postgres/Redis addresses. It never needs an accounts login or production credentials.

```sh
docker run --rm -d --name serika-ui184-test-postgres \
  -e POSTGRES_PASSWORD=serika-ui184-test -e POSTGRES_DB=serika_ui184_test \
  -p 127.0.0.1:55492:5432 postgres:17-alpine
docker run --rm -d --name serika-ui184-test-redis \
  -p 127.0.0.1:65492:6379 redis:7-alpine
DATABASE_URL=postgresql://postgres:serika-ui184-test@127.0.0.1:55492/serika_ui184_test \
  bun x prisma migrate deploy --schema prisma/schema.prisma
bun x prisma generate --schema prisma/schema.prisma
api/test/run-social-integration.sh
docker stop serika-ui184-test-postgres serika-ui184-test-redis
```

The suite deletes fixture tables and flushes Redis only at those dedicated test addresses.
The live gateway test briefly starts its own child on loopback port 41192 and stops it.

Account Home API (authenticated; `Cache-Control: private, no-store`):

- `GET /v1/users/me/home` resolves the account preference, falling back to the platform default.
- `PUT /v1/users/me/home { "worldId": "uuid" }` selects an approved, public, ready world.
- `DELETE /v1/users/me/home` clears the account preference.
- All return `{ world: { id, name, versionId, downloadUrl } | null, homeWorldId: string | null, usingDefault: boolean }`.
- The administrator's global default and `/v1/worlds/default-home` are unchanged.

Instance access keeps the schema's existing values: 0 public, 1 friends, 2 friends of
friends, 3 invite, 4 private. New private instances use `POST /v1/instances/` with
`{ "worldId": "uuid", "access": 4 }`. Only the owner may issue private invitations,
through the existing `/v1/social/invite` endpoint. The exact recipient receives a durable,
15-minute grant; copying the room ID or forwarding a world link grants nothing. Blocking
the owner denies subsequent joins. Public listings and matchmaking include only access 0.
A new instance and a newly minted join ticket receive a 90-second cleanup grace period.

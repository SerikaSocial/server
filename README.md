# Serika Social — server

Backend for [Serika Social](https://github.com/SerikaSocial). Relay-based social VR
platform: the server is authoritative over membership, moderation, rate limits and
asset access, but **not** over physics — state sync works by object ownership.

The server is a **relay**, not an authoritative simulation. Sync works by object
ownership: whoever owns an object broadcasts its state and everyone else trusts it.
The server is authoritative over the things where cheating actually matters in a
social app — membership, moderation, rate limits, asset access. The consequence that
makes this design work: **a dedicated relay and a P2P host do the same job.** Same
protocol, same ownership rules. P2P is a deployment mode, not a second netcode stack.

> For exhaustive operational rules and gotchas, see
> [`AGENTS.md`](https://github.com/SerikaSocial/server/blob/main/AGENTS.md). This
> README is the contributor onboarding doc.

## Components

| Component | Stack | Port | Status |
|---|---|---|---|
| `api` | Bun + Elysia + Prisma | 4100 | REST API — auth, avatars, worlds, friends, admin, events, video |
| `gateway` | Bun + Elysia — control WebSocket | 4110 | presence, invites, WebRTC signalling rooms |
| `allocator` | Bun | — | instance placement, promotion, migration |
| `instanced` | Rust + tokio | 4200/**udp** | the shard process: relay, tick, AOI, LOD, chat, voice forward, bandwidth budget |
| `node-agent` | Rust | — | per-box supervisor, capacity reporting |
| `assetd` | Rust | — | sandboxed upload validation / world build |
| `proto` | **submodule** → [SerikaSocial/proto](https://github.com/SerikaSocial/proto) | — | wire codec + golden corpus |

## Setup

`proto` is a submodule, and nothing builds without it:

```bash
git clone --recurse-submodules https://github.com/SerikaSocial/server.git
# already cloned?
git submodule update --init
```

Then:

```bash
cp .env.example .env
bun install
```

### Datastores

```bash
bun run up      # Postgres :5490 + Redis :6490 via infra/dev-up.sh
bun run down    # stop them
```

The `up`/`down` scripts assume [`infra`](https://github.com/SerikaSocial/infra) is
checked out as a sibling directory. See the
[`docs`](https://github.com/SerikaSocial/docs) README for the expected layout.

### Running

```bash
bun run dev:api          # API on :4100
bun run dev:gateway      # gateway WS on :4110
cargo run -p instanced   # relay on :4200/udp
bun run dev:all          # datastores + API + relay together (infra/dev-all.sh)
```

### Database

```bash
bun run db:generate      # Prisma client
bun run db:migrate       # apply migrations
bun run db:seed          # seed The Commons world
```

## The proto submodule

`proto` holds the wire codec and its golden corpus — the contract between the Rust
relay here and the C# client in [`game`](https://github.com/SerikaSocial/game). Both
repos pin it as a submodule so there is exactly one definition of the format.

Changing the protocol is a two-step dance, and the order matters:

1. Commit and push in `proto` first.
2. Bump the pin here **and** in `game`, in that order or simultaneously.

If you bump the server pin without bumping the client, deployed clients are talking a
different protocol than the relay — which is precisely the failure the corpus exists to
catch, so let it: `cargo test -p serika-proto` and the C# suite must both pass against
the same `proto` commit.

## Testing

```bash
bun run proto:test       # codec golden tests (must match C# byte-for-byte)
cargo test -p instanced  # relay integration tests (needs Redis)
```

## API routes (`api/src/routes/`)

| Route file | Area |
|---|---|
| `session.ts` | login / session JWT exchange |
| `web-auth.ts` | web OAuth flow |
| `users.ts` | user profile / me |
| `avatars.ts` | avatar upload, browse, equip (`POST /v1/avatars/:id/select`) |
| `worlds.ts` | world upload / browse |
| `assets.ts` | asset / file serving, presigned uploads |
| `instances.ts` | instance list / join tickets |
| `home.ts` | personal Home world |
| `social.ts` | friends, presence |
| `events.ts` | live events / concerts |
| `video.ts` | video resolution + transcoding (yt-dlp / ffmpeg) |
| `rtc.ts` | WebRTC ICE / signalling handoff |
| `reports.ts` `reviews.ts` `admin-review.ts` `admin-system.ts` | moderation |
| `notifications.ts` | notifications |

Supporting modules in `api/src/`: `accounts.ts` (serika-accounts client), `auth-plugin.ts`,
`db.ts`, `config.ts`, `allocator.ts`, `instance-access.ts`, `audit.ts`, `notify.ts`,
`serikascript.ts`, `pmx.ts` / `pmx_to_glb.ts` / `repair-pmx-ska.ts` (avatar conversion),
`default-home.ts`, `event-config.ts`, `seed.ts`.

## `instanced` (Rust relay)

The shard process. Sources in `instanced/src/`:

- `main.rs` — entry, config load, bind UDP.
- `server.rs` — the relay loop: tick, AOI, LOD, packet budget, chat, voice forward.
- `protocol.rs` — wire decode/encode (uses `serika-proto`).
- `ticket.rs` — join-ticket verification (`INSTANCE_TICKET_SECRET`, shared with the API).
- `lib.rs` — shared types / tests.

Key behaviours (see `AGENTS.md` for the full learned-constraint list): one user one
session (stale peers evicted on HELLO), `AvatarChanged` (0x0C) so avatar swaps reach
the room, live-event instances excluded from the stale-instance sweep, sender-chosen
LOD, and a bandwidth budget per peer.

## Critical rules

1. **Proto is the contract between Rust and C#.** The golden-vector corpus must pass
   in both `cargo test -p serika-proto` and `dotnet test` in `game/Net/Codec/Tests` —
   byte-identical. Push `proto` first, then bump pins here and in `game` together.
2. **No credentials in git.** `.env` is gitignored; copy from `.env.example`. This
   project never stores passwords — it mirrors `serika-accounts` users keyed by
   `accounts_id`.
3. **`PUBLIC_ENDPOINT` is always a domain, never a raw IP.** Local dev uses
   `localhost`; production uses a DNS A record (Cloudflare free doesn't carry UDP, so
   no CF proxy).
4. **Relay port mapping must be UDP.** A `4200:4200` TCP-only mapping silently strands
   the relay (the "stuck on Connecting" incident, 2026-08-22). The mapping must be
   `4200:4200/udp`.
5. **Read the docs before touching auth or codec.** See
   [`docs/auth-integration.md`](https://github.com/SerikaSocial/docs/blob/main/auth-integration.md)
   and `proto/pose_codec.md` — both contain empirically verified constraints.

## Related repos

- [`game`](https://github.com/SerikaSocial/game) — the Godot client.
- [`proto`](https://github.com/SerikaSocial/proto) — the wire codec contract.
- [`infra`](https://github.com/SerikaSocial/infra) — Docker, Coolify, playit, dev-up.
- [`docs`](https://github.com/SerikaSocial/docs) — architecture docs.

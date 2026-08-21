# Serika Social — server

Backend for [Serika Social](https://github.com/SerikaSocial). Relay-based social VR
platform: the server is authoritative over membership, moderation, rate limits and asset
access, but **not** over physics — state sync works by object ownership.

| Component | Stack | Port |
|---|---|---|
| `api` | Bun + Elysia + Prisma | 4100 |
| `gateway` | Bun + Elysia — control WebSocket, presence, signalling | 4110 |
| `allocator` | Bun — instance placement, promotion, migration | — |
| `instanced` | Rust + tokio — the shard process: relay, tick, AOI, voice forward | 4200 |
| `node-agent` | Rust — per-box supervisor, capacity reporting | — |
| `assetd` | Rust — sandboxed upload validation | — |
| `proto` | **submodule** → [SerikaSocial/proto](https://github.com/SerikaSocial/proto) | — |

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
../infra/dev-up.sh      # Postgres :5490, Redis :6490
bun install
cargo test -p serika-proto
```

The `up`/`down` scripts assume [`infra`](https://github.com/SerikaSocial/infra) is checked
out as a sibling directory. See the org README for the expected layout.

## The proto submodule

`proto` holds the wire codec and its golden corpus — the contract between the Rust relay
here and the C# client in [`game`](https://github.com/SerikaSocial/game). Both repos pin it
as a submodule so there is exactly one definition of the format.

Changing the protocol is a two-step dance, and the order matters:

1. Commit and push in `proto` first.
2. Bump the pin here **and** in `game`, in that order or simultaneously.

If you bump the server pin without bumping the client, deployed clients are talking a
different protocol than the relay — which is precisely the failure the corpus exists to
catch, so let it: `cargo test -p serika-proto` and the C# suite must both pass against the
same `proto` commit.

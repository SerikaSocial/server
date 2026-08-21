# Build context = SERVER REPO ROOT. Requires the `proto` submodule to be checked out
# (enable "clone submodules" in Coolify). Coolify: Base Directory = /, Dockerfile =
# /instanced/Dockerfile.
FROM rust:1-bookworm AS build
WORKDIR /app
COPY . .
# Builds the workspace member `instanced`, which depends on proto/rust.
RUN cargo build --release -p instanced

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/instanced /usr/local/bin/instanced

# The relay is UDP. Coolify must map this as a UDP port, and PUBLIC_ENDPOINT must be set to
# the host:port clients reach it on so the allocator can hand it out.
EXPOSE 4200/udp
CMD ["instanced"]

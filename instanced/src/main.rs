//! Serika Social realtime relay. Binds a UDP socket, registers as a node in Redis, and
//! relays pose/voice between clients grouped by instance. See server.rs for the model.

use std::sync::Arc;
use tokio::net::UdpSocket;

use instanced::Server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "instanced=info".into()),
        )
        .init();

    let port: u16 = std::env::var("INSTANCED_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(4200);
    let bind = format!("0.0.0.0:{port}");
    let ticket_secret = std::env::var("INSTANCE_TICKET_SECRET")
        .map_err(|_| anyhow::anyhow!("INSTANCE_TICKET_SECRET is required"))?;
    let redis_url = std::env::var("REDIS_URL").map_err(|_| anyhow::anyhow!("REDIS_URL is required"))?;
    let node_id = std::env::var("NODE_ID").unwrap_or_else(|_| format!("relay-{}", std::process::id()));

    let socket = Arc::new(UdpSocket::bind(&bind).await?);
    tracing::info!("relay listening on udp/{port} as node {node_id}");

    let client = redis::Client::open(redis_url)?;
    let redis = redis::aio::ConnectionManager::new(client).await?;

    // If PUBLIC_ENDPOINT is unset the allocator can't hand this relay to clients — warn
    // loudly rather than silently failing to receive any traffic.
    if std::env::var("PUBLIC_ENDPOINT").unwrap_or_default().is_empty() {
        tracing::warn!("PUBLIC_ENDPOINT not set — the api won't be able to route clients here");
    }

    Server::new(socket, redis, &ticket_secret, node_id).run().await
}

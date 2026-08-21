//! The relay runtime.
//!
//! M1 runs a single manager task that owns all state and the UDP socket — no locks, no
//! shared mutability. The plan's "one tokio task per instance" is the scale-out shape;
//! at M1 sizes a single event loop is simpler and correct. The seam to split on is
//! `by_instance`: each entry could become its own task fed by a per-instance channel.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use serika_proto::{PoseFrame, VoiceFrame};
use tokio::net::UdpSocket;

use crate::protocol::*;
use crate::ticket::TicketVerifier;

/// Drop a peer we haven't heard from in this long. Clients ping ~every 2s.
const PEER_TIMEOUT: Duration = Duration::from_secs(10);

struct Peer {
    peer_id: u32,
    instance_id: String,
    user_id: String,
    username: String,
    last_seen: Instant,
}

pub struct Server {
    socket: Arc<UdpSocket>,
    redis: ConnectionManager,
    verifier: TicketVerifier,
    node_id: String,

    peers: HashMap<SocketAddr, Peer>,
    /// instance_id -> the socket addresses currently in it. The fan-out set.
    by_instance: HashMap<String, Vec<SocketAddr>>,
    next_peer_id: u32,
}

impl Server {
    pub fn new(socket: Arc<UdpSocket>, redis: ConnectionManager, ticket_secret: &str, node_id: String) -> Self {
        Self {
            socket,
            redis,
            verifier: TicketVerifier::new(ticket_secret),
            node_id,
            peers: HashMap::new(),
            by_instance: HashMap::new(),
            next_peer_id: 1,
        }
    }

    pub async fn run(mut self) -> anyhow::Result<()> {
        let mut buf = vec![0u8; 2048];
        let mut sweep = tokio::time::interval(Duration::from_secs(1));
        let mut heartbeat = tokio::time::interval(Duration::from_secs(5));

        loop {
            tokio::select! {
                recv = self.socket.recv_from(&mut buf) => {
                    match recv {
                        Ok((n, from)) => {
                            if let Err(e) = self.handle(&buf[..n], from).await {
                                tracing::debug!(%from, "handle error: {e}");
                            }
                        }
                        Err(e) => tracing::warn!("recv error: {e}"),
                    }
                }
                _ = sweep.tick() => self.sweep_timeouts().await,
                _ = heartbeat.tick() => self.heartbeat().await,
            }
        }
    }

    async fn handle(&mut self, data: &[u8], from: SocketAddr) -> anyhow::Result<()> {
        let Some((&ty, payload)) = data.split_first() else { return Ok(()) };
        let Some(ty) = MsgType::from_u8(ty) else { return Ok(()) };

        match ty {
            MsgType::Hello => self.handle_hello(payload, from).await?,
            MsgType::Pose => self.handle_frame(MsgType::Pose, payload, from, validate_pose).await,
            MsgType::Voice => self.handle_frame(MsgType::Voice, payload, from, validate_voice).await,
            MsgType::Ping => {
                if let Some(p) = self.peers.get_mut(&from) {
                    p.last_seen = Instant::now();
                }
                // Echo so the client can measure RTT.
                let _ = self.socket.send_to(&[MsgType::Ping as u8], from).await;
            }
            // Server-only message types arriving from a client are ignored.
            _ => {}
        }
        Ok(())
    }

    async fn handle_hello(&mut self, payload: &[u8], from: SocketAddr) -> anyhow::Result<()> {
        // A repeated HELLO from an already-connected peer just means our WELCOME was lost —
        // resend it rather than double-joining.
        if let Some(p) = self.peers.get(&from) {
            let welcome = self.build_welcome(p.peer_id, &p.instance_id, from);
            let _ = self.socket.send_to(&welcome, from).await;
            return Ok(());
        }

        let Some(ticket) = read_hello(payload) else { return Ok(()) };
        let claims = match self.verifier.verify(ticket) {
            Ok(c) => c,
            Err(e) => {
                let _ = self.socket.send_to(&write_reject("invalid ticket"), from).await;
                anyhow::bail!("ticket verify: {e}");
            }
        };

        // Single-use: the api registered `ticket:valid:{jti}`; we atomically delete it.
        // A second connection with the same ticket finds nothing and is rejected.
        let consumed: i64 = self.redis.del(format!("ticket:valid:{}", claims.jti)).await.unwrap_or(0);
        if consumed == 0 {
            let _ = self.socket.send_to(&write_reject("ticket already used or expired"), from).await;
            anyhow::bail!("ticket replay: {}", claims.jti);
        }

        // Capacity guard against the live roster.
        let roster_key = format!("inst:{}:roster", claims.instance_id);
        let count: usize = self.redis.hlen(&roster_key).await.unwrap_or(0);
        // (capacity is enforced primarily by the api at ticket time; this is a backstop.)
        if count >= 80 {
            let _ = self.socket.send_to(&write_reject("instance full"), from).await;
            return Ok(());
        }

        let peer_id = self.next_peer_id;
        self.next_peer_id += 1;

        let peer = Peer {
            peer_id,
            instance_id: claims.instance_id.clone(),
            user_id: claims.sub.clone(),
            username: claims.username.clone(),
            last_seen: Instant::now(),
        };

        let welcome = self.build_welcome(peer_id, &claims.instance_id, from);
        let _ = self.socket.send_to(&welcome, from).await;

        // Tell everyone already here that someone joined.
        let join_msg = write_peer_join(peer_id, &claims.username);
        self.broadcast(&claims.instance_id, &join_msg, None).await;

        self.by_instance.entry(claims.instance_id.clone()).or_default().push(from);
        self.peers.insert(from, peer);

        // Reflect into the live roster and presence.
        let member = serde_json::json!({ "peerId": peer_id, "username": claims.username }).to_string();
        let _: Result<(), _> = self.redis.hset(&roster_key, &claims.sub, member).await;
        let _: Result<(), _> = self.redis.set(format!("presence:{}", claims.sub), &claims.instance_id).await;

        tracing::info!(peer_id, user = %claims.username, instance = %claims.instance_id, "joined");
        Ok(())
    }

    /// Build a WELCOME listing every OTHER peer currently in the instance.
    fn build_welcome(&self, your_id: u32, instance_id: &str, from: SocketAddr) -> Vec<u8> {
        let peers: Vec<(u32, &str)> = self
            .by_instance
            .get(instance_id)
            .map(|addrs| {
                addrs
                    .iter()
                    .filter(|a| **a != from)
                    .filter_map(|a| self.peers.get(a))
                    .map(|p| (p.peer_id, p.username.as_str()))
                    .collect()
            })
            .unwrap_or_default();
        write_welcome(your_id, &peers)
    }

    async fn handle_frame(
        &mut self,
        ty: MsgType,
        payload: &[u8],
        from: SocketAddr,
        validate: fn(&[u8]) -> bool,
    ) {
        let Some(peer) = self.peers.get_mut(&from) else { return };
        peer.last_seen = Instant::now();
        // Reject malformed frames at the edge — decoding is a trust boundary and a bad
        // frame must never reach another client.
        if !validate(payload) {
            return;
        }
        let (peer_id, instance_id) = (peer.peer_id, peer.instance_id.clone());
        let out = write_relayed(ty, peer_id, payload);
        // Ownership model: the sender is authoritative for its own avatar, so we forward
        // verbatim to everyone else. AOI/priority filtering slots in here at M2.
        self.broadcast(&instance_id, &out, Some(from)).await;
    }

    /// Send `msg` to everyone in the instance, optionally excluding one address.
    async fn broadcast(&self, instance_id: &str, msg: &[u8], except: Option<SocketAddr>) {
        let Some(addrs) = self.by_instance.get(instance_id) else { return };
        for a in addrs {
            if Some(*a) == except {
                continue;
            }
            let _ = self.socket.send_to(msg, *a).await;
        }
    }

    async fn sweep_timeouts(&mut self) {
        let now = Instant::now();
        let dead: Vec<SocketAddr> = self
            .peers
            .iter()
            .filter(|(_, p)| now.duration_since(p.last_seen) > PEER_TIMEOUT)
            .map(|(a, _)| *a)
            .collect();
        for addr in dead {
            self.remove_peer(addr).await;
        }
    }

    async fn remove_peer(&mut self, addr: SocketAddr) {
        let Some(peer) = self.peers.remove(&addr) else { return };
        if let Some(v) = self.by_instance.get_mut(&peer.instance_id) {
            v.retain(|a| *a != addr);
            if v.is_empty() {
                self.by_instance.remove(&peer.instance_id);
            }
        }
        let leave = write_peer_leave(peer.peer_id);
        self.broadcast(&peer.instance_id, &leave, None).await;

        let _: Result<(), _> = self
            .redis
            .hdel(format!("inst:{}:roster", peer.instance_id), &peer.user_id)
            .await;
        let _: Result<(), _> = self.redis.del(format!("presence:{}", peer.user_id)).await;
        tracing::info!(peer_id = peer.peer_id, user = %peer.username, "left");
    }

    /// Advertise this relay to the allocator: node membership + current load.
    /// The node hash carries a 15-second TTL so a crashed relay stops receiving traffic
    /// after one heartbeat cycle instead of lingering as a dead endpoint forever.
    async fn heartbeat(&mut self) {
        let endpoint = std::env::var("PUBLIC_ENDPOINT").unwrap_or_default();
        let load = self.peers.len();
        let node_key = format!("node:{}", self.node_id);
        let _: Result<(), _> = self.redis.sadd("nodes", &self.node_id).await;
        let _: Result<(), _> = self
            .redis
            .hset_multiple(
                &node_key,
                &[("endpoint", endpoint.as_str()), ("load", &load.to_string())],
            )
            .await;
        let _: Result<(), _> = self.redis.expire(&node_key, 15).await;
    }
}

fn validate_pose(payload: &[u8]) -> bool {
    PoseFrame::decode(payload).is_ok()
}

fn validate_voice(payload: &[u8]) -> bool {
    VoiceFrame::decode(payload).is_ok()
}

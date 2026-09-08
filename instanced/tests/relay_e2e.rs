//! End-to-end relay test: two clients join with real tickets and one sees the other's pose.
//!
//! Requires a reachable Redis at $REDIS_URL (the live Coolify instance in dev). It uses a
//! unique instance id per run so it never collides with real rosters, and cleans up after
//! itself. Skips (passes) if Redis is unreachable so it doesn't break offline builds.

use std::sync::Arc;
use std::time::Duration;

use instanced::protocol::write_hello;
use instanced::Server;
use jsonwebtoken::{encode, EncodingKey, Header};
use redis::AsyncCommands;
use serde::Serialize;
use serika_proto::{Lod, PoseFrame};
use tokio::net::UdpSocket;

const SECRET: &str = "test-ticket-secret";

#[derive(Serialize)]
struct Claims<'a> {
    sub: &'a str,
    #[serde(rename = "instanceId")]
    instance_id: &'a str,
    username: &'a str,
    #[serde(rename = "avatarId")]
    avatar_id: Option<&'a str>,
    jti: &'a str,
    iss: &'a str,
    aud: &'a str,
    exp: usize,
    iat: usize,
}

fn mint(instance: &str, sub: &str, username: &str, jti: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as usize;
    let claims = Claims {
        sub,
        instance_id: instance,
        username,
        avatar_id: None,
        jti,
        iss: "serika-social",
        aud: "instanced",
        exp: now + 60,
        iat: now,
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(SECRET.as_bytes())).unwrap()
}

async fn recv_typed(sock: &UdpSocket, want: u8, tries: u32) -> Option<Vec<u8>> {
    let mut buf = vec![0u8; 2048];
    for _ in 0..tries {
        match tokio::time::timeout(Duration::from_millis(500), sock.recv(&mut buf)).await {
            Ok(Ok(n)) if n > 0 && buf[0] == want => return Some(buf[..n].to_vec()),
            Ok(Ok(_)) => continue, // some other message; keep looking
            _ => return None,
        }
    }
    None
}

#[tokio::test]
async fn two_clients_relay_pose() {
    let redis_url = match std::env::var("REDIS_URL") {
        Ok(u) => u,
        Err(_) => {
            eprintln!("REDIS_URL unset — skipping e2e");
            return;
        }
    };
    let client = redis::Client::open(redis_url).unwrap();
    let mut mgr = match redis::aio::ConnectionManager::new(client).await {
        Ok(m) => m,
        Err(e) => {
            eprintln!("redis unreachable ({e}) — skipping e2e");
            return;
        }
    };

    let instance = format!("test-inst-{}", std::process::id());
    let (jti_a, jti_b) = ("jti-a-test", "jti-b-test");
    // The api would have registered these; do it directly here.
    let _: () = mgr.set(format!("ticket:valid:{jti_a}"), &instance).await.unwrap();
    let _: () = mgr.set(format!("ticket:valid:{jti_b}"), &instance).await.unwrap();

    // Boot the relay on an ephemeral port.
    let server_sock = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
    let server_addr = server_sock.local_addr().unwrap();
    let srv = Server::new(server_sock, mgr.clone(), SECRET, "test-node".into());
    tokio::spawn(srv.run());

    // Two clients connect.
    let a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    a.connect(server_addr).await.unwrap();
    let b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    b.connect(server_addr).await.unwrap();

    a.send(&write_hello(&mint(&instance, "user-a", "alice", jti_a))).await.unwrap();
    let welcome_a = recv_typed(&a, 0x02, 4).await.expect("alice gets WELCOME");
    // WELCOME: [type][your_id u32][n u16]... alice is first, so zero existing peers.
    let peers_in_a = u16::from_le_bytes([welcome_a[5], welcome_a[6]]);
    assert_eq!(peers_in_a, 0, "alice should see no existing peers");

    b.send(&write_hello(&mint(&instance, "user-b", "bob", jti_b))).await.unwrap();
    let welcome_b = recv_typed(&b, 0x02, 4).await.expect("bob gets WELCOME");
    let peers_in_b = u16::from_le_bytes([welcome_b[5], welcome_b[6]]);
    assert_eq!(peers_in_b, 1, "bob should see alice already present");

    // Alice should have received a PEER_JOIN for bob.
    let join = recv_typed(&a, 0x03, 4).await.expect("alice sees bob join");
    let bob_peer_id = u32::from_le_bytes([join[1], join[2], join[3], join[4]]);

    // Alice sends a pose; bob should receive it relayed, tagged with alice's peer id.
    let pose = PoseFrame {
        lod: Lod::Body,
        sequence: 5,
        root_pos: [1.0, 0.0, 2.0],
        root_rot: [0.0, 0.0, 0.0, 1.0],
        bones: vec![[0.0, 0.0, 0.0, 1.0]; Lod::Body.bone_count()],
        hands: [[0.0; 3]; 2],
    };
    let mut pose_msg = vec![0x05u8];
    pose_msg.extend_from_slice(&pose.encode());
    a.send(&pose_msg).await.unwrap();

    let relayed = recv_typed(&b, 0x05, 6).await.expect("bob receives alice's pose");
    let sender_id = u32::from_le_bytes([relayed[1], relayed[2], relayed[3], relayed[4]]);
    let decoded = PoseFrame::decode(&relayed[5..]).expect("valid pose payload");
    assert_eq!(decoded.sequence, 5);
    assert_ne!(sender_id, bob_peer_id, "relayed pose is from alice, not bob");

    // Roster reflects both users.
    let roster: std::collections::HashMap<String, String> =
        mgr.hgetall(format!("inst:{instance}:roster")).await.unwrap();
    assert!(roster.contains_key("user-a"));
    assert!(roster.contains_key("user-b"));

    // Closing one event kicks its guests and invalidates outstanding tickets.
    let _: () = mgr.set_ex(format!("inst:{instance}:closed"), "1", 30).await.unwrap();
    recv_typed(&a, 0x08, 8).await.expect("event closure rejects alice");
    recv_typed(&b, 0x08, 8).await.expect("event closure rejects bob");
    let _: () = mgr.set("ticket:valid:jti-rejoin-test", &instance).await.unwrap();
    a.send(&write_hello(&mint(&instance, "user-a", "alice", "jti-rejoin-test"))).await.unwrap();
    recv_typed(&a, 0x08, 8).await.expect("closed instance rejects a fresh ticket");
    let _: () = mgr.del(format!("inst:{instance}:closed")).await.unwrap();
    let _: () = mgr.del("ticket:valid:jti-rejoin-test").await.unwrap();

    // Cleanup.
    let _: () = mgr.del(format!("inst:{instance}:roster")).await.unwrap();
    let _: () = mgr.del("presence:user-a").await.unwrap();
    let _: () = mgr.del("presence:user-b").await.unwrap();
}

/// A reconnecting client arrives from a NEW source address, and the relay keys peers by
/// SocketAddr while keying every piece of Redis state by user id. Before the eviction in
/// `handle_hello` this produced, in order: a duplicate ghost peer for the same user, and then —
/// when the abandoned session hit PEER_TIMEOUT — a `remove_peer` that deleted the roster and
/// presence entries belonging to the session that had REPLACED it. The player was still sitting
/// in the world, but had vanished from the roster, so the API's stale-instance sweep was free to
/// close a populated instance.
///
/// This drives the real relay: two sockets for the same user, and an observer who must see
/// exactly one join for the reconnection and a leave for the ghost.
#[tokio::test]
async fn reconnect_from_new_address_replaces_the_old_session() {
    let redis_url = match std::env::var("REDIS_URL") {
        Ok(u) => u,
        Err(_) => { eprintln!("REDIS_URL unset — skipping"); return; }
    };
    let client = redis::Client::open(redis_url).unwrap();
    let mut mgr = match redis::aio::ConnectionManager::new(client).await {
        Ok(m) => m,
        Err(e) => { eprintln!("redis unreachable ({e}) — skipping: {e}"); return; }
    };

    let instance = format!("test-recon-{}", std::process::id());
    for jti in ["jti-r-obs", "jti-r-1", "jti-r-2"] {
        let _: () = mgr.set(format!("ticket:valid:{jti}"), &instance).await.unwrap();
    }

    let server_sock = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
    let server_addr = server_sock.local_addr().unwrap();
    let srv = Server::new(server_sock, mgr.clone(), SECRET, "test-node".into());
    tokio::spawn(srv.run());

    // An observer already in the instance, so we can watch what the OTHER players are told.
    let obs = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    obs.connect(server_addr).await.unwrap();
    obs.send(&write_hello(&mint(&instance, "user-obs", "obs", "jti-r-obs"))).await.unwrap();
    recv_typed(&obs, 0x02, 4).await.expect("observer gets WELCOME");

    // The player joins, then "reconnects" from a brand-new socket — a new source address, which
    // is exactly what a fresh UdpClient (or a NAT rebind) looks like to the relay.
    let first = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    first.connect(server_addr).await.unwrap();
    first.send(&write_hello(&mint(&instance, "user-x", "xan", "jti-r-1"))).await.unwrap();
    recv_typed(&first, 0x02, 4).await.expect("first session gets WELCOME");
    let join1 = recv_typed(&obs, 0x03, 4).await.expect("observer sees the first join");
    let peer1 = u32::from_le_bytes([join1[1], join1[2], join1[3], join1[4]]);

    let second = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    second.connect(server_addr).await.unwrap();
    second.send(&write_hello(&mint(&instance, "user-x", "xan", "jti-r-2"))).await.unwrap();
    let welcome2 = recv_typed(&second, 0x02, 4).await.expect("second session gets WELCOME");
    let peer2 = u32::from_le_bytes([welcome2[1], welcome2[2], welcome2[3], welcome2[4]]);
    assert_ne!(peer1, peer2, "the reconnection is a distinct peer id");

    // The observer must be told the ghost left, or it renders two copies of this player.
    let leave = recv_typed(&obs, 0x04, 6).await.expect("observer is told the ghost left");
    let left_id = u32::from_le_bytes([leave[1], leave[2], leave[3], leave[4]]);
    assert_eq!(left_id, peer1, "it is the ABANDONED session that leaves, not the live one");

    // The reconnected session must still own the roster: this is the entry the API's sweep
    // reads to decide whether an instance is empty.
    let roster: std::collections::HashMap<String, String> =
        mgr.hgetall(format!("inst:{instance}:roster")).await.unwrap();
    assert!(roster.contains_key("user-x"), "the reconnected player is still on the roster");
    let member = &roster["user-x"];
    assert!(member.contains(&format!("\"peerId\":{peer2}")),
        "the roster names the LIVE session, got {member}");

    // The second session is the one that works: its pose must reach the observer.
    let pose = PoseFrame {
        lod: Lod::Body, sequence: 9, root_pos: [0.0, 0.0, 0.0], root_rot: [0.0, 0.0, 0.0, 1.0],
        bones: vec![[0.0, 0.0, 0.0, 1.0]; Lod::Body.bone_count()], hands: [[0.0; 3]; 2],
    };
    let mut msg = vec![0x05u8];
    msg.extend_from_slice(&pose.encode());
    second.send(&msg).await.unwrap();
    let relayed = recv_typed(&obs, 0x05, 6).await.expect("observer receives the reconnected pose");
    let sender = u32::from_le_bytes([relayed[1], relayed[2], relayed[3], relayed[4]]);
    assert_eq!(sender, peer2, "poses now come from the live session");

    let _: () = mgr.del(format!("inst:{instance}:roster")).await.unwrap();
    for u in ["user-x", "user-obs"] { let _: () = mgr.del(format!("presence:{u}")).await.unwrap(); }
}

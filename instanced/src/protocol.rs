//! The relay's transport envelope.
//!
//! M1 uses raw UDP datagrams rather than ENet. The plan named ENet (built into Godot), but
//! matching Godot's ENetMultiplayerPeer wire protocol from Rust is a project in itself,
//! whereas raw UDP is fully under our control on both ends and the `ISerikaTransport`
//! abstraction in the client hides which one is in use. The pose/voice *payloads* are still
//! the shared `serika-proto` codec, so the cross-language golden guarantee is unaffected —
//! only the framing around them is local to this transport.
//!
//! Every datagram is `[type: u8][payload...]`. Pose and voice are sent unreliable (a lost
//! frame is stale in 50ms anyway); HELLO is retransmitted by the client until it sees
//! WELCOME. There is no general reliability layer in M1 — control messages are idempotent.

pub const MTU: usize = 1200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MsgType {
    /// client→server: `[ticket_len: u16][ticket bytes]`
    Hello = 0x01,
    /// server→client: `[your_peer_id: u32][n: u16]` then n × `[peer_id: u32][name_len: u8][name]`
    Welcome = 0x02,
    /// server→client: `[peer_id: u32][name_len: u8][name]`
    PeerJoin = 0x03,
    /// server→client: `[peer_id: u32]`
    PeerLeave = 0x04,
    /// client→server: `[pose codec bytes]` · server→client: `[peer_id: u32][pose codec bytes]`
    Pose = 0x05,
    /// same shape as Pose but carrying a voice frame
    Voice = 0x06,
    /// either direction, no payload — keepalive + RTT probe
    Ping = 0x07,
    /// server→client: `[reason_len: u8][reason]` — ticket rejected, instance full, etc.
    Reject = 0x08,
    /// client→server: `[utf8 text]` · server→client: `[peer_id: u32][utf8 text]`
    /// A world text-chat line. Fanned out to the whole instance (no AOI) like a control message.
    Chat = 0x09,
    /// client→server: `[obj_id: u16][x: f32][y: f32][z: f32][qx: f32][qy: f32][qz: f32][qw: f32][lvx: f32][lvy: f32][lvz: f32]`
    /// server→client: `[peer_id: u32][obj_id: u16][x: f32][y: f32][z: f32][qx: f32][qy: f32][qz: f32][qw: f32][lvx: f32][lvy: f32][lvz: f32]`
    /// Syncs a physics prop's transform + linear velocity. Ownership is implicit: whoever last
    /// sent an ObjectSync for a given obj_id owns it. Server fans out to all peers in AOI range.
    ObjectSync = 0x0A,
    /// client→server: `[grab_type: u8][target_peer: u32][bone_or_obj_id: u16][x: f32][y: f32][z: f32]`
    /// server→client: `[peer_id: u32][grab_type: u8][bone_or_obj_id: u16][x: f32][y: f32][z: f32]`
    /// grab_type: 0=start grab, 1=update grab position, 2=release grab
    /// Used for hair/PhysBone grabbing and physics prop grabbing on other players.
    PhysGrab = 0x0B,
    /// client→server: no payload · server→client: `[peer_id: u32]`
    /// "I changed avatar." Deliberately carries neither a url nor an id: receivers re-read the
    /// sender's avatar from the API by user id, which is already the source of truth, so a
    /// malicious client cannot aim everyone else's downloader at a url of its choosing.
    /// Fanned out to the whole instance like Chat — AOI does not apply, since a peer across the
    /// room still has to stop rendering the old model.
    AvatarChanged = 0x0C,
}

impl MsgType {
    pub fn from_u8(b: u8) -> Option<Self> {
        Some(match b {
            0x01 => Self::Hello,
            0x02 => Self::Welcome,
            0x03 => Self::PeerJoin,
            0x04 => Self::PeerLeave,
            0x05 => Self::Pose,
            0x06 => Self::Voice,
            0x07 => Self::Ping,
            0x08 => Self::Reject,
            0x09 => Self::Chat,
            0x0A => Self::ObjectSync,
            0x0B => Self::PhysGrab,
            0x0C => Self::AvatarChanged,
            _ => return None,
        })
    }
}

pub fn write_hello(ticket: &str) -> Vec<u8> {
    let t = ticket.as_bytes();
    let mut out = Vec::with_capacity(3 + t.len());
    out.push(MsgType::Hello as u8);
    out.extend_from_slice(&(t.len() as u16).to_le_bytes());
    out.extend_from_slice(t);
    out
}

/// peers: (peer_id, user_id, username)
pub fn write_welcome(your_id: u32, peers: &[(u32, &str, &str)]) -> Vec<u8> {
    let mut out = vec![MsgType::Welcome as u8];
    out.extend_from_slice(&your_id.to_le_bytes());
    out.extend_from_slice(&(peers.len() as u16).to_le_bytes());
    for (id, uid, name) in peers {
        out.extend_from_slice(&id.to_le_bytes());
        let u = uid.as_bytes();
        out.push(u.len().min(255) as u8);
        out.extend_from_slice(&u[..u.len().min(255)]);
        let n = name.as_bytes();
        out.push(n.len().min(255) as u8);
        out.extend_from_slice(&n[..n.len().min(255)]);
    }
    out
}

pub fn write_peer_join(id: u32, user_id: &str, name: &str) -> Vec<u8> {
    let mut out = vec![MsgType::PeerJoin as u8];
    out.extend_from_slice(&id.to_le_bytes());
    let u = user_id.as_bytes();
    out.push(u.len().min(255) as u8);
    out.extend_from_slice(&u[..u.len().min(255)]);
    let n = name.as_bytes();
    out.push(n.len().min(255) as u8);
    out.extend_from_slice(&n[..n.len().min(255)]);
    out
}

pub fn write_peer_leave(id: u32) -> Vec<u8> {
    let mut out = vec![MsgType::PeerLeave as u8];
    out.extend_from_slice(&id.to_le_bytes());
    out
}

pub fn write_reject(reason: &str) -> Vec<u8> {
    let mut out = vec![MsgType::Reject as u8];
    let r = reason.as_bytes();
    out.push(r.len().min(255) as u8);
    out.extend_from_slice(&r[..r.len().min(255)]);
    out
}

/// Re-frame an inbound Pose/Voice payload for fan-out by prefixing the sender's peer id.
pub fn write_relayed(ty: MsgType, sender: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(ty as u8);
    out.extend_from_slice(&sender.to_le_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn read_hello(payload: &[u8]) -> Option<&str> {
    if payload.len() < 2 {
        return None;
    }
    let len = u16::from_le_bytes([payload[0], payload[1]]) as usize;
    let bytes = payload.get(2..2 + len)?;
    std::str::from_utf8(bytes).ok()
}

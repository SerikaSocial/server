import { redis } from "./db.ts";

// Instance placement. In M1 there is a single dedicated relay and every instance is
// dedicated, but the decision logic and node registry are already here so P2P and
// multi-node slot in later without reshaping callers.

const P2P_MAX_CAPACITY = 12;

export interface Placement {
  mode: number; // 0=p2p 1=dedicated
  nodeId: string;
  endpoint: string;
}

export interface HostHints {
  capacity: number;
  forceDedicated: boolean;
  natType?: "open" | "moderate" | "symmetric";
  uplinkMbps?: number;
}

/// Decide whether a new instance is P2P or dedicated. The rules match docs: small,
/// non-forced, well-connected hosts get P2P; everything else is dedicated.
export function decideMode(h: HostHints): number {
  if (h.forceDedicated) return 1;
  if (h.capacity > P2P_MAX_CAPACITY) return 1;
  if (h.natType === "symmetric") return 1; // TURN-relayed hosts defeat the P2P savings
  if (h.uplinkMbps !== undefined && h.uplinkMbps < 5) return 1;
  return 0;
}

/// Registry of relay nodes. A node-agent registers its process under `node:{id}` with a
/// TTL heartbeat; we read the set to place instances. In M1 a single relay self-registers.
/// Stale members (whose node:{id} hash has expired) are pruned from the set so dead relays
/// don't accumulate.
export async function pickDedicatedNode(): Promise<{ nodeId: string; endpoint: string } | null> {
  const ids = await redis.smembers("nodes");
  if (ids.length === 0) return null;
  // Least-loaded by advertised player count. Ties broken arbitrarily.
  let best: { nodeId: string; endpoint: string; load: number } | null = null;
  const stale: string[] = [];
  for (const id of ids) {
    const info = await redis.hgetall(`node:${id}`);
    if (!info.endpoint) {
      // The node hash expired (relay crashed or stopped heartbeating) — remove from set.
      stale.push(id);
      continue;
    }
    const load = Number(info.load ?? 0);
    if (!best || load < best.load) best = { nodeId: id, endpoint: info.endpoint, load };
  }
  if (stale.length > 0) {
    await redis.srem("nodes", ...stale);
  }
  return best ? { nodeId: best.nodeId, endpoint: best.endpoint } : null;
}

export async function place(h: HostHints): Promise<Placement | null> {
  const mode = decideMode(h);
  // Even a P2P instance needs a fallback dedicated target for when it gets promoted, and
  // in M1 the client always connects to the relay, so we resolve a node regardless.
  const node = await pickDedicatedNode();
  if (!node) return null;
  return { mode, nodeId: node.nodeId, endpoint: node.endpoint };
}

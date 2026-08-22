import { Elysia } from "elysia";
import { authed } from "../auth-plugin.ts";
import { config } from "../config.ts";

// ICE server discovery for P2P (WebRTC) instances. The client fetches this right before it opens
// a peer connection so TURN credentials are as fresh as possible. Ported from serika-cord's voice
// stack: STUN alone only traverses permissive NATs, so a TURN relay is provided for the common
// symmetric-NAT case. Priority: Cloudflare Worker (fresh creds per join) > env coturn > STUN only.

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export async function buildIceServers(): Promise<IceServer[]> {
  const servers: IceServer[] = [];

  if (config.rtc.turnWorkerUrl) {
    try {
      const res = await fetch(config.rtc.turnWorkerUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { iceServers?: IceServer[] };
        if (Array.isArray(data.iceServers) && data.iceServers.length) servers.push(...data.iceServers);
      }
    } catch {
      // Worker unreachable — fall through to env TURN / STUN.
    }
  }

  if (servers.length === 0) {
    const stun = config.rtc.stunUrls.split(",").map((u) => u.trim()).filter(Boolean);
    if (stun.length) servers.push({ urls: stun });
    if (config.rtc.turnUrl) {
      servers.push({
        urls: config.rtc.turnUrl.split(",").map((u) => u.trim()).filter(Boolean),
        username: config.rtc.turnUsername || undefined,
        credential: config.rtc.turnPassword || undefined,
      });
    }
  }

  return servers;
}

export const rtcRoutes = new Elysia({ prefix: "/v1/rtc" })
  .use(authed)
  // The game calls this before joining a P2P instance and feeds the result into its PeerConnections.
  .get("/ice", async () => ({ iceServers: await buildIceServers() }));

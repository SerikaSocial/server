import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { config } from "./config.ts";

export const prisma = new PrismaClient();

export const redis = new Redis(config.redisUrl, {
  // Fail fast rather than hanging a request if Redis is unreachable — presence is not
  // worth blocking an HTTP handler for.
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redis.on("error", (e) => console.error("[redis]", e.message));

/// Redis key helpers. Rosters and presence are ephemeral and live only here.
export const keys = {
  /// Hash: field per member userId -> JSON {joinedAt, avatarId}.
  instanceRoster: (instanceId: string) => `inst:${instanceId}:roster`,
  /// String: which instance a user is currently in (for presence + friend "join" ).
  userPresence: (userId: string) => `presence:${userId}`,
  /// Set of online user ids.
  onlineUsers: "online:users",
  /// Consumed-ticket guard so a join ticket cannot be replayed.
  ticketUsed: (jti: string) => `ticket:used:${jti}`,
};

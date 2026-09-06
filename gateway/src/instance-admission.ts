/** The API issues this short grant only after checking instance access. A connected relay
 * member may reconnect signalling after its grant expires. Never trust a client room ID. */
export async function hasInstanceAdmission(redis: {
  get(key: string): Promise<string | null>;
  hexists(key: string, field: string): Promise<number>;
}, instanceId: unknown, userId: string): Promise<boolean> {
  if (typeof instanceId !== "string" || !/^[0-9a-f-]{36}$/i.test(instanceId)) return false;
  try {
    return !!await redis.hexists(`inst:${instanceId}:roster`, userId)
      || await redis.get(`instance:admission:${instanceId}:${userId}`) === "1";
  } catch { return false; }
}

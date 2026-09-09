import type { PrismaClient } from "@prisma/client";
import { transition } from "./event-config.ts";

type EventStore = Pick<PrismaClient, "liveEvent">;

export async function finishExpiredEvents(store: EventStore, now = Date.now()): Promise<number> {
  const events = await store.liveEvent.findMany({
    where: { status: "live", startedAt: { not: null } },
    select: { id: true, status: true, revision: true, startedAt: true, config: true },
  });
  let finished = 0;
  for (const event of events) {
    const duration = (event.config as { duration?: number } | null)?.duration;
    if (!event.startedAt || typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0
      || now < event.startedAt.getTime() + duration * 1000) continue;
    const result = await store.liveEvent.updateMany({
      where: { id: event.id, status: "live", revision: event.revision, startedAt: event.startedAt },
      data: { status: transition(event.status, "stop"), startedAt: null, revision: { increment: 1 } },
    });
    finished += result.count;
  }
  return finished;
}

export function startEventCompletion(store: EventStore): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const count = await finishExpiredEvents(store);
      if (count) console.log(`[events] automatically stopped ${count} completed show(s); doors remain open`);
    } catch (error) {
      console.error("[events] completion check failed", error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 1000);
  timer.unref();
  return () => clearInterval(timer);
}

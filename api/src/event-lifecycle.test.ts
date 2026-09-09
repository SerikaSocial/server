import { expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { finishExpiredEvents } from "./event-lifecycle.ts";

function fixture(duration = 502.408) {
  const event = { id: "show", status: "live", revision: 40, startedAt: new Date(10000) as Date | null, config: { duration } };
  const writes: any[] = [];
  const instance = { closedAt: null, members: ["attendee"] };
  const store = { liveEvent: {
    findMany: async () => event.status === "live" ? [{ ...event }] : [],
    updateMany: async ({ where, data }: any) => {
      writes.push({ where, data });
      if (event.status !== where.status || event.revision !== where.revision || event.startedAt?.getTime() !== where.startedAt?.getTime()) return { count: 0 };
      Object.assign(event, data, { revision: event.revision + data.revision.increment });
      return { count: 1 };
    },
  } };
  return { event, writes, instance, store: store as unknown as Pick<PrismaClient, "liveEvent"> };
}

test("completion waits through the authored end hold and opens rather than closes doors", async () => {
  const f = fixture();
  expect(await finishExpiredEvents(f.store, 500408)).toBe(0);
  expect(await finishExpiredEvents(f.store, 512407)).toBe(0);
  expect(f.writes).toHaveLength(0);
  expect(await finishExpiredEvents(f.store, 512408)).toBe(1);
  expect(f.event).toMatchObject({ status: "open", startedAt: null, revision: 41 });
  expect(f.instance).toEqual({ closedAt: null, members: ["attendee"] });
  expect(await finishExpiredEvents(f.store, 600000)).toBe(0);
  expect(f.writes).toHaveLength(1);
});

test("startup catches an overdue show and concurrent API workers finish it only once", async () => {
  const f = fixture();
  const counts = await Promise.all([finishExpiredEvents(f.store, 900000), finishExpiredEvents(f.store, 900000)]);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  expect(f.event.revision).toBe(41);
});

test("completion cannot overwrite a newer play, manual stop or close", async () => {
  for (const status of ["live", "open", "ended"]) {
    const f = fixture();
    const read = f.store.liveEvent.findMany;
    f.store.liveEvent.findMany = (async () => {
      const result = await read();
      f.event.status = status;
      f.event.revision++;
      f.event.startedAt = status === "live" ? new Date(800000) : null;
      return result;
    }) as typeof read;
    expect(await finishExpiredEvents(f.store, 900000)).toBe(0);
    expect(f.event.status).toBe(status);
    expect(f.event.revision).toBe(41);
  }
});

test("countdown, missing clocks and malformed durations never auto-stop", async () => {
  for (const duration of [NaN, Infinity, -1, 0]) {
    const f = fixture(duration);
    expect(await finishExpiredEvents(f.store, 900000)).toBe(0);
    expect(f.writes).toHaveLength(0);
  }
  const f = fixture();
  expect(await finishExpiredEvents(f.store, 9999)).toBe(0);
  f.event.startedAt = null;
  expect(await finishExpiredEvents(f.store, 900000)).toBe(0);
});

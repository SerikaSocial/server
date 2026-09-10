/**
 * Server-authoritative game sessions (Among Us-style hidden role, and elimination rounds).
 *
 * The single most important property in this file: **a player is only ever told what they are
 * allowed to know.** `/me` returns your own role. `/state` returns phase and counts. Neither ever
 * returns the role map, until the game is over and it no longer matters. This is not defence in
 * depth, it is the entire game — the relay is not an authoritative sim and a client that receives
 * the imposter's identity has already lost it, no matter what the UI does with it.
 *
 * Every rule lives in gamemode.ts and is evaluated here against Redis state. The client's copy of
 * those rules is a UI affordance: it greys out a kill button, and the server decides anyway.
 *
 * State is Redis-only and expires with the instance — a session is live state, not a durable
 * record, exactly like the roster and presence.
 */
import { Elysia, t } from "elysia";
import { authed } from "../auth-plugin.ts";
import { prisma, redis } from "../db.ts";
import {
  assignRoles,
  canKill,
  evaluateGauntlet,
  evaluateImposter,
  GameMode,
  MEETING_SECONDS,
  MIN_PLAYERS_GAUNTLET,
  MIN_PLAYERS_IMPOSTER,
  Outcome,
  Phase,
  resolveRound,
  Role,
  TASKS_PER_CREW,
  tallyVotes,
  type ImposterSnapshot,
  type PhaseId,
} from "../gamemode.ts";

/// Sessions live as long as a long game plus slack, then evaporate. Nothing here is durable.
const SESSION_TTL_SECONDS = 60 * 60 * 3;

const k = {
  meta: (i: string) => `game:${i}:meta`,
  roles: (i: string) => `game:${i}:roles`,
  alive: (i: string) => `game:${i}:alive`,
  tasks: (i: string) => `game:${i}:tasks`,
  votes: (i: string) => `game:${i}:votes`,
  lastKill: (i: string, u: string) => `game:${i}:kill:${u}`,
  round: (i: string) => `game:${i}:round`,
  finished: (i: string) => `game:${i}:finished`,
  events: (i: string) => `game:${i}:events`,
};

async function touchTtl(instanceId: string) {
  await Promise.all(
    Object.values(k).map((f) =>
      typeof f === "function" && f.length === 1
        ? redis.expire((f as (i: string) => string)(instanceId), SESSION_TTL_SECONDS)
        : Promise.resolve(),
    ),
  );
}

/// Append to a small public event log the clients poll. Deliberately public-safe: a kill event
/// names the VICTIM, never the killer, because "who did it" is the thing being played for.
async function pushEvent(instanceId: string, event: Record<string, unknown>) {
  await redis.lpush(k.events(instanceId), JSON.stringify({ ...event, at: Date.now() }));
  await redis.ltrim(k.events(instanceId), 0, 49);
  await redis.expire(k.events(instanceId), SESSION_TTL_SECONDS);
}

async function loadSnapshot(instanceId: string): Promise<ImposterSnapshot> {
  const [roles, alive, tasks] = await Promise.all([
    redis.hgetall(k.roles(instanceId)),
    redis.hgetall(k.alive(instanceId)),
    redis.hgetall(k.tasks(instanceId)),
  ]);
  return {
    roles: new Map(Object.entries(roles).map(([u, r]) => [u, Number(r) as 0 | 1])),
    alive: new Set(Object.entries(alive).filter(([, v]) => v === "1").map(([u]) => u)),
    tasks: new Map(Object.entries(tasks).map(([u, n]) => [u, Number(n)])),
  };
}

async function getMeta(instanceId: string) {
  const m = await redis.hgetall(k.meta(instanceId));
  if (!m.phase) return null;
  return {
    mode: Number(m.mode),
    phase: Number(m.phase) as PhaseId,
    outcome: Number(m.outcome ?? 0),
    startedAt: Number(m.startedAt ?? 0),
    meetingEndsAt: Number(m.meetingEndsAt ?? 0),
    round: Number(m.round ?? 0),
    maxRounds: Number(m.maxRounds ?? 3),
    hostId: m.hostId ?? "",
  };
}

/// Re-check win conditions and persist an ending. Called after every state change.
async function settleImposter(instanceId: string): Promise<number> {
  const snap = await loadSnapshot(instanceId);
  const outcome = evaluateImposter(snap);
  if (outcome !== Outcome.None) {
    await redis.hset(k.meta(instanceId), { phase: String(Phase.Ended), outcome: String(outcome) });
    // Only now is the role map safe to reveal.
    await pushEvent(instanceId, {
      type: "ended",
      outcome,
      roles: Object.fromEntries(snap.roles),
    });
  }
  return outcome;
}

async function requireMember(instanceId: string, userId: string) {
  const inRoster = await redis.hexists(`inst:${instanceId}:roster`, userId);
  return inRoster === 1;
}

export const gameRoutes = new Elysia({ prefix: "/v1/games" })
  .use(authed)
  .onBeforeHandle(({ set }) => { set.headers["Cache-Control"] = "private, no-store"; })

  /// Start a session. Only the instance owner may start one, and only from the live roster —
  /// the caller does not get to supply the player list.
  .post(
    "/:id/start",
    async ({ params, body, session, set }) => {
      if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }

      const instance = await prisma.instance.findUnique({ where: { id: params.id } });
      if (!instance || instance.closedAt) { set.status = 404; return { error: "instance_not_found" }; }
      if (instance.ownerId !== session.sub) {
        const me = await prisma.user.findUnique({ where: { id: session.sub }, select: { isAdmin: true } });
        if (!me?.isAdmin) { set.status = 403; return { error: "not_host" }; }
      }

      const existing = await getMeta(params.id);
      if (existing && existing.phase !== Phase.Ended) { set.status = 409; return { error: "already_running" }; }

      // The roster is the source of truth for who is playing. A client-supplied list would let a
      // host invent players or omit one to skew role odds.
      const roster = await redis.hkeys(`inst:${params.id}:roster`);
      const mode = body.mode === GameMode.Gauntlet ? GameMode.Gauntlet : GameMode.Imposter;
      const min = mode === GameMode.Imposter ? MIN_PLAYERS_IMPOSTER : MIN_PLAYERS_GAUNTLET;
      if (roster.length < min) {
        set.status = 409;
        return { error: "not_enough_players", need: min, have: roster.length };
      }

      const pipeline = redis.pipeline();
      for (const key of [k.roles, k.alive, k.tasks, k.votes, k.finished, k.events]) {
        pipeline.del(key(params.id));
      }

      if (mode === GameMode.Imposter) {
        const roles = assignRoles(roster);
        pipeline.hset(k.roles(params.id), Object.fromEntries([...roles].map(([u, r]) => [u, String(r)])));
      }
      pipeline.hset(k.alive(params.id), Object.fromEntries(roster.map((u) => [u, "1"])));
      pipeline.hset(k.meta(params.id), {
        mode: String(mode),
        phase: String(Phase.Playing),
        outcome: "0",
        startedAt: String(Date.now()),
        meetingEndsAt: "0",
        round: "1",
        maxRounds: String(Math.max(1, Math.min(10, Number(body.rounds ?? 3)))),
        hostId: session.sub,
      });
      await pipeline.exec();
      await touchTtl(params.id);
      await pushEvent(params.id, { type: "started", mode, players: roster.length });

      return { ok: true, mode, players: roster.length };
    },
    { body: t.Object({ mode: t.Optional(t.Number()), rounds: t.Optional(t.Number()) }) },
  )

  /// What THIS player is allowed to know: their own role, their own liveness, their own progress.
  /// Never anyone else's role.
  .get("/:id/me", async ({ params, session, set }) => {
    if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
    const meta = await getMeta(params.id);
    if (!meta) { set.status = 404; return { error: "no_session" }; }

    const [role, alive, tasks, lastKill] = await Promise.all([
      redis.hget(k.roles(params.id), session.sub),
      redis.hget(k.alive(params.id), session.sub),
      redis.hget(k.tasks(params.id), session.sub),
      redis.get(k.lastKill(params.id, session.sub)),
    ]);

    // A player not in the session gets a null role rather than a 403 — spectators exist, and
    // leaking "you are not in this game" vs "you are crew" through a status code is a tell.
    return {
      role: role === null ? null : Number(role),
      alive: alive === "1",
      tasks: Number(tasks ?? 0),
      tasksRequired: TASKS_PER_CREW,
      killReadyAt: lastKill ? Number(lastKill) + 25_000 : 0,
      phase: meta.phase,
    };
  })

  /// Public state. Counts and phase only — never the role map while the game is live.
  .get("/:id/state", async ({ params, session, set }) => {
    if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
    const meta = await getMeta(params.id);
    if (!meta) { set.status = 404; return { error: "no_session" }; }

    const snap = await loadSnapshot(params.id);
    const events = (await redis.lrange(k.events(params.id), 0, 24)).map((e) => JSON.parse(e));

    return {
      mode: meta.mode,
      phase: meta.phase,
      outcome: meta.outcome,
      round: meta.round,
      maxRounds: meta.maxRounds,
      alive: [...snap.alive],
      aliveCount: snap.alive.size,
      totalPlayers: snap.roles.size || snap.alive.size,
      meetingEndsAt: meta.meetingEndsAt,
      events,
    };
  })

  /// Complete one task. The server counts; a client cannot report a total.
  .post("/:id/task", async ({ params, session, set }) => {
    if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
    const meta = await getMeta(params.id);
    if (!meta || meta.phase !== Phase.Playing) { set.status = 409; return { error: "not_playing" }; }

    const [role, alive] = await Promise.all([
      redis.hget(k.roles(params.id), session.sub),
      redis.hget(k.alive(params.id), session.sub),
    ]);
    if (alive !== "1") { set.status = 409; return { error: "dead" }; }
    // An imposter "completing" tasks must not advance the crew's win condition.
    if (Number(role) !== Role.Crew) { set.status = 403; return { error: "not_crew" }; }

    const done = await redis.hincrby(k.tasks(params.id), session.sub, 1);
    // Clamp so a burst of requests cannot overshoot and skew the win check.
    if (done > TASKS_PER_CREW) await redis.hset(k.tasks(params.id), session.sub, String(TASKS_PER_CREW));

    const outcome = await settleImposter(params.id);
    return { tasks: Math.min(done, TASKS_PER_CREW), required: TASKS_PER_CREW, outcome };
  })

  /// Attempt a kill. Every condition is checked here.
  .post(
    "/:id/kill",
    async ({ params, body, session, set }) => {
      if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
      const meta = await getMeta(params.id);
      if (!meta) { set.status = 404; return { error: "no_session" }; }

      const snap = await loadSnapshot(params.id);
      const last = Number((await redis.get(k.lastKill(params.id, session.sub))) ?? 0);
      const since = last === 0 ? Number.MAX_SAFE_INTEGER : (Date.now() - last) / 1000;

      const reason = canKill(session.sub, body.targetId, snap, meta.phase, since, body.distance ?? 0);
      if (reason) { set.status = 409; return { error: reason }; }

      await redis.hset(k.alive(params.id), body.targetId, "0");
      await redis.set(k.lastKill(params.id, session.sub), String(Date.now()), "EX", SESSION_TTL_SECONDS);
      // Names the victim, never the killer.
      await pushEvent(params.id, { type: "died", userId: body.targetId });

      const outcome = await settleImposter(params.id);
      return { ok: true, outcome };
    },
    { body: t.Object({ targetId: t.String(), distance: t.Optional(t.Number()) }) },
  )

  /// Call a meeting. Anyone alive may.
  .post("/:id/report", async ({ params, session, set }) => {
    if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
    const meta = await getMeta(params.id);
    if (!meta || meta.phase !== Phase.Playing) { set.status = 409; return { error: "not_playing" }; }
    if ((await redis.hget(k.alive(params.id), session.sub)) !== "1") { set.status = 409; return { error: "dead" }; }

    const endsAt = Date.now() + MEETING_SECONDS * 1000;
    await redis.del(k.votes(params.id));
    await redis.hset(k.meta(params.id), { phase: String(Phase.Meeting), meetingEndsAt: String(endsAt) });
    await pushEvent(params.id, { type: "meeting", by: session.sub, endsAt });
    return { ok: true, endsAt };
  })

  /// Cast a vote. One per player per meeting; a re-vote replaces the previous one.
  .post(
    "/:id/vote",
    async ({ params, body, session, set }) => {
      if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
      const meta = await getMeta(params.id);
      if (!meta || meta.phase !== Phase.Meeting) { set.status = 409; return { error: "not_meeting" }; }
      if ((await redis.hget(k.alive(params.id), session.sub)) !== "1") { set.status = 409; return { error: "dead" }; }

      await redis.hset(k.votes(params.id), session.sub, body.targetId);

      // Resolve early once everyone alive has voted, rather than making a decided room wait.
      const snap = await loadSnapshot(params.id);
      const votes = await redis.hgetall(k.votes(params.id));
      const voted = Object.keys(votes).filter((u) => snap.alive.has(u)).length;
      if (voted >= snap.alive.size) return await closeMeeting(params.id);

      return { ok: true, voted, of: snap.alive.size };
    },
    { body: t.Object({ targetId: t.String() }) },
  )

  /// End a meeting: on timeout, or when the host closes it.
  .post("/:id/close-meeting", async ({ params, session, set }) => {
    if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
    const meta = await getMeta(params.id);
    if (!meta || meta.phase !== Phase.Meeting) { set.status = 409; return { error: "not_meeting" }; }
    // Anyone may trigger the close, but only once the clock has actually run out — otherwise a
    // single player could cut short a discussion they were losing.
    if (Date.now() < meta.meetingEndsAt && meta.hostId !== session.sub) {
      set.status = 409;
      return { error: "meeting_running", endsAt: meta.meetingEndsAt };
    }
    return await closeMeeting(params.id);
  })

  /// Gauntlet: report reaching the finish line. The SERVER assigns placement by arrival order,
  /// so a client cannot claim a better position than it earned.
  .post("/:id/finish", async ({ params, session, set }) => {
    if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
    const meta = await getMeta(params.id);
    if (!meta || meta.mode !== GameMode.Gauntlet || meta.phase !== Phase.Playing) {
      set.status = 409; return { error: "not_playing" };
    }
    if ((await redis.hget(k.alive(params.id), session.sub)) !== "1") { set.status = 409; return { error: "eliminated" }; }
    if (!await requireMember(params.id, session.sub)) { set.status = 403; return { error: "not_in_instance" }; }

    // A list, appended once per player: the first report wins and later ones are ignored.
    const already = await redis.lpos(k.finished(params.id), session.sub);
    if (already !== null) return { ok: true, place: already + 1, duplicate: true };

    await redis.rpush(k.finished(params.id), session.sub);
    const place = await redis.llen(k.finished(params.id));
    await pushEvent(params.id, { type: "finished", userId: session.sub, place });
    return { ok: true, place };
  })

  /// Gauntlet: close the round, eliminate the slowest, and either start the next or end it.
  .post("/:id/end-round", async ({ params, session, set }) => {
    if (!session?.sub) { set.status = 401; return { error: "unauthorized" }; }
    const meta = await getMeta(params.id);
    if (!meta || meta.mode !== GameMode.Gauntlet) { set.status = 409; return { error: "not_gauntlet" }; }
    if (meta.hostId !== session.sub) { set.status = 403; return { error: "not_host" }; }

    const snap = await loadSnapshot(params.id);
    const finished = await redis.lrange(k.finished(params.id), 0, -1);
    const { qualified, eliminated } = resolveRound({ entrants: [...snap.alive], finished });

    const pipeline = redis.pipeline();
    for (const u of eliminated) pipeline.hset(k.alive(params.id), u, "0");
    pipeline.del(k.finished(params.id));
    await pipeline.exec();

    const outcome = evaluateGauntlet(qualified, meta.round, meta.maxRounds);
    if (outcome !== Outcome.None) {
      await redis.hset(k.meta(params.id), { phase: String(Phase.Ended), outcome: String(outcome) });
      await pushEvent(params.id, { type: "ended", outcome, winners: qualified });
    } else {
      await redis.hset(k.meta(params.id), { round: String(meta.round + 1) });
      await pushEvent(params.id, { type: "round", round: meta.round + 1, qualified, eliminated });
    }
    return { qualified, eliminated, outcome, round: meta.round + 1 };
  });

/// Tally, eject, and check the result. Shared by the timeout path and the everyone-voted path.
async function closeMeeting(instanceId: string) {
  const snap = await loadSnapshot(instanceId);
  const raw = await redis.hgetall(k.votes(instanceId));
  const result = tallyVotes(new Map(Object.entries(raw)), snap.alive);

  if (result.ejected) {
    await redis.hset(k.alive(instanceId), result.ejected, "0");
  }
  await redis.del(k.votes(instanceId));
  await redis.hset(k.meta(instanceId), { phase: String(Phase.Playing), meetingEndsAt: "0" });

  // The ejected player's role is revealed — that information is the point of the vote. Everyone
  // else's stays secret.
  const ejectedRole = result.ejected ? snap.roles.get(result.ejected) ?? null : null;
  await pushEvent(instanceId, {
    type: "ejected",
    userId: result.ejected,
    role: ejectedRole,
    tied: result.tied,
    counts: result.counts,
    skips: result.skips,
  });

  const outcome = await settleImposter(instanceId);
  return { ejected: result.ejected, tied: result.tied, role: ejectedRole, outcome };
}

import { describe, expect, test } from "bun:test";
import {
  assignRoles,
  canKill,
  evaluateGauntlet,
  evaluateImposter,
  imposterCount,
  Outcome,
  Phase,
  resolveRound,
  Role,
  survivorsForRound,
  tallyVotes,
  TASKS_PER_CREW,
  KILL_COOLDOWN_SECONDS,
  type ImposterSnapshot,
} from "./gamemode.ts";

/// Deterministic RNG so a shuffle is assertable.
///
/// mulberry32, not a bare LCG. A textbook LCG's first output is a near-linear function of its
/// seed, so walking consecutive seeds walks the first draw in lockstep — with six players that
/// left one seat never drawing the imposter across 200 deals and looked exactly like a biased
/// shuffle. (It wasn't: the shuffle is uniform to within noise over 20k deals on this RNG,
/// on that LCG, and on Math.random.) The lesson is that a weak test RNG can fabricate a bug.
function seededRng(seed = 1) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const snap = (
  roles: Record<string, number>,
  alive: string[],
  tasks: Record<string, number> = {},
): ImposterSnapshot => ({
  roles: new Map(Object.entries(roles) as [string, 0 | 1][]),
  alive: new Set(alive),
  tasks: new Map(Object.entries(tasks)),
});

describe("role assignment", () => {
  test("imposter count scales with lobby size and never takes everyone", () => {
    expect(imposterCount(4)).toBe(1);
    expect(imposterCount(6)).toBe(1);
    expect(imposterCount(7)).toBe(2);
    expect(imposterCount(9)).toBe(3);
    // A one-player lobby cannot have an imposter, or the game ends the instant it starts.
    expect(assignRoles(["a"], seededRng()).get("a")).toBe(Role.Crew);
  });

  test("assigns exactly the expected number of imposters", () => {
    for (const n of [4, 5, 6, 7, 8, 9, 10]) {
      const ids = Array.from({ length: n }, (_, i) => `u${i}`);
      const roles = assignRoles(ids, seededRng(n));
      const imps = [...roles.values()].filter((r) => r === Role.Imposter).length;
      expect(imps).toBe(imposterCount(n));
      expect(roles.size).toBe(n);
    }
  });

  test("the imposter is not always the same seat", () => {
    // Guards against a broken shuffle. `sort(() => rng() - 0.5)` would concentrate the role on a
    // few positions; over many deals every seat should get it at least once.
    const ids = Array.from({ length: 6 }, (_, i) => `u${i}`);
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const roles = assignRoles(ids, seededRng(seed));
      for (const [id, r] of roles) if (r === Role.Imposter) seen.add(id);
    }
    expect(seen.size).toBe(ids.length);
  });
});

describe("imposter win conditions", () => {
  test("crew win when the last imposter is gone", () => {
    expect(evaluateImposter(snap({ a: 1, b: 0, c: 0, d: 0 }, ["b", "c", "d"]))).toBe(Outcome.CrewWin);
  });

  test("imposters win on parity, not on elimination", () => {
    // 1 imposter, 1 crew: the imposter can no longer be out-voted, so it is already decided.
    expect(evaluateImposter(snap({ a: 1, b: 0, c: 0 }, ["a", "b"]))).toBe(Outcome.ImposterWin);
  });

  test("game continues while crew outnumber imposters", () => {
    expect(evaluateImposter(snap({ a: 1, b: 0, c: 0, d: 0 }, ["a", "b", "c", "d"]))).toBe(Outcome.None);
  });

  test("crew win by completing every living crewmate's tasks", () => {
    const s = snap(
      { a: 1, b: 0, c: 0, d: 0 },
      ["a", "b", "c", "d"],
      { b: TASKS_PER_CREW, c: TASKS_PER_CREW, d: TASKS_PER_CREW },
    );
    expect(evaluateImposter(s)).toBe(Outcome.CrewWin);
  });

  test("a dead crewmate's tasks neither block nor grant the task win", () => {
    // `c` is dead with zero tasks. The two living crew are done, so the crew should win —
    // counting the dead player's requirement would make the win unreachable.
    const s = snap(
      { a: 1, b: 0, c: 0, d: 0, e: 0 },
      ["a", "b", "d", "e"],
      { b: TASKS_PER_CREW, d: TASKS_PER_CREW, e: TASKS_PER_CREW, c: 0 },
    );
    expect(evaluateImposter(s)).toBe(Outcome.CrewWin);

    // And a dead player's COMPLETED tasks must not carry a living crew over the line.
    const s2 = snap(
      { a: 1, b: 0, c: 0, d: 0, e: 0 },
      ["a", "b", "d", "e"],
      { b: TASKS_PER_CREW, d: TASKS_PER_CREW, e: 1, c: TASKS_PER_CREW },
    );
    expect(evaluateImposter(s2)).toBe(Outcome.None);
  });

  test("over-reported task counts cannot exceed the requirement", () => {
    // A client that claims 999 tasks must not win the game on its own.
    const s = snap({ a: 1, b: 0, c: 0, d: 0 }, ["a", "b", "c", "d"], { b: 999 });
    expect(evaluateImposter(s)).toBe(Outcome.None);
  });
});

describe("voting", () => {
  const alive = new Set(["a", "b", "c", "d"]);

  test("a clear majority ejects", () => {
    const r = tallyVotes(new Map([["a", "c"], ["b", "c"], ["d", "c"]]), alive);
    expect(r.ejected).toBe("c");
    expect(r.tied).toBe(false);
  });

  test("a tie ejects nobody", () => {
    const r = tallyVotes(new Map([["a", "c"], ["b", "d"]]), alive);
    expect(r.ejected).toBeNull();
    expect(r.tied).toBe(true);
  });

  test("skips winning ejects nobody", () => {
    const r = tallyVotes(new Map([["a", "skip"], ["b", "skip"], ["c", "d"]]), alive);
    expect(r.ejected).toBeNull();
    expect(r.skips).toBe(2);
  });

  test("a skip tie with the top vote ejects nobody", () => {
    // Deliberate: skip >= top means no ejection. Ejecting on equal counts would make skipping
    // strictly worse than voting, which is not the intent.
    const r = tallyVotes(new Map([["a", "skip"], ["b", "c"]]), alive);
    expect(r.ejected).toBeNull();
  });

  test("votes from and for the dead are discarded", () => {
    // `z` is not alive: their vote must not count, and votes for them must not either.
    const r = tallyVotes(
      new Map([["z", "c"], ["a", "z"], ["b", "c"], ["d", "c"]]),
      alive,
    );
    expect(r.ejected).toBe("c");
    expect(r.counts["c"]).toBe(2); // z's vote for c discarded
    expect(r.counts["z"]).toBeUndefined();
  });

  test("no votes at all ejects nobody", () => {
    const r = tallyVotes(new Map(), alive);
    expect(r.ejected).toBeNull();
    expect(r.tied).toBe(true);
  });
});

describe("kill authorisation", () => {
  const s = snap({ imp: 1, imp2: 1, crew: 0, dead: 0 }, ["imp", "imp2", "crew"]);

  test("a valid kill is allowed", () => {
    expect(canKill("imp", "crew", s, Phase.Playing, 999, 1.0)).toBeNull();
  });

  test("crew cannot kill", () => {
    expect(canKill("crew", "imp", s, Phase.Playing, 999, 1.0)).toBe("not_imposter");
  });

  test("imposters cannot kill each other", () => {
    expect(canKill("imp", "imp2", s, Phase.Playing, 999, 1.0)).toBe("target_imposter");
  });

  test("the dead cannot kill and cannot be killed", () => {
    expect(canKill("imp", "dead", s, Phase.Playing, 999, 1.0)).toBe("target_dead");
    const s2 = snap({ imp: 1, crew: 0 }, ["crew"]);
    expect(canKill("imp", "crew", s2, Phase.Playing, 999, 1.0)).toBe("killer_dead");
  });

  test("no killing during a meeting or before the game starts", () => {
    expect(canKill("imp", "crew", s, Phase.Meeting, 999, 1.0)).toBe("not_playing");
    expect(canKill("imp", "crew", s, Phase.Lobby, 999, 1.0)).toBe("not_playing");
  });

  test("the cooldown is enforced server-side", () => {
    expect(canKill("imp", "crew", s, Phase.Playing, KILL_COOLDOWN_SECONDS - 1, 1.0)).toBe("cooldown");
    expect(canKill("imp", "crew", s, Phase.Playing, KILL_COOLDOWN_SECONDS, 1.0)).toBeNull();
  });

  test("an absurd distance is rejected, including NaN", () => {
    expect(canKill("imp", "crew", s, Phase.Playing, 999, 50)).toBe("too_far");
    // NaN fails every comparison, so a naive `d > MAX` check would ACCEPT it.
    expect(canKill("imp", "crew", s, Phase.Playing, 999, NaN)).toBe("too_far");
  });

  test("nobody can kill themselves", () => {
    expect(canKill("imp", "imp", s, Phase.Playing, 999, 0)).toBe("self");
  });
});

describe("gauntlet rounds", () => {
  test("always cuts at least one while more than one remains", () => {
    for (let n = 2; n <= 32; n++) {
      const s = survivorsForRound(n);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThan(n);
    }
    expect(survivorsForRound(1)).toBe(1);
  });

  test("finishers qualify in order and the rest are out", () => {
    const r = resolveRound({ entrants: ["a", "b", "c", "d", "e"], finished: ["c", "a", "e"] });
    expect(r.qualified).toEqual(["c", "a", "e"]); // ceil(5*0.6) = 3
    expect(r.eliminated.sort()).toEqual(["b", "d"]);
  });

  test("a late finisher past the seat count does not qualify", () => {
    const r = resolveRound({ entrants: ["a", "b", "c", "d"], finished: ["a", "b", "c", "d"] });
    expect(r.qualified).toEqual(["a", "b", "c"]); // ceil(4*0.6) = 3
    expect(r.eliminated).toEqual(["d"]);
  });

  test("duplicate finish reports cannot take two seats", () => {
    const r = resolveRound({ entrants: ["a", "b", "c", "d"], finished: ["a", "a", "a", "b"] });
    expect(r.qualified).toEqual(["a", "b"]);
  });

  test("a finish from someone not in the round is ignored", () => {
    const r = resolveRound({ entrants: ["a", "b"], finished: ["zz", "a"] });
    expect(r.qualified).toEqual(["a"]);
    expect(r.eliminated).toEqual(["b"]);
  });

  test("nobody finishing eliminates the whole field", () => {
    const r = resolveRound({ entrants: ["a", "b", "c"], finished: [] });
    expect(r.qualified).toEqual([]);
    expect(evaluateGauntlet(r.qualified, 1, 3)).toBe(Outcome.Abandoned);
  });

  test("one player left wins", () => {
    expect(evaluateGauntlet(["a"], 1, 3)).toBe(Outcome.GauntletWin);
    expect(evaluateGauntlet(["a", "b"], 1, 3)).toBe(Outcome.None);
    expect(evaluateGauntlet(["a", "b"], 3, 3)).toBe(Outcome.GauntletWin);
  });
});

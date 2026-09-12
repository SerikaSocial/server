/**
 * Server-authoritative game-session logic.
 *
 * WHY THIS EXISTS AT ALL. Sync in this project works by object ownership: whoever owns a thing
 * broadcasts its state and everyone trusts it, and the relay is explicitly not an authoritative
 * sim. That is the right trade for a social space, and it is the *wrong* trade for a hidden-role
 * game. If a client is told who the imposter is — even to render a name tag — the game is over
 * for anyone willing to read their own memory. So role assignment, kills, votes and win
 * conditions live here, on the server, and a client is only ever told what that specific player
 * is allowed to know.
 *
 * This module is deliberately PURE: no Redis, no Prisma, no Elysia. Every rule that decides who
 * wins is a function of its arguments, so it can be tested exhaustively without standing up a
 * world. routes/games.ts owns the I/O and calls in here for every decision.
 */

/// What kind of session this is. The modes share phases and membership; they
/// differ in what ends a round.
export const GameMode = {
  /// Hidden role. Crew complete tasks, imposters kill, meetings eject.
  Imposter: 0,
  /// Elimination race. Each round, the slowest are cut until a winner remains.
  Gauntlet: 1,
  Rope: 2,
} as const;
export type GameModeId = (typeof GameMode)[keyof typeof GameMode];

export const Phase = {
  Lobby: 0,
  /// Imposter: free play. Gauntlet: a round is running.
  Playing: 1,
  /// Imposter only: discussion + voting.
  Meeting: 2,
  Ended: 3,
} as const;
export type PhaseId = (typeof Phase)[keyof typeof Phase];

export const Role = {
  Crew: 0,
  Imposter: 1,
} as const;
export type RoleId = (typeof Role)[keyof typeof Role];

export const Outcome = {
  None: 0,
  CrewWin: 1,
  ImposterWin: 2,
  /// Gauntlet: a single player remains, or the last round finished.
  GauntletWin: 3,
  /// Not enough players left to continue meaningfully.
  Abandoned: 4,
  RopeWin: 5,
} as const;
export type OutcomeId = (typeof Outcome)[keyof typeof Outcome];

export const MIN_PLAYERS_IMPOSTER = 4;
export const MIN_PLAYERS_GAUNTLET = 1; // one player runs the same three stages as a time trial
export function minimumPlayers(mode: number): number { return mode === GameMode.Imposter ? 4 : 1; }
export function validGameMode(mode: number): boolean { return mode === 0 || mode === 1 || mode === 2; }
export function validFinish(round: number, startedAt: number, expectedRound: number, expectedStart: number,
  roundStart: number, now: number): boolean {
  return round === expectedRound && startedAt === expectedStart && now >= roundStart + 3000;
}
export function evaluateRope(entrants: string[], finished: string[]): OutcomeId {
  if (entrants.length === 0) return Outcome.Abandoned;
  return entrants.every(id => finished.includes(id)) ? Outcome.RopeWin : Outcome.None;
}

/// Tasks each crewmate must finish before the crew win by task completion.
export const TASKS_PER_CREW = 5;
export const STATION_TASK_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export function validStationTask(taskId: number): boolean {
  return Number.isInteger(taskId) && STATION_TASK_IDS.includes(taskId as typeof STATION_TASK_IDS[number]);
}

/// Seconds an imposter must wait between kills. Server-enforced: the client asks, the server
/// decides. A client-side cooldown is a suggestion.
export const KILL_COOLDOWN_SECONDS = 25;

/// How long a meeting runs before votes are tallied.
export const MEETING_SECONDS = 45;

/// A kill is rejected if the killer claims to be further than this from the victim. This is a
/// SANITY bound, not a security boundary: positions are client-reported (same posture as `rms`
/// in the pose codec) and a modified client can lie about its own. It exists to stop an honest
/// client's stale position from registering an absurd kill, and to make a cheater's traffic
/// obviously wrong rather than subtly wrong. Real proximity enforcement would need the relay to
/// track authoritative positions, which it does not.
export const KILL_MAX_DISTANCE = 3.0;

/// How many imposters for a given lobby size. Kept small deliberately: two imposters in a
/// five-player game is not a deduction game, it is a coin flip.
export function imposterCount(playerCount: number): number {
  if (playerCount >= 9) return 3;
  if (playerCount >= 7) return 2;
  return 1;
}

/// Assign roles. `rng` returns [0,1) and is injected so tests are deterministic — a shuffle that
/// can only be observed through real randomness cannot be asserted on.
///
/// Fisher-Yates, not sort-by-random: `sort(() => rng() - 0.5)` is a classic broken shuffle whose
/// bias is heavily implementation-dependent, and "the imposter is usually whoever joined third"
/// is the kind of bug nobody reports and everybody notices.
export function assignRoles(
  userIds: string[],
  rng: () => number = Math.random,
): Map<string, RoleId> {
  const shuffled = [...userIds];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  const imposters = Math.min(imposterCount(userIds.length), Math.max(0, userIds.length - 1));
  const roles = new Map<string, RoleId>();
  shuffled.forEach((id, idx) => roles.set(id, idx < imposters ? Role.Imposter : Role.Crew));
  return roles;
}

export interface ImposterSnapshot {
  roles: Map<string, RoleId>;
  /// Everyone still playing (not ejected, not killed).
  alive: Set<string>;
  /// userId -> tasks completed.
  tasks: Map<string, number>;
}

/// Decide whether the game is over, and how. Called after every state change — a kill, an
/// ejection, a task, a disconnect.
export function evaluateImposter(s: ImposterSnapshot): OutcomeId {
  let aliveImposters = 0;
  let aliveCrew = 0;
  for (const id of s.alive) {
    if (s.roles.get(id) === Role.Imposter) aliveImposters++;
    else aliveCrew++;
  }

  if (aliveImposters === 0) return Outcome.CrewWin;

  // Parity, not elimination: once imposters equal crew they can no longer be out-voted, so the
  // game is decided. Playing it out just wastes everyone's time.
  if (aliveImposters >= aliveCrew) return Outcome.ImposterWin;

  // Task win counts only LIVING crew: a dead crewmate's unfinished tasks must not make the win
  // unreachable, and their completed ones must not count toward it either.
  let required = 0;
  let done = 0;
  for (const id of s.alive) {
    if (s.roles.get(id) !== Role.Crew) continue;
    required += TASKS_PER_CREW;
    done += Math.min(s.tasks.get(id) ?? 0, TASKS_PER_CREW);
  }
  if (required > 0 && done >= required) return Outcome.CrewWin;

  return Outcome.None;
}

export interface VoteTally {
  /// userId to eject, or null for a skip/tie.
  ejected: string | null;
  /// True when the vote tied or skip won — nobody leaves, and that is a normal outcome.
  tied: boolean;
  counts: Record<string, number>;
  skips: number;
}

/// Tally a meeting. `votes` maps voter -> target, where the literal "skip" is a skip.
///
/// A tie ejects NOBODY. Picking a winner from a tie (lowest id, first voter, whatever) is a
/// silent thumb on the scale that players cannot see and cannot reason about.
export function tallyVotes(votes: Map<string, string>, alive: Set<string>): VoteTally {
  const counts: Record<string, number> = {};
  let skips = 0;

  for (const [voter, target] of votes) {
    // Votes from the dead, and votes for the dead or for non-players, are discarded rather than
    // counted — otherwise a disconnect mid-meeting silently changes the result.
    if (!alive.has(voter)) continue;
    if (target === "skip") { skips++; continue; }
    if (!alive.has(target)) continue;
    counts[target] = (counts[target] ?? 0) + 1;
  }

  let top: string | null = null;
  let topCount = 0;
  let tied = false;
  for (const [id, n] of Object.entries(counts)) {
    if (n > topCount) { top = id; topCount = n; tied = false; }
    else if (n === topCount) tied = true;
  }

  if (top === null || topCount === 0) return { ejected: null, tied: true, counts, skips };
  if (skips >= topCount) return { ejected: null, tied: true, counts, skips };
  if (tied) return { ejected: null, tied: true, counts, skips };

  return { ejected: top, tied: false, counts, skips };
}

/// May this player kill this target right now? Returns null when allowed, or a machine-readable
/// reason when not. Every one of these is checked server-side; the client's own copy of these
/// rules is a UI affordance, nothing more.
export function canKill(
  killerId: string,
  targetId: string,
  s: ImposterSnapshot,
  phase: PhaseId,
  secondsSinceLastKill: number,
  claimedDistance: number,
): string | null {
  if (phase !== Phase.Playing) return "not_playing";
  if (killerId === targetId) return "self";
  if (s.roles.get(killerId) !== Role.Imposter) return "not_imposter";
  if (!s.alive.has(killerId)) return "killer_dead";
  if (!s.alive.has(targetId)) return "target_dead";
  // Imposters cannot kill each other — it is never a strategy, only a grief.
  if (s.roles.get(targetId) === Role.Imposter) return "target_imposter";
  if (secondsSinceLastKill < KILL_COOLDOWN_SECONDS) return "cooldown";
  if (!(claimedDistance >= 0 && claimedDistance <= KILL_MAX_DISTANCE)) return "too_far"; // NaN-safe
  return null;
}

// ── Gauntlet (elimination race) ───────────────────────────────────────────────────────────────

/// How many players survive a round given how many started it. Cuts larger fields while preserving a two-player final,
/// and never cuts everybody — a round that eliminates the entire field
/// leaves no winner and no way to end.
export function survivorsForRound(entrants: number): number {
  if (entrants <= 1) return entrants;
  if (entrants === 2) return 2; // keep a two-player show alive until the final arena
  return Math.max(1, Math.ceil(entrants * 0.6));
}

export interface GauntletRound {
  /// Finish order, earliest first. Only players who actually finished.
  finished: string[];
  /// Everyone who started the round.
  entrants: string[];
}

/// Who survives a round. Finishers qualify in order; anyone who did not finish is out.
///
/// Finish ORDER is the authoritative record and the server assigns it on arrival, so a client
/// cannot claim a better placement after the fact.
export function resolveRound(round: GauntletRound, finalRound = false): { qualified: string[]; eliminated: string[] } {
  const entrants = [...new Set(round.entrants)];
  const seats = finalRound ? Math.min(1, entrants.length) : survivorsForRound(entrants.length);

  const qualified: string[] = [];
  for (const id of round.finished) {
    if (!entrants.includes(id)) continue;      // not in this round
    if (qualified.includes(id)) continue;      // duplicate finish report
    if (qualified.length >= seats) break;
    qualified.push(id);
  }

  const eliminated = entrants.filter((id) => !qualified.includes(id));
  return { qualified, eliminated };
}

export function evaluateGauntlet(remaining: string[], roundsPlayed: number, maxRounds: number): OutcomeId {
  if (remaining.length === 0) return Outcome.Abandoned;
  if (roundsPlayed >= maxRounds) return Outcome.GauntletWin;
  return Outcome.None;
}

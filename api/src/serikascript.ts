// SerikaScript bytecode container — the artifact the SDK compiles and the client VM executes.
// The server never runs it; it only *validates* it here (defense in depth: on submit and again
// at publish). The C# VM (game/Script/) and this validator MUST agree on the opcode + host-call
// allowlists byte-for-byte — that agreement is the sandbox boundary.
//
// Container layout (little-endian):
//   magic      4 bytes  "SSKB"
//   version    u8       currently 2
//   flags      u8       reserved (0)
//   budgetTick u16      declared per-tick instruction budget
//   budgetMem  u16      declared allocation ceiling (KiB)
//   nHostCalls u16      count of host-call ids referenced
//   hostCalls  nHostCalls * u16   each a host-call id (must be on ALLOWED_HOST_CALLS)
//   nEntries   u16      entry-point table count
//   entries    nEntries * (u8 hookId, u32 codeOffset)
//   nStrings   u16      string table count
//   strings    nStrings * (u16 byteLen, byteLen bytes UTF-8)
//   codeLen    u32      length of the code section
//   code       codeLen bytes       opcode stream; each op is [u8 opcode][operands]
//
// v2 added the entry-point and string tables. v1 had neither, which meant the execution model in
// docs/serikascript.md §4 — on_ready / on_tick(dt) / on_interact(player) / zone hooks — was not
// expressible at all: there was one flat code section, execution always began at offset 0, and a
// hook argument had nowhere to live. v1 is rejected outright rather than migrated; nothing had
// shipped, so there is no compatibility to keep and one supported shape is one less thing to get
// wrong at a trust boundary.
//
// This module is the single source of truth for the allowlists and caps on the server side.

export const SSKB_MAGIC = 0x53_53_4b_42; // "SSKB"
export const SSKB_VERSION = 2;

/// Event hooks a module may define. The VM dispatches these; a script never "runs" as a whole.
/// Keep in lockstep with HookId in game/Script/OpCode.cs.
export const HookId = {
  ON_READY: 0x00, // ()
  ON_TICK: 0x01, // (dt)
  ON_INTERACT: 0x02, // (playerIndex)
  ON_ENTER_ZONE: 0x03, // (playerIndex, zoneId)
  ON_EXIT_ZONE: 0x04, // (playerIndex, zoneId)
  ON_MESSAGE: 0x05, // (nameId, payload)
} as const;

export const ALLOWED_HOOKS: Set<number> = new Set(Object.values(HookId));

/// How many arguments each hook receives. The VM places them in locals 0..n-1 on entry, so a
/// script reads them with LOAD — there is no separate parameter mechanism.
export const HOOK_ARITY: Record<number, number> = {
  [HookId.ON_READY]: 0,
  [HookId.ON_TICK]: 1,
  [HookId.ON_INTERACT]: 1,
  [HookId.ON_ENTER_ZONE]: 2,
  [HookId.ON_EXIT_ZONE]: 2,
  [HookId.ON_MESSAGE]: 2,
};

/// Ceilings on the tables themselves. A container that declares 60k strings is a resource attack
/// before a single opcode executes.
export const MAX_STRINGS = 256;
export const MAX_STRING_BYTES = 512;
export const MAX_ENTRIES = 16;

/// The complete opcode set. No dynamic dispatch, no eval, no indirect calls outside HOST_CALL.
/// Keep this in lockstep with game/Script/OpCode.cs.
export const OpCode = {
  NOP: 0x00,
  PUSH_I: 0x01, // + i32
  PUSH_F: 0x02, // + f32
  PUSH_NIL: 0x03,
  POP: 0x04,
  DUP: 0x05,
  LOAD: 0x06, // + u8 local slot
  STORE: 0x07, // + u8 local slot
  ADD: 0x10, SUB: 0x11, MUL: 0x12, DIV: 0x13, MOD: 0x14, NEG: 0x15,
  EQ: 0x20, NE: 0x21, LT: 0x22, LE: 0x23, GT: 0x24, GE: 0x25,
  AND: 0x26, OR: 0x27, NOT: 0x28,
  JMP: 0x30, // + i16 rel
  JMP_IF: 0x31, // + i16 rel (pops cond)
  JMP_IFNOT: 0x32, // + i16 rel
  HOST_CALL: 0x40, // + u16 host-call id, + u8 argc
  RET: 0x50,
  HALT: 0x51,
} as const;

export const ALLOWED_OPCODES: Set<number> = new Set(Object.values(OpCode));

/// Host-call allowlist — the ONLY bridge from a script to the engine. Deny-by-default: an id
/// not in this set fails validation. Grouped by capability so review can reason about them.
/// Keep in lockstep with game/Script/HostApi.cs.
export const HostCall = {
  // lifecycle / util
  LOG: 0x0001, // debug log (rate-limited, dev only)
  TIME: 0x0002, // seconds since script start
  RANDOM: 0x0003, // deterministic PRNG in [0,1)
  // this-script-scoped node manipulation (declared nodes only)
  NODE_MOVE: 0x0100,
  NODE_ROTATE: 0x0101,
  NODE_SET_VISIBLE: 0x0102,
  NODE_PLAY_ANIM: 0x0103,
  // whitelisted media
  SOUND_PLAY: 0x0200,
  SCREEN_SET_TEXT: 0x0201,
  /// (screenSlot, number) -> 0. Sets the declared board's Label3D text to a NUMBER the script
  /// computed — a timer, a score, a vote count. Without it boards can only ever show string
  /// literals, which makes every dev-made minigame scoreboard blind. Same scope rules as
  /// SCREEN_SET_TEXT: declared screens only, purely local presentation, no sync implications.
  SCREEN_SET_NUMBER: 0x0202,
  // players (read-only transform, within world)
  PLAYER_COUNT: 0x0300,
  /// (playerIndex, axis) -> component. axis 0=x, 1=y, 2=z. Read-only: there is deliberately no
  /// call that writes a player transform.
  PLAYER_POS: 0x0301,
  // script-local state
  VAR_GET: 0x0400,
  VAR_SET: 0x0401,
  // networking — ONLY through the relay's rate-limited script channel
  NET_EMIT: 0x0500,

  /// (playerIndex, nodeSlot, attachPoint) -> 1 on success, 0 otherwise. Parents one of the
  /// script's OWN declared nodes to a player's bone. This grants no control over player motion —
  /// the attachment rides the player, never the reverse. See §5.1.
  PLAYER_ATTACH: 0x0302,
  /// (nodeSlot) -> 1 if the node was attached. Returns a declared node to the world root.
  PLAYER_DETACH: 0x0303,

  // ── Tier 5 (Creator) — custom material/shader params ──
  SHADER_SET_FLOAT: 0x0600,
  SHADER_SET_COLOR: 0x0601,
  SHADER_SET_VEC4: 0x0602,

  // ── Tier 6 (Trusted) — particle effects, spatial audio ──
  PARTICLE_BURST: 0x0700,
  PARTICLE_SET_RATE: 0x0701,
  SOUND_PLAY_SPATIAL: 0x0702,

  // ── Tier 8 (VerifiedCreator) — advanced networking ──
  NET_EMIT_STRING: 0x0800,
  NET_SYNC_GET: 0x0801,
  NET_SYNC_SET: 0x0802,
} as const;

export const ALLOWED_HOST_CALLS: Set<number> = new Set(Object.values(HostCall));

/// Minimum trust rank required to *use* a host call, independent of the budget caps below.
/// Deny-by-default has two axes: an id must be on ALLOWED_HOST_CALLS at all, and the author must
/// clear this floor. MUST match HostCallTrust.MinTrust in game/Script/OpCode.cs — the client
/// re-checks at load, and a disagreement here is threat T7 (allowlist drift).
export const HOST_CALL_MIN_TRUST: Record<number, number> = {
  // Attaching props to other people is a griefing surface (vision-blocking, nuisance geometry)
  // even though it confers no control over their movement, so it sits behind the Creator floor.
  [HostCall.PLAYER_ATTACH]: 5,
  [HostCall.PLAYER_DETACH]: 5,
  [HostCall.SHADER_SET_FLOAT]: 5,
  [HostCall.SHADER_SET_COLOR]: 5,
  [HostCall.SHADER_SET_VEC4]: 5,
  [HostCall.PARTICLE_BURST]: 6,
  [HostCall.PARTICLE_SET_RATE]: 6,
  [HostCall.SOUND_PLAY_SPATIAL]: 6,
  [HostCall.NET_EMIT_STRING]: 8,
  [HostCall.NET_SYNC_GET]: 8,
  [HostCall.NET_SYNC_SET]: 8,
};

/// Trust floor for a host call. 0 = available to every rank.
export function hostCallMinTrust(id: number): number {
  return HOST_CALL_MIN_TRUST[id] ?? 0;
}

/// Caps scale with the author's trust rank — a higher rank may declare a bigger budget.
export function scriptCaps(rank: number) {
  // rank 4 (Known, first scripted-submit rank) .. 8 (VerifiedCreator)
  const tick = rank >= 8 ? 20000 : rank >= 6 ? 12000 : rank >= 5 ? 8000 : 4000;
  const memKiB = rank >= 8 ? 2048 : rank >= 6 ? 1024 : 512;
  return { budgetTick: tick, budgetMem: memKiB };
}

export interface ScriptValidation {
  ok: boolean;
  errors: string[];
  budgetTick?: number;
  budgetMem?: number;
  hostCalls?: number[];
  hooks?: number[];
  strings?: string[];
}

/// Statically validate a SerikaScript bytecode blob against the allowlists and the author's
/// rank caps. Returns a precise error list — a single failure means the world cannot enter the
/// review queue. This is intentionally conservative: anything unrecognised is rejected.
export function validateScriptBytecode(buf: Uint8Array, rank: number): ScriptValidation {
  const errors: string[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const need = (n: number, what: string): boolean => {
    if (p + n > buf.length) { errors.push(`truncated ${what} at offset ${p}`); return false; }
    return true;
  };

  if (!need(6, "header")) return { ok: false, errors };
  if (view.getUint32(0, false) !== SSKB_MAGIC) errors.push("bad magic (not SSKB)");
  const version = view.getUint8(4);
  if (version !== SSKB_VERSION) errors.push(`unsupported bytecode version ${version}`);
  if (errors.length) return { ok: false, errors };

  const caps = scriptCaps(rank);
  const budgetTick = view.getUint16(6, true);
  const budgetMem = view.getUint16(8, true);
  if (budgetTick === 0 || budgetTick > caps.budgetTick)
    errors.push(`per-tick budget ${budgetTick} outside 1..${caps.budgetTick} for rank ${rank}`);
  if (budgetMem === 0 || budgetMem > caps.budgetMem)
    errors.push(`memory budget ${budgetMem}KiB outside 1..${caps.budgetMem} for rank ${rank}`);

  p = 10;
  if (!need(2, "host-call count")) return { ok: false, errors };
  const nHost = view.getUint16(p, true); p += 2;
  const hostCalls: number[] = [];
  for (let i = 0; i < nHost; i++) {
    if (!need(2, "host-call id")) return { ok: false, errors };
    const id = view.getUint16(p, true); p += 2;
    hostCalls.push(id);
    if (!ALLOWED_HOST_CALLS.has(id)) {
      errors.push(`disallowed host call 0x${id.toString(16)}`);
      continue;
    }
    const minTrust = hostCallMinTrust(id);
    if (minTrust > rank)
      errors.push(`host call 0x${id.toString(16)} requires trust level ${minTrust}, author has ${rank}`);
  }

  // ── entry-point table ──
  if (!need(2, "entry count")) return { ok: false, errors };
  const nEntries = view.getUint16(p, true); p += 2;
  if (nEntries > MAX_ENTRIES) {
    errors.push(`entry-point table has ${nEntries} entries, max ${MAX_ENTRIES}`);
    return { ok: false, errors };
  }
  const hooks: number[] = [];
  const entryOffsets: number[] = [];
  for (let i = 0; i < nEntries; i++) {
    if (!need(5, "entry")) return { ok: false, errors };
    const hookId = view.getUint8(p); p += 1;
    const offset = view.getUint32(p, true); p += 4;
    if (!ALLOWED_HOOKS.has(hookId)) errors.push(`unknown hook id 0x${hookId.toString(16)}`);
    // A duplicate hook makes dispatch ambiguous — reject rather than pick one.
    if (hooks.includes(hookId)) errors.push(`duplicate entry for hook 0x${hookId.toString(16)}`);
    hooks.push(hookId);
    entryOffsets.push(offset);
  }

  // ── string table ──
  if (!need(2, "string count")) return { ok: false, errors };
  const nStrings = view.getUint16(p, true); p += 2;
  if (nStrings > MAX_STRINGS) {
    errors.push(`string table has ${nStrings} entries, max ${MAX_STRINGS}`);
    return { ok: false, errors };
  }
  const strings: string[] = [];
  for (let i = 0; i < nStrings; i++) {
    if (!need(2, "string length")) return { ok: false, errors };
    const len = view.getUint16(p, true); p += 2;
    if (len > MAX_STRING_BYTES) {
      errors.push(`string ${i} is ${len} bytes, max ${MAX_STRING_BYTES}`);
      return { ok: false, errors };
    }
    if (!need(len, "string body")) return { ok: false, errors };
    strings.push(new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(p, p + len)));
    p += len;
  }

  if (!need(4, "code length")) return { ok: false, errors };
  const codeLen = view.getUint32(p, true); p += 4;
  if (!need(codeLen, "code section")) return { ok: false, errors };
  const codeEnd = p + codeLen;

  // Entry offsets are indices into the code section and must land inside it. An out-of-range
  // entry is the same class of escape as an out-of-range jump (T9).
  for (let i = 0; i < entryOffsets.length; i++) {
    if (entryOffsets[i] >= codeLen)
      errors.push(`entry ${i} (hook 0x${hooks[i].toString(16)}) offset ${entryOffsets[i]} outside code section`);
  }

  // Walk the opcode stream: every opcode must be known; HOST_CALL ids must be in the declared
  // (and thus allowlisted) table; jumps must land inside the code section.
  const jumpTargets: number[] = [];
  const codeBase = p;
  while (p < codeEnd) {
    const op = view.getUint8(p); const opAt = p; p += 1;
    if (!ALLOWED_OPCODES.has(op)) { errors.push(`unknown opcode 0x${op.toString(16)} at ${opAt}`); break; }
    switch (op) {
      case OpCode.PUSH_I: p += 4; break;
      case OpCode.PUSH_F: p += 4; break;
      case OpCode.LOAD: case OpCode.STORE: p += 1; break;
      case OpCode.JMP: case OpCode.JMP_IF: case OpCode.JMP_IFNOT: {
        if (p + 2 > codeEnd) { errors.push(`truncated jump at ${opAt}`); p = codeEnd; break; }
        const rel = view.getInt16(p, true); p += 2;
        jumpTargets.push(p + rel - codeBase);
        break;
      }
      case OpCode.HOST_CALL: {
        if (p + 3 > codeEnd) { errors.push(`truncated host call at ${opAt}`); p = codeEnd; break; }
        const id = view.getUint16(p, true); p += 2; p += 1; // argc
        if (!hostCalls.includes(id)) errors.push(`host call 0x${id.toString(16)} not in declared table`);
        break;
      }
      default: break; // zero-operand opcode
    }
  }
  if (p !== codeEnd && errors.length === 0) errors.push("code section did not decode cleanly");
  for (const tgt of jumpTargets) {
    if (tgt < 0 || tgt > codeLen) errors.push(`jump target ${tgt} outside code section`);
  }

  return {
    ok: errors.length === 0,
    errors,
    budgetTick,
    budgetMem,
    hostCalls,
    hooks,
    strings,
  };
}

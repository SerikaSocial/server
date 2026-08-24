// SerikaScript bytecode container — the artifact the SDK compiles and the client VM executes.
// The server never runs it; it only *validates* it here (defense in depth: on submit and again
// at publish). The C# VM (game/Script/) and this validator MUST agree on the opcode + host-call
// allowlists byte-for-byte — that agreement is the sandbox boundary.
//
// Container layout (little-endian):
//   magic     4 bytes  "SSKB"
//   version   u8       currently 1
//   flags     u8       reserved (0)
//   budgetTick u16     declared per-tick instruction budget
//   budgetMem  u16     declared allocation ceiling (KiB)
//   nHostCalls u16     count of host-call ids referenced
//   hostCalls  nHostCalls * u16   each a host-call id (must be on ALLOWED_HOST_CALLS)
//   codeLen   u32      length of the code section
//   code      codeLen bytes       opcode stream; each op is [u8 opcode][operands]
//
// This module is the single source of truth for the allowlists and caps on the server side.

export const SSKB_MAGIC = 0x53_53_4b_42; // "SSKB"
export const SSKB_VERSION = 1;

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
  // players (read-only transform, within world)
  PLAYER_COUNT: 0x0300,
  PLAYER_POS: 0x0301,
  // script-local state
  VAR_GET: 0x0400,
  VAR_SET: 0x0401,
  // networking — ONLY through the relay's rate-limited script channel
  NET_EMIT: 0x0500,
} as const;

export const ALLOWED_HOST_CALLS: Set<number> = new Set(Object.values(HostCall));

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
    if (!ALLOWED_HOST_CALLS.has(id)) errors.push(`disallowed host call 0x${id.toString(16)}`);
  }

  if (!need(4, "code length")) return { ok: false, errors };
  const codeLen = view.getUint32(p, true); p += 4;
  if (!need(codeLen, "code section")) return { ok: false, errors };
  const codeEnd = p + codeLen;

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
  };
}

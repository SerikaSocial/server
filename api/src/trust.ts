import { prisma } from "./db.ts";

/// Trust ladder, mirrored from the `User.trustLevel` column (see prisma/schema.prisma).
///
///   0 visitor · 1 newcomer · 2 member · 3 regular · 4 known
///   5 creator · 6 trusted · 7 partner · 8 verified-creator
///
/// Standing raises a floor automatically on login (admins → 8, premium → a mid rank; see
/// upsertUser) and a staff member can grant more by hand. A manually granted rank is never
/// lowered by the login floor. These thresholds are what actually *gate* creator actions.
export const TrustRank = {
  Visitor: 0,
  Newcomer: 1,
  Member: 2,
  Regular: 3,
  Known: 4,
  Creator: 5,
  Trusted: 6,
  Partner: 7,
  VerifiedCreator: 8,
} as const;

export const MAX_TRUST = TrustRank.VerifiedCreator;

/// Backwards-compatible alias for the old 0..4 enum. Old call sites imported `TrustLevel`
/// and `TRUST_TO_UPLOAD`; keep them pointing at the new ladder so nothing silently regresses.
export const TrustLevel = TrustRank;

export const TRUST_LABELS: Record<number, string> = {
  0: "Visitor",
  1: "Newcomer",
  2: "Member",
  3: "Regular",
  4: "Known",
  5: "Creator",
  6: "Trusted",
  7: "Partner",
  8: "Verified Creator",
};

export function trustLabel(level: number): string {
  return TRUST_LABELS[Math.max(0, Math.min(MAX_TRUST, level))] ?? "Visitor";
}

/// Capability thresholds — named so routes never hard-code a magic rank number. Each is the
/// *minimum* rank that unlocks the capability. Admins (`User.isAdmin`) act as rank 8 for all
/// capability checks (see `effectiveRank`).
export const Cap = {
  UploadAvatar: TrustRank.Newcomer, // 1
  SubmitStaticWorld: TrustRank.Member, // 2
  HostPublicInstance: TrustRank.Regular, // 3
  SubmitScriptedWorld: TrustRank.Known, // 4
  AutoApproveStatic: TrustRank.Creator, // 5
  ReviewAvatars: TrustRank.Trusted, // 6
  PublishScriptNoReview: TrustRank.VerifiedCreator, // 8
} as const;

/// Legacy name kept for existing imports (worlds/avatars upload gates). Points at the
/// static-world submission floor, which is the same rank (2) the old constant meant.
export const TRUST_TO_UPLOAD = Cap.SubmitStaticWorld;

export class TrustError extends Error {
  constructor(public readonly required: number, public readonly have: number) {
    super("insufficient_trust");
  }
}

/// The rank we treat a user as having for gating. Admins are always top rank; otherwise it's
/// the live `trustLevel` column so a just-granted rank takes effect without a re-login.
export async function effectiveRank(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { trustLevel: true, isAdmin: true },
  });
  if (!user) return 0;
  return user.isAdmin ? MAX_TRUST : user.trustLevel;
}

/// Assert the caller has at least `min` trust. Throws `TrustError` (mapped to 403 by callers).
export async function requireTrust(userId: string, min: number): Promise<void> {
  const have = await effectiveRank(userId);
  if (have < min) throw new TrustError(min, have);
}

/// Does the caller hold a capability? Convenience wrapper over `effectiveRank`.
export async function hasCap(userId: string, cap: number): Promise<boolean> {
  return (await effectiveRank(userId)) >= cap;
}

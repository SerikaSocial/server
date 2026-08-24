import { prisma } from "./db.ts";
import type { AccountsProfile } from "./accounts.ts";

/// Mirror a serika-accounts profile into our users table. Idempotent: called on every
/// login, so it both creates first-time users and refreshes changed display fields.
///
/// The first user ever to log in is made an admin bootstrap only if serika-accounts already
/// says they're an admin — we never invent privilege locally.
export async function upsertUser(profile: AccountsProfile) {
  const user = await prisma.user.upsert({
    where: { accountsId: profile.id },
    create: {
      accountsId: profile.id,
      username: profile.username,
      displayName: profile.username,
      avatarUrl: profile.avatar ?? null,
      isPremium: profile.isPremium,
      isAdmin: profile.isAdmin,
      lastSeen: new Date(),
    },
    update: {
      // username can change upstream; keep it in sync but don't clobber a locally chosen
      // displayName.
      username: profile.username,
      avatarUrl: profile.avatar ?? null,
      isPremium: profile.isPremium,
      isAdmin: profile.isAdmin,
      lastSeen: new Date(),
    },
  });

  // Trust level mirrors standing: admins are fully trusted (top rank 8), premium members get
  // a bump to Member (2). Never lower a manually-granted level — only raise the floor implied
  // by their status. See TrustRank in trust.ts.
  const floor = user.isAdmin ? 8 : user.isPremium ? 2 : 0;
  if (user.trustLevel < floor) {
    await prisma.user.update({ where: { id: user.id }, data: { trustLevel: floor } });
    user.trustLevel = floor;
  }

  // Give brand-new accounts the built-in default avatar so they're never avatar-less.
  if (!user.currentAvatarId) {
    const dflt = await prisma.avatar.findFirst({ where: { isBuiltin: true }, orderBy: { createdAt: "asc" } });
    if (dflt) {
      return prisma.user.update({ where: { id: user.id }, data: { currentAvatarId: dflt.id } });
    }
  }
  return user;
}

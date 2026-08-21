// Seeds the built-in world and avatar. Idempotent — safe to run repeatedly. Run with:
//   bun src/seed.ts
import { prisma } from "./db.ts";

async function main() {
  // Default avatar: every new account is assigned this so nobody is avatar-less.
  const avatar = await prisma.avatar.upsert({
    where: { id: "00000000-0000-0000-0000-0000000000a0" },
    create: {
      id: "00000000-0000-0000-0000-0000000000a0",
      name: "Serika (default)",
      releaseStatus: 2,
      perfRank: 0,
      sourceFormat: 0,
      isBuiltin: true,
    },
    update: { name: "Serika (default)" },
  });

  // Default world: the M1 spawn. Ships inside the client, so it needs no CDN asset.
  const world = await prisma.world.upsert({
    where: { id: "00000000-0000-0000-0000-0000000000e0" },
    create: {
      id: "00000000-0000-0000-0000-0000000000e0",
      name: "The Commons",
      description: "The default gathering place. Built into the client.",
      tags: ["hangout", "default"],
      capacity: 32,
      releaseStatus: 2,
      isBuiltin: true,
      heat: 1000, // pin it to the top of the browser
    },
    update: { name: "The Commons" },
  });

  console.log("seeded:");
  console.log(`  avatar ${avatar.id} — ${avatar.name}`);
  console.log(`  world  ${world.id} — ${world.name}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

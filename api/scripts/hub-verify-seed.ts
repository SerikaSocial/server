/**
 * Phase 2b verification seed — LOCAL DB ONLY (refuses anything that isn't the local
 * scratch). Creates an admin + a plain user + a world, prints signed session tokens.
 */
import { prisma } from "../src/db.ts";
import { signSession } from "../src/tokens.ts";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes("127.0.0.1:5490")) throw new Error("refusing: not the local dev Postgres");

async function user(name: string, isAdmin: boolean) {
  return prisma.user.upsert({
    where: { username: name },
    update: { isAdmin },
    create: { username: name, accountsId: `test-${name}`, isAdmin },
  });
}

const admin = await user("hub-admin", true);
const plain = await user("hub-user", false);
const world = await prisma.world.upsert({
  where: { id: "00000000-0000-4000-8000-000000000001" },
  update: {},
  create: { id: "00000000-0000-4000-8000-000000000001", name: "Hub Test World", isBuiltin: true, releaseStatus: 2 },
});

console.log("ADMIN_TOKEN=" + (await signSession({ sub: admin.id, accountsId: admin.accountsId, username: admin.username, isAdmin: true })));
console.log("USER_TOKEN=" + (await signSession({ sub: plain.id, accountsId: plain.accountsId, username: plain.username, isAdmin: false })));
console.log("ADMIN_ID=" + admin.id);
console.log("USER_ID=" + plain.id);
console.log("WORLD_ID=" + world.id);

await prisma.$disconnect();
// db.ts keeps live sockets (Redis) open — without this bun never exits.
process.exit(0);

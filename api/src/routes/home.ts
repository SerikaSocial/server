import { Elysia, t } from "elysia";
import { authed } from "../auth-plugin.ts";
import { prisma } from "../db.ts";
import { defaultHomeEntry, defaultHomeInclude } from "../default-home.ts";
import { assetPublicUrl } from "../storage.ts";

async function selection(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { homeWorldId: true } });
  const personal = user?.homeWorldId
    ? await prisma.world.findUnique({ where: { id: user.homeWorldId }, include: defaultHomeInclude }) : null;
  const own = defaultHomeEntry(personal, assetPublicUrl);
  if (own) return { world: own, homeWorldId: user!.homeWorldId, usingDefault: false };
  // A removed/unpublished selection must never give access to a withdrawn asset. Retain
  // the preference so a temporary withdrawal need not erase the user's choice.
  const fallback = await prisma.world.findFirst({
    where: { isDefaultHome: true }, orderBy: { id: "asc" }, include: defaultHomeInclude,
  });
  return { world: defaultHomeEntry(fallback, assetPublicUrl), homeWorldId: user?.homeWorldId ?? null, usingDefault: true };
}

export const homeRoutes = new Elysia({ prefix: "/v1/users/me/home" })
  .use(authed)
  .onBeforeHandle(({ set }) => { set.headers["Cache-Control"] = "private, no-store"; })
  .get("", ({ session }) => selection(session.sub))
  .put("", async ({ session, body, set }) => {
    const world = await prisma.world.findUnique({ where: { id: body.worldId }, include: defaultHomeInclude });
    if (!defaultHomeEntry(world, assetPublicUrl)) {
      set.status = 422;
      return { error: "home_world_unavailable", detail: "Choose a public, approved world with a ready download." };
    }
    await prisma.user.update({ where: { id: session.sub }, data: { homeWorldId: world!.id } });
    return selection(session.sub);
  }, { body: t.Object({ worldId: t.String({ format: "uuid" }) }) })
  .delete("", async ({ session }) => {
    await prisma.user.update({ where: { id: session.sub }, data: { homeWorldId: null } });
    return selection(session.sub);
  });

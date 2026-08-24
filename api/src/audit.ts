import { prisma } from "./db.ts";

/// Append an immutable audit row. Never throws into the caller's happy path — auditing must
/// not fail a privileged action, but a failure is logged so it can be noticed.
export async function audit(
  action: string,
  opts: { actorId?: string | null; subjectId?: string | null; detail?: unknown } = {},
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action,
        actorId: opts.actorId ?? null,
        subjectId: opts.subjectId ?? null,
        detail: (opts.detail ?? undefined) as any,
      },
    });
  } catch (e) {
    console.error(`[audit] failed to write ${action}:`, e);
  }
}

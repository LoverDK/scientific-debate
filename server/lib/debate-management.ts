import { fail } from "@agent-native/core/action";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";

export async function changeDebate(debateId: string, owner: string, change: { claim: string } | { archive: true }) {
  const { debates, debateRuns } = schema;
  return getDb().transaction(async tx => {
    const [debate] = await tx.select({ archivedAt: debates.archivedAt }).from(debates)
      .where(and(eq(debates.id, debateId), eq(debates.ownerEmail, owner))).for("update");
    if (!debate) fail("Debate not found.", { statusCode: 404 });
    if (debate.archivedAt !== null) fail("Debate is archived.", { statusCode: 409 });
    const [active] = await tx.select({ id: debateRuns.id }).from(debateRuns)
      .where(and(eq(debateRuns.debateId, debateId), inArray(debateRuns.status, ["queued", "running"]))).limit(1);
    if (active) fail("A debate run is in progress.", { statusCode: 409 });
    const now = new Date().toISOString();
    const fields = "archive" in change ? { archivedAt: now } : { claim: change.claim };
    const [result] = await tx.update(debates).set({ ...fields, updatedAt: now }).where(eq(debates.id, debateId))
      .returning({ id: debates.id, claim: debates.claim, archivedAt: debates.archivedAt });
    return result!;
  });
}

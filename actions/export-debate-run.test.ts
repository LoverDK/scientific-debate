import { closeDbExec, getDatabaseUrl, getMigrationDatabaseUrl, runMigrations, withMigrationRuntime } from "@agent-native/core/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getDb, schema } from "../server/db/index.js";
import { DEBATES_APP_MIGRATIONS_TABLE, debatesAppMigrations } from "../server/db/migrations.js";
import exportRun from "./export-debate-run.js";
import getResult from "./get-debate-result.js";

const owner = { caller: "cli" as const, userEmail: "export@example.test" };
const attack = "<img src=https://example.test/tracker>\n![embed](https://example.test/image)";
const pack = {
  debateId: "mine", claim: attack, privateExtra: "NEVER_EXPORT",
  papers: [{ id: "p", externalId: "W1", title: "A", authors: ["A. User"], year: 2024,
    doi: null, url: null, providerUrl: "https://openalex.org/W1", abstract: "Abstract",
    abstractTruncated: true, privateExtra: "NEVER_EXPORT" }],
};
const output = { role: "judge", summary: attack, arguments: [{ claim: "Claim", support: "Reason", citedExternalIds: ["W1"] }],
  citedExternalIds: ["W1"], verdict: "insufficient_evidence", confidence: 0.1, limitations: ["Single abstract"] };

beforeAll(async () => {
  if ([process.env.DATABASE_URL, getDatabaseUrl(), getMigrationDatabaseUrl()].some(url => url !== "pglite:memory")) {
    throw new Error("Export tests require memory PGlite.");
  }
  await withMigrationRuntime(async () => {
    await runMigrations(debatesAppMigrations, { table: DEBATES_APP_MIGRATIONS_TABLE })(undefined);
  });
  const db = getDb();
  await db.insert(schema.debates).values({ id: "mine", ownerEmail: owner.userEmail, claim: "later revision" });
  await db.insert(schema.debateRuns).values({ id: "r", debateId: "mine", modelId: "test", status: "failed",
    createdByEmail: owner.userEmail, evidenceSnapshotJson: JSON.stringify(pack), errorMessage: "NEVER_EXPORT" });
  await db.insert(schema.debateMessages).values({ id: "m", runId: "r", role: "judge",
    payloadJson: JSON.stringify(output), citedExternalIdsJson: '["W1"]' });
});
afterAll(closeDbExec);

it("keeps historical verdicts readable and exports research notes only when recorded", async () => {
  const legacy = await getResult.run({ debateId: "mine", runId: "r" }, owner);
  expect(legacy.claim).toBe(attack);
  expect(legacy.judge?.researchNotes).toBeUndefined();
  const researchNotes = {
    evidenceConflict: "The abstracts disagree on duration.",
    reasoningGap: "Neither argument establishes causality.",
    nextQuestions: ["Does the effect persist at follow-up?"],
  };
  const db = getDb();
  await db.insert(schema.debateRuns).values({
    id: "extended", debateId: "mine", modelId: "test", status: "completed",
    createdByEmail: owner.userEmail, evidenceSnapshotJson: JSON.stringify(pack),
  });
  await db.insert(schema.debateMessages).values({
    id: "extended-judge", runId: "extended", role: "judge",
    payloadJson: JSON.stringify({ ...output, researchNotes }), citedExternalIdsJson: '["W1"]',
  });
  const report = await getResult.run({ debateId: "mine", runId: "extended" }, owner);
  expect(report.judge).toMatchObject({ arguments: output.arguments, researchNotes });
  const exported = await exportRun.run({ runId: "extended", format: "html" }, owner);
  expect(exported.html).toContain(researchNotes.nextQuestions[0]);
  expect(exported.markdown).toContain(researchNotes.evidenceConflict);
});

it("requires owner identity and conceals another owner's run", async () => {
  await expect(exportRun.run({runId:"r", format:"markdown"}, { caller:"cli" })).rejects.toMatchObject({statusCode:401});
  for (const runId of ["r", "absent"]) {
    await expect(exportRun.run({runId, format:"html"}, {...owner,userEmail:"other@test.local"})).rejects.toMatchObject({statusCode:404,message:"Debate run not found."});
  }
});

it.each(["json","markdown","html"] as const)("exports only the saved evidence and safe report fields in %s", async format => {
  const result = await exportRun.run({ runId:"r", format }, owner);
  expect(JSON.stringify(result)).not.toMatch(/NEVER_EXPORT|later revision/);
  expect(result.summaryText).toContain(attack);
  expect(result.markdown).toContain("\n    ![embed]");
  expect(result.markdown).toContain("Abstract truncated");
  if(format === "json"){
    expect(result.json).toMatchObject({claim:attack,roles:[output],evidencePack:{papers:[{stance:null,authors:["A. User"]}]}});
  }
  if(format === "html"){
    expect(result.html).toContain("&lt;img");
    expect(result.html).not.toMatch(/<(img|script)\b/i);
    expect(result.html).toContain("default-src 'none'");
  }
});

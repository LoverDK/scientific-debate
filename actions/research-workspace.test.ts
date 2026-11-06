import {
  closeDbExec,
  getDatabaseUrl,
  runMigrations,
  withMigrationRuntime,
} from "@agent-native/core/db";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";

import { getDb, schema } from "../server/db/index.js";
import {
  DEBATES_APP_MIGRATIONS_TABLE,
  debatesAppMigrations,
} from "../server/db/migrations.js";
import add from "./add-debate-to-project.js";
import archive from "./archive-research-project.js";
import detail from "./list-project-debates.js";
import list from "./list-research-projects.js";

const owner = { caller: "cli" as const, userEmail: "owner@test.local" };
const other = { caller: "cli" as const, userEmail: "other@test.local" };
const args = { projectId: "p", debateId: "d" };
if (
  process.env.DATABASE_URL !== "pglite:memory" ||
  getDatabaseUrl() !== "pglite:memory"
)
  throw Error("Memory database required");

describe("research workspace", () => {
  beforeAll(async () => {
    await withMigrationRuntime(async () => {
      await runMigrations(debatesAppMigrations, {
        table: DEBATES_APP_MIGRATIONS_TABLE,
      })(undefined);
    });
  });
  afterAll(async () => {
    await closeDbExec();
  });
  beforeEach(async () => {
    const db = getDb();
    await db.delete(schema.researchProjects);
    await db.delete(schema.debates);
    await db.delete(schema.papers);
    await db.insert(schema.researchProjects).values([
      {
        id: "p",
        title: "First",
        description: "unique SUBJECT",
        ownerEmail: owner.userEmail,
      },
      { id: "foreign", title: "First foreign", ownerEmail: other.userEmail },
    ]);
    await db.insert(schema.debates).values([
      { id: "d", claim: "A", ownerEmail: owner.userEmail },
      { id: "foreign-d", claim: "Secret", ownerEmail: other.userEmail },
    ]);
  });
  it("isolates listings, mutations and legacy cross-owner links", async () => {
    await expect(detail.run({ projectId: "p" }, other)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(archive.run({ projectId: "p" }, other)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(add.run(args, other)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      add.run({ ...args, debateId: "foreign-d" }, owner),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(list.run({}, { caller: "cli" })).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(
      (await list.run({ query: "subject" }, owner)).projects.map((p) => p.id),
    ).toEqual(["p"]);
    expect((await list.run({ query: "%" }, owner)).projects).toEqual([]);
    await getDb()
      .insert(schema.researchProjectDebates)
      .values({
        id: "old",
        ...args,
        debateId: "foreign-d",
        addedByEmail: owner.userEmail,
      });
    const result = await detail.run({ projectId: "p" }, owner);
    expect(result.debates).toEqual([]);
    expect(result.papers).toEqual([]);
  });
  it("keeps one membership on concurrent add and preserves it on archive", async () => {
    const results = await Promise.all([
      add.run(args, owner),
      add.run(args, owner),
    ]);
    expect(results.map((r) => r.alreadyLinked).sort()).toEqual([false, true]);
    const archiveResult = await archive.run({ projectId: "p" }, owner);
    expect(await archive.run({ projectId: "p" }, owner)).toEqual(archiveResult);
    await expect(add.run(args, owner)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await list.run({}, owner)).projects).toEqual([]);
    expect(
      (await list.run({ scope: "archived" }, owner)).projects.map((p) => p.id),
    ).toEqual(["p"]);
    expect((await detail.run({ projectId: "p" }, owner)).debates).toHaveLength(
      1,
    );
  });
  it("groups a shared paper once and preserves links to both claims", async () => {
    const db = getDb();
    await db
      .insert(schema.debates)
      .values({ id: "d2", claim: "B", ownerEmail: owner.userEmail });
    await add.run(args, owner);
    await add.run({ ...args, debateId: "d2" }, owner);
    await db
      .insert(schema.papers)
      .values({
        id: "paper",
        source: "openalex",
        externalId: "W1",
        providerUrl: "https://openalex.org/W1",
      });
    await db
      .insert(schema.debatePapers)
      .values(
        ["d", "d2"].map((debateId) => ({
          id: debateId,
          debateId,
          paperId: "paper",
          addedByEmail: owner.userEmail,
        })),
      );
    expect((await detail.run({ projectId: "p" }, owner)).papers).toMatchObject([
      { id: "paper", debateIds: ["d", "d2"] },
    ]);
  });
});

import { isActionContractError } from "@agent-native/core/action";
import { closeDbExec, runMigrations, withMigrationRuntime } from "@agent-native/core/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEBATES_APP_MIGRATIONS_TABLE, debatesAppMigrations } from "../server/db/migrations.js";
import { getDb, schema } from "../server/db/index.js";
import listDebates from "./list-debates.js";

const OWNER_EMAIL = "owner@example.test";
const OTHER_EMAIL = "other@example.test";

const PUBLIC_FIELDS = [
  "id",
  "claim",
  "inputType",
  "status",
  "createdAt",
  "updatedAt",
] as const;

function assertMemoryDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== "pglite:memory") {
    throw new Error(
      `Refusing to run list-debates tests: DATABASE_URL must be exactly "pglite:memory" (got ${JSON.stringify(process.env.DATABASE_URL)}). This suite must not touch ./data/pglite.`,
    );
  }
}

// Fail fast at module load before any getDb()/getDbExec() call connects.
assertMemoryDatabaseUrl();

async function expectActionFailure(
  run: Promise<unknown>,
  statusCode: number,
  message: string,
): Promise<void> {
  try {
    await run;
    expect.fail("Expected the action to fail, but it succeeded.");
  } catch (error) {
    expect(isActionContractError(error)).toBe(true);
    if (!isActionContractError(error)) return;
    expect(error.statusCode).toBe(statusCode);
    expect(error.message).toBe(message);
    expect(error.errorCode).toBe("action_failed");
  }
}

function debateRow(input: {
  id: string;
  claim: string;
  createdAt: string;
  ownerEmail: string;
  updatedAt?: string;
  orgId?: string | null;
  visibility?: "private" | "org" | "public";
}) {
  return {
    id: input.id,
    claim: input.claim,
    inputType: "text" as const,
    status: "pending",
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
    ownerEmail: input.ownerEmail,
    orgId: input.orgId ?? null,
    visibility: input.visibility ?? ("private" as const),
  };
}

function assertPublicDebateShape(row: Record<string, unknown>): void {
  expect(Object.keys(row).sort()).toEqual([...PUBLIC_FIELDS].sort());
  for (const secret of ["ownerEmail", "orgId", "visibility"] as const) {
    expect(row).not.toHaveProperty(secret);
  }
}

describe("list-debates", () => {
  beforeAll(async () => {
    assertMemoryDatabaseUrl();
    await withMigrationRuntime(async () => {
      await runMigrations(debatesAppMigrations, { table: DEBATES_APP_MIGRATIONS_TABLE })(undefined);
    });
  });

  beforeEach(async () => {
    assertMemoryDatabaseUrl();
    // Isolate from other cases (and from sibling suites sharing a worker DB).
    await getDb().delete(schema.debates);
  });

  afterAll(async () => {
    await closeDbExec();
  });

  it("A: returns 401 when the caller is not signed in", async () => {
    await expectActionFailure(
      listDebates.run({}, { caller: "cli" }),
      401,
      "Sign in to list debates.",
    );
  });

  it("B: does not include another user's debates in the owner's list", async () => {
    await getDb()
      .insert(schema.debates)
      .values([
        debateRow({
          id: "owner-debate-1",
          claim: "Owner claim",
          createdAt: "2026-02-01T00:00:00.000Z",
          ownerEmail: OWNER_EMAIL,
          orgId: "org-should-not-leak",
          visibility: "org",
        }),
        debateRow({
          id: "other-debate-1",
          claim: "Other claim",
          createdAt: "2026-02-02T00:00:00.000Z",
          ownerEmail: OTHER_EMAIL,
        }),
      ]);

    const result = await listDebates.run(
      {},
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(result.debates).toHaveLength(1);
    expect(result.debates[0]?.id).toBe("owner-debate-1");
    expect(result.debates.map((row) => row.id)).not.toContain("other-debate-1");
    for (const row of result.debates) {
      assertPublicDebateShape(row as unknown as Record<string, unknown>);
    }
  });

  it("C: returns { debates: [] } when the owner has no debates", async () => {
    const result = await listDebates.run(
      {},
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(result).toEqual({ debates: [] });
  });

  it("D: orders debates by createdAt descending", async () => {
    await getDb()
      .insert(schema.debates)
      .values([
        debateRow({
          id: "debate-old",
          claim: "Old",
          createdAt: "2026-01-01T00:00:00.000Z",
          ownerEmail: OWNER_EMAIL,
        }),
        debateRow({
          id: "debate-new",
          claim: "New",
          createdAt: "2026-01-03T00:00:00.000Z",
          ownerEmail: OWNER_EMAIL,
        }),
        debateRow({
          id: "debate-mid",
          claim: "Mid",
          createdAt: "2026-01-02T00:00:00.000Z",
          ownerEmail: OWNER_EMAIL,
        }),
      ]);

    const result = await listDebates.run(
      {},
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(result.debates.map((row) => row.id)).toEqual([
      "debate-new",
      "debate-mid",
      "debate-old",
    ]);
    expect(result.debates.map((row) => row.createdAt)).toEqual([
      "2026-01-03T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
  });

  it("E: uses id ascending as a stable tie-breaker when createdAt matches", async () => {
    const sameCreatedAt = "2026-03-01T12:00:00.000Z";
    await getDb()
      .insert(schema.debates)
      .values([
        debateRow({
          id: "tie-c",
          claim: "C",
          createdAt: sameCreatedAt,
          ownerEmail: OWNER_EMAIL,
        }),
        debateRow({
          id: "tie-a",
          claim: "A",
          createdAt: sameCreatedAt,
          ownerEmail: OWNER_EMAIL,
        }),
        debateRow({
          id: "tie-b",
          claim: "B",
          createdAt: sameCreatedAt,
          ownerEmail: OWNER_EMAIL,
        }),
      ]);

    const result = await listDebates.run(
      {},
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(result.debates.map((row) => row.id)).toEqual([
      "tie-a",
      "tie-b",
      "tie-c",
    ]);
  });

  it("F: returns at most the newest 20 debates when more than 20 exist", async () => {
    const rows = Array.from({ length: 25 }, (_, index) => {
      const n = index + 1;
      const day = String(n).padStart(2, "0");
      return debateRow({
        id: `limit-${String(n).padStart(2, "0")}`,
        claim: `Claim ${n}`,
        // Higher day = newer; limit-25 is newest, limit-01 is oldest.
        createdAt: `2026-04-${day}T00:00:00.000Z`,
        ownerEmail: OWNER_EMAIL,
      });
    });
    await getDb().insert(schema.debates).values(rows);

    const result = await listDebates.run(
      {},
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(result.debates).toHaveLength(20);
    expect(result.debates.map((row) => row.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => {
        const n = 25 - index;
        return `limit-${String(n).padStart(2, "0")}`;
      }),
    );
    expect(result.debates.map((row) => row.id)).not.toContain("limit-01");
    expect(result.debates.map((row) => row.id)).not.toContain("limit-05");
    expect(result.debates[0]?.id).toBe("limit-25");
    expect(result.debates[19]?.id).toBe("limit-06");
  });

  it("G: returns only the public fields and never ownership columns", async () => {
    await getDb()
      .insert(schema.debates)
      .values(
        debateRow({
          id: "shape-1",
          claim: "Shape check",
          createdAt: "2026-05-01T00:00:00.000Z",
          ownerEmail: OWNER_EMAIL,
          orgId: "secret-org",
          visibility: "org",
        }),
      );

    const result = await listDebates.run(
      {},
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(result.debates).toHaveLength(1);
    expect(result.debates[0]).toEqual({
      id: "shape-1",
      claim: "Shape check",
      inputType: "text",
      status: "pending",
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
    });
    assertPublicDebateShape(
      result.debates[0] as unknown as Record<string, unknown>,
    );
  });
});

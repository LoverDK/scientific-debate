import { isActionContractError } from "@agent-native/core/action";
import { closeDbExec, runMigrations, withMigrationRuntime } from "@agent-native/core/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEBATES_APP_MIGRATIONS_TABLE, debatesAppMigrations } from "../server/db/migrations.js";
import { getDb, schema } from "../server/db/index.js";
import getDebate from "./get-debate.js";

const OWNER_EMAIL = "owner@example.test";
const OTHER_EMAIL = "other@example.test";
const DEBATE_ID = "11111111-1111-4111-8111-111111111111";
const MISSING_DEBATE_ID = "00000000-0000-4000-8000-000000000000";
const CLAIM = "Test claim for get-debate permission suite.";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const UPDATED_AT = "2026-01-01T00:00:00.000Z";

function assertMemoryDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== "pglite:memory") {
    throw new Error(
      `Refusing to run get-debate tests: DATABASE_URL must be exactly "pglite:memory" (got ${JSON.stringify(process.env.DATABASE_URL)}). This suite must not touch ./data/pglite.`,
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

describe("get-debate permissions", () => {
  beforeAll(async () => {
    assertMemoryDatabaseUrl();
    await withMigrationRuntime(async () => {
      await runMigrations(debatesAppMigrations, { table: DEBATES_APP_MIGRATIONS_TABLE })(undefined);
    });
  });

  beforeEach(async () => {
    assertMemoryDatabaseUrl();
    await getDb().delete(schema.debates);
    await getDb().insert(schema.debates).values({
      id: DEBATE_ID,
      claim: CLAIM,
      inputType: "text",
      status: "pending",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      ownerEmail: OWNER_EMAIL,
      orgId: null,
      visibility: "private",
    });
  });

  afterAll(async () => {
    await closeDbExec();
  });

  it("A: returns 401 when the caller is not signed in", async () => {
    await expectActionFailure(
      getDebate.run({ debateId: DEBATE_ID }, { caller: "cli" }),
      401,
      "Sign in to view a debate.",
    );
  });

  it("B: returns 404 when another user requests the owner's debate", async () => {
    await expectActionFailure(
      getDebate.run(
        { debateId: DEBATE_ID },
        { caller: "cli", userEmail: OTHER_EMAIL },
      ),
      404,
      "Debate not found.",
    );
  });

  it("C: returns 404 when the debate id does not exist", async () => {
    await expectActionFailure(
      getDebate.run(
        { debateId: MISSING_DEBATE_ID },
        { caller: "cli", userEmail: OWNER_EMAIL },
      ),
      404,
      "Debate not found.",
    );
  });

  it("D: returns the debate fields when the owner requests their own record", async () => {
    const row = await getDebate.run(
      { debateId: DEBATE_ID },
      { caller: "cli", userEmail: OWNER_EMAIL },
    );

    expect(row).toEqual({
      id: DEBATE_ID,
      claim: CLAIM,
      inputType: "text",
      status: "pending",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
  });
});

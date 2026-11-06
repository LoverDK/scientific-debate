import { isActionContractError } from "@agent-native/core/action";
import {
  closeDbExec,
  getDatabaseUrl,
  getDbExec,
  runMigrations,
  withMigrationRuntime,
} from "@agent-native/core/db";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { getDb, schema } from "../server/db/index.js";
import {
  DEBATES_APP_MIGRATIONS_TABLE,
  debatesAppMigrations,
} from "../server/db/migrations.js";
import {
  DebateLlmInvalidCitationError,
  DebateLlmInvalidOutputError,
  DebateLlmModelCallError,
  type DebateRoleOutput,
  type JudgeOutput,
  type OpponentOutput,
  type ProponentOutput,
  type RunDebateRoleInput,
} from "../server/lib/debate-llm.js";
import {
  DebateRunNotEligibleError,
  createQueuedRun,
} from "../server/lib/debate-run.js";
import cancelRun from "./cancel-debate-run.js";
import startDebateRun, {
  DEFAULT_DEBATE_RUN_MODEL_ID,
  isStartDebateRunTestRuntime,
  setStartDebateRunTestOverrides,
} from "./start-debate-run.js";

const OWNER = "owner@example.test";
const OTHER = "other@example.test";
const DEBATE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MISSING = "00000000-0000-4000-8000-000000000000";
const PAPER_ID = "pppppppp-pppp-4ppp-8ppp-pppppppppppp";
const LINK_ID = "llllllll-llll-4lll-8lll-llllllllllll";
const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const EXT_ID = "W100";

function assertMemoryDatabaseUrl(): void {
  if (process.env.DATABASE_URL !== "pglite:memory") {
    throw new Error(
      `Refusing to run start-debate-run tests: DATABASE_URL must be exactly "pglite:memory" (got ${JSON.stringify(process.env.DATABASE_URL)}). This suite must not touch ./data/pglite.`,
    );
  }
  const resolved = getDatabaseUrl();
  if (!resolved.toLowerCase().startsWith("pglite:memory")) {
    throw new Error(
      `Refusing to run start-debate-run tests: resolved database URL is not memory PGlite (got ${JSON.stringify(resolved)}).`,
    );
  }
}

assertMemoryDatabaseUrl();

async function applyAppMigrations(): Promise<void> {
  assertMemoryDatabaseUrl();
  await withMigrationRuntime(async () => {
    await runMigrations(debatesAppMigrations, {
      table: DEBATES_APP_MIGRATIONS_TABLE,
    })(undefined);
  });
}

async function clearAppTables(): Promise<void> {
  assertMemoryDatabaseUrl();
  const db = getDb();
  await db.delete(schema.debateMessages);
  await db.delete(schema.debateRuns);
  await db.delete(schema.debatePapers);
  await db.delete(schema.papers);
  await db.delete(schema.debates);
}

async function seedOwnedDebateWithPaper(
  debateId = DEBATE_A,
  ownerEmail = OWNER,
): Promise<void> {
  const db = getDb();
  await db.insert(schema.debates).values({
    id: debateId,
    claim: "Scaling improves reasoning.",
    inputType: "text",
    status: "pending",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ownerEmail,
    orgId: null,
    visibility: "private",
  });
  await db.insert(schema.papers).values({
    id: PAPER_ID,
    source: "openalex",
    externalId: EXT_ID,
    providerUrl: `https://openalex.org/${EXT_ID}`,
    title: "Paper One",
    authorsJson: JSON.stringify(["Ada"]),
    year: 2020,
    doi: null,
    url: null,
    abstract: "Abs",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  });
  await db.insert(schema.debatePapers).values({
    id: LINK_ID,
    debateId,
    paperId: PAPER_ID,
    addedByEmail: ownerEmail,
    addedAt: FIXED_NOW,
  });
}

function proponent(): ProponentOutput {
  return {
    role: "proponent",
    summary: "Proponent summary",
    arguments: [
      {
        claim: "Supports",
        support: "Because W100",
        citedExternalIds: [EXT_ID],
      },
    ],
    citedExternalIds: [EXT_ID],
  };
}

function opponent(): OpponentOutput {
  return {
    role: "opponent",
    summary: "Opponent summary",
    arguments: [
      {
        claim: "Challenges",
        support: "Limits of W100",
        citedExternalIds: [EXT_ID],
      },
    ],
    citedExternalIds: [EXT_ID],
  };
}

function judge(): JudgeOutput {
  return {
    role: "judge",
    summary: "Judge summary",
    arguments: [
      {
        claim: "Mixed",
        support: "Weighing W100",
        citedExternalIds: [EXT_ID],
      },
    ],
    citedExternalIds: [EXT_ID],
    verdict: "insufficient_evidence",
    confidence: 0.4,
    limitations: ["Small evidence set"],
  };
}

function mockRoleRunner(
  impl?: (input: RunDebateRoleInput) => Promise<DebateRoleOutput>,
) {
  const calls: RunDebateRoleInput[] = [];
  const run = vi.fn(async (input: RunDebateRoleInput) => {
    calls.push(input);
    if (impl) return impl(input);
    if (input.role === "proponent") return proponent();
    if (input.role === "opponent") return opponent();
    return judge();
  });
  return { run, calls };
}

function mockSecret(ok = true) {
  return vi.fn(async () =>
    ok
      ? { value: "test-key-not-real", lookupFailed: false }
      : { value: null, lookupFailed: false },
  );
}

async function expectActionFailure(
  run: Promise<unknown>,
  statusCode: number,
  messageIncludes?: string | RegExp,
): Promise<Error> {
  try {
    await run;
    expect.fail(`Expected status ${statusCode}`);
  } catch (error) {
    expect(isActionContractError(error)).toBe(true);
    if (!isActionContractError(error)) throw error;
    expect(error.statusCode).toBe(statusCode);
    const message = String(error.message);
    expect(message).not.toMatch(/sk-|password|postgres:\/\/|api[_-]?key\s*[:=]/i);
    if (typeof messageIncludes === "string") {
      expect(message).toContain(messageIncludes);
    } else if (messageIncludes) {
      expect(message).toMatch(messageIncludes);
    }
    return error as Error;
  }
  throw new Error("unreachable");
}

async function getMirror(debateId = DEBATE_A) {
  const [row] = await getDb()
    .select({
      status: schema.debates.status,
      currentRunId: schema.debates.currentRunId,
    })
    .from(schema.debates)
    .where(eq(schema.debates.id, debateId))
    .limit(1);
  return row;
}

async function listRuns(debateId = DEBATE_A) {
  return getDb()
    .select()
    .from(schema.debateRuns)
    .where(eq(schema.debateRuns.debateId, debateId));
}

async function listMessages(runId: string) {
  const { rows } = await getDbExec().execute({
    sql: `SELECT id, role FROM debate_messages WHERE run_id = ?
          ORDER BY CASE role
            WHEN 'proponent' THEN 1
            WHEN 'opponent' THEN 2
            WHEN 'judge' THEN 3
            ELSE 4
          END, id`,
    args: [runId],
  });
  return rows as Array<{ id: string; role: string }>;
}

describe("start-debate-run", () => {
  beforeAll(async () => {
    assertMemoryDatabaseUrl();
    await closeDbExec();
    await applyAppMigrations();
  });

  beforeEach(async () => {
    assertMemoryDatabaseUrl();
    setStartDebateRunTestOverrides(undefined);
    await clearAppTables();
    await seedOwnedDebateWithPaper();
  });

  afterEach(() => {
    setStartDebateRunTestOverrides(undefined);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    setStartDebateRunTestOverrides(undefined);
    await closeDbExec();
  });

  it("preserves partial output when the owner cancels during opponent generation", async () => {
    const owner = { caller: "cli" as const, userEmail: OWNER };
    const { run, calls } = mockRoleRunner(async input => {
      if (input.role === "proponent") return proponent();
      const [running] = await listRuns();
      const args = { runId: running!.id };
      await expectActionFailure(cancelRun.run(args, { caller: "cli" }), 401);
      await expectActionFailure(cancelRun.run(args, { ...owner, userEmail: OTHER }), 404);
      await expectActionFailure(cancelRun.run({runId: MISSING}, owner), 404);
      expect(await cancelRun.run(args, owner)).toMatchObject({status: "failed"});
      return opponent();
    });
    setStartDebateRunTestOverrides({ runDebateRole: run, resolveOpenRouterSecret: mockSecret() });
    await expectActionFailure(startDebateRun.run({ debateId: DEBATE_A }, owner), 409, "Cancelled by the owner.");
    const [cancelled] = await listRuns();
    expect(cancelled).toMatchObject({status: "failed", errorMessage: "Cancelled by the owner."});
    expect((await listMessages(cancelled!.id)).map(row => row.role)).toEqual(["proponent"]);
    expect(calls.map(call => call.role)).toEqual(["proponent", "opponent"]);
    setStartDebateRunTestOverrides({ runDebateRole: mockRoleRunner().run, resolveOpenRouterSecret: mockSecret() });
    const replacement = await startDebateRun.run({ debateId: DEBATE_A }, owner);
    await expectActionFailure(cancelRun.run({runId: cancelled!.id}, owner), 409);
    await expectActionFailure(cancelRun.run({runId: replacement.runId}, owner), 409);
    expect(await getMirror()).toMatchObject({status: "completed", currentRunId: replacement.runId});
  });

  it("1-4. happy path P→O→J, messages, completed, current_run_id", async () => {
    const { run, calls } = mockRoleRunner();
    setStartDebateRunTestOverrides({
      runDebateRole: run,
      resolveOpenRouterSecret: mockSecret(true),
    });

    const result = await startDebateRun.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER },
    );

    expect(result).toMatchObject({
      success: true,
      debateId: DEBATE_A,
      status: "completed",
      modelId: DEFAULT_DEBATE_RUN_MODEL_ID,
    });
    expect(result.roles.proponent.summary).toBe("Proponent summary");
    expect(result.roles.opponent.summary).toBe("Opponent summary");
    expect(result.roles.judge.summary).toBe("Judge summary");
    expect(calls.map((c) => c.role)).toEqual([
      "proponent",
      "opponent",
      "judge",
    ]);
    expect(calls[1]?.proponentOutput).toEqual(proponent());
    expect(calls[2]?.opponentOutput).toEqual(opponent());

    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.modelId).toBe(DEFAULT_DEBATE_RUN_MODEL_ID);

    const messages = await listMessages(result.runId);
    expect(messages.map((m) => m.role)).toEqual([
      "proponent",
      "opponent",
      "judge",
    ]);
    expect(result.roles.proponent.messageId).toBe(messages[0]?.id);
    expect(result.roles.opponent.messageId).toBe(messages[1]?.id);
    expect(result.roles.judge.messageId).toBe(messages[2]?.id);

    expect(await getMirror()).toEqual({
      status: "completed",
      currentRunId: result.runId,
    });
  });

  it("5. unauthenticated → 401", async () => {
    setStartDebateRunTestOverrides({
      runDebateRole: mockRoleRunner().run,
      resolveOpenRouterSecret: mockSecret(true),
    });
    await expectActionFailure(
      startDebateRun.run({ debateId: DEBATE_A }, { caller: "cli" }),
      401,
      "Sign in",
    );
    expect(await listRuns()).toHaveLength(0);
  });

  it("6. non-owner → 404", async () => {
    setStartDebateRunTestOverrides({
      runDebateRole: mockRoleRunner().run,
      resolveOpenRouterSecret: mockSecret(true),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OTHER },
      ),
      404,
      "Debate not found",
    );
    expect(await listRuns()).toHaveLength(0);
  });

  it("7. missing debate → 404", async () => {
    setStartDebateRunTestOverrides({
      runDebateRole: mockRoleRunner().run,
      resolveOpenRouterSecret: mockSecret(true),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: MISSING },
        { caller: "cli", userEmail: OWNER },
      ),
      404,
      "Debate not found",
    );
  });

  it("8. no papers → 400", async () => {
    await getDb().delete(schema.debatePapers);
    setStartDebateRunTestOverrides({
      runDebateRole: mockRoleRunner().run,
      resolveOpenRouterSecret: mockSecret(true),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      400,
      "no attached papers",
    );
    expect(await listRuns()).toHaveLength(0);
  });

  it("9. invalid modelId → 400", async () => {
    await expectActionFailure(
      startDebateRun.run({ debateId: DEBATE_A, modelId: "openai/gpt-4o-mini" },
        { caller: "cli", userEmail: OWNER }), 400,
    );
    setStartDebateRunTestOverrides({
      runDebateRole: mockRoleRunner().run,
      resolveOpenRouterSecret: mockSecret(true),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A, modelId: "bad model id" },
        { caller: "cli", userEmail: OWNER },
      ),
      400,
    );
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A, modelId: "acme/model\u0000x" },
        { caller: "cli", userEmail: OWNER },
      ),
      400,
    );
    expect(await listRuns()).toHaveLength(0);
  });

  it("10. default modelId applies when omitted or blank", async () => {
    const { run, calls } = mockRoleRunner();
    setStartDebateRunTestOverrides({
      runDebateRole: run,
      resolveOpenRouterSecret: mockSecret(true),
    });
    const result = await startDebateRun.run(
      { debateId: DEBATE_A, modelId: "   " },
      { caller: "cli", userEmail: OWNER },
    );
    expect(result.modelId).toBe(DEFAULT_DEBATE_RUN_MODEL_ID);
    expect(calls.every((c) => c.modelId === DEFAULT_DEBATE_RUN_MODEL_ID)).toBe(
      true,
    );
  });

  it("11-12. active run conflict 409; repeat start after complete works", async () => {
    const { run } = mockRoleRunner();
    setStartDebateRunTestOverrides({
      runDebateRole: run,
      resolveOpenRouterSecret: mockSecret(true),
    });
    const first = await startDebateRun.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER },
    );
    expect(first.status).toBe("completed");

    // Simulate a stuck active run by creating a queued run while completed exists
    // is allowed only after complete; create another active while first is still
    // active by inserting via createQueuedRun before finishing:
    await clearAppTables();
    await seedOwnedDebateWithPaper();
    setStartDebateRunTestOverrides({
      runDebateRole: run,
      resolveOpenRouterSecret: mockSecret(true),
    });
    // Leave an active run without completing the action
    const pack = {
      debateId: DEBATE_A,
      claim: "Scaling improves reasoning.",
      papers: [
        {
          id: PAPER_ID,
          externalId: EXT_ID,
          title: "Paper One",
          authors: ["Ada"],
          year: 2020,
          doi: null,
          url: null,
          providerUrl: `https://openalex.org/${EXT_ID}`,
          abstract: "Abs",
          abstractTruncated: false,
        },
      ],
    };
    await createQueuedRun({
      db: getDb(),
      debateId: DEBATE_A,
      modelId: "m",
      evidencePack: pack,
      createdByEmail: OWNER,
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      409,
      "already in progress",
    );

    // After completing the active one via a normal action path on a fresh debate
    await clearAppTables();
    await seedOwnedDebateWithPaper();
    setStartDebateRunTestOverrides({
      runDebateRole: mockRoleRunner().run,
      resolveOpenRouterSecret: mockSecret(true),
    });
    const a = await startDebateRun.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER },
    );
    const b = await startDebateRun.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER },
    );
    expect(a.runId).not.toBe(b.runId);
    expect(await getMirror()).toEqual({
      status: "completed",
      currentRunId: b.runId,
    });
    expect(await listRuns()).toHaveLength(2);
  });

  it("13. missing secret → 400 and no run", async () => {
    setStartDebateRunTestOverrides({
      runDebateRole: mockRoleRunner().run,
      resolveOpenRouterSecret: mockSecret(false),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      400,
      "OpenRouter API key",
    );
    expect(await listRuns()).toHaveLength(0);
  });

  it("14. proponent failure → failRun", async () => {
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: mockSecret(true),
      runDebateRole: vi.fn(async () => {
        throw new DebateLlmModelCallError("proponent timed out");
      }),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      502,
    );
    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(await listMessages(runs[0]!.id)).toHaveLength(0);
    expect(await getMirror()).toEqual({
      status: "failed",
      currentRunId: runs[0]!.id,
    });
  });

  it("15. opponent failure keeps proponent message", async () => {
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: mockSecret(true),
      runDebateRole: vi.fn(async (input: RunDebateRoleInput) => {
        if (input.role === "proponent") return proponent();
        throw new DebateLlmInvalidOutputError("opponent bad");
      }),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      502,
    );
    const runs = await listRuns();
    expect(runs[0]?.status).toBe("failed");
    expect((await listMessages(runs[0]!.id)).map((m) => m.role)).toEqual([
      "proponent",
    ]);
  });

  it("16. judge failure keeps P+O messages", async () => {
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: mockSecret(true),
      runDebateRole: vi.fn(async (input: RunDebateRoleInput) => {
        if (input.role === "proponent") return proponent();
        if (input.role === "opponent") return opponent();
        throw new DebateLlmModelCallError("judge failed");
      }),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      502,
    );
    const runs = await listRuns();
    expect(runs[0]?.status).toBe("failed");
    expect((await listMessages(runs[0]!.id)).map((m) => m.role)).toEqual([
      "proponent",
      "opponent",
    ]);
  });

  it("17. illegal citation → 502 and failed run", async () => {
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: mockSecret(true),
      runDebateRole: vi.fn(async () => {
        throw new DebateLlmInvalidCitationError("cited W999");
      }),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      502,
      "cited",
    );
    expect((await listRuns())[0]?.status).toBe("failed");
  });

  it("18. persistRoleMessage failure → failRun", async () => {
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: mockSecret(true),
      runDebateRole: mockRoleRunner().run,
      persistRoleMessage: vi.fn(async () => {
        throw new DebateRunNotEligibleError("persist blocked");
      }),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      409,
    );
    const runs = await listRuns();
    expect(runs[0]?.status).toBe("failed");
    expect(await listMessages(runs[0]!.id)).toHaveLength(0);
  });

  it("19. completeRun failure → failRun", async () => {
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: mockSecret(true),
      runDebateRole: mockRoleRunner().run,
      completeRun: vi.fn(async () => {
        throw new DebateRunNotEligibleError("complete blocked");
      }),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      409,
    );
    const runs = await listRuns();
    expect(runs[0]?.status).toBe("failed");
    expect((await listMessages(runs[0]!.id)).map((m) => m.role)).toEqual([
      "proponent",
      "opponent",
      "judge",
    ]);
  });

  it("20. failRun secondary failure → 500 cannot confirm failed", async () => {
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: mockSecret(true),
      runDebateRole: vi.fn(async () => {
        throw new DebateLlmModelCallError("boom");
      }),
      failRun: vi.fn(async () => {
        throw new Error("failRun unavailable");
      }),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      500,
      "could not be marked failed",
    );
    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("running");
  });

  it("21. after complete, later error does not mark failed", async () => {
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: mockSecret(true),
      runDebateRole: mockRoleRunner().run,
      afterComplete: () => {
        throw new Error("response assembly failed");
      },
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      500,
    );
    const runs = await listRuns();
    expect(runs[0]?.status).toBe("completed");
    expect(await getMirror()).toEqual({
      status: "completed",
      currentRunId: runs[0]!.id,
    });
  });

  it("22-23. failure paths scrub secrets; no real network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: vi.fn(async () => ({
        value: null,
        lookupFailed: false,
      })),
      runDebateRole: vi.fn(async () => {
        throw new Error("should not be called");
      }),
    });
    const err = await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      400,
    );
    expect(String(err.message)).not.toMatch(/sk-|OPENROUTER_API_KEY\s*=/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("24. claimRun failure → failRun", async () => {
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: mockSecret(true),
      runDebateRole: mockRoleRunner().run,
      claimRun: vi.fn(async () => {
        throw new DebateRunNotEligibleError("not queued");
      }),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      409,
    );
    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(await listMessages(runs[0]!.id)).toHaveLength(0);
  });

  it("25. Secret lookup failed → 503 and no run", async () => {
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: vi.fn(async () => ({
        value: null,
        lookupFailed: true,
      })),
      runDebateRole: vi.fn(async () => {
        throw new Error("should not run");
      }),
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      503,
      "Credential store lookup failed",
    );
    expect(await listRuns()).toHaveLength(0);
  });

  it("26. Evidence Snapshot round-trip: LLM packs match DB snapshot", async () => {
    const seen: unknown[] = [];
    const { run } = mockRoleRunner(async (input) => {
      seen.push(input.evidencePack);
      if (input.role === "proponent") return proponent();
      if (input.role === "opponent") return opponent();
      return judge();
    });
    setStartDebateRunTestOverrides({
      runDebateRole: run,
      resolveOpenRouterSecret: mockSecret(true),
    });

    const result = await startDebateRun.run(
      { debateId: DEBATE_A },
      { caller: "cli", userEmail: OWNER },
    );

    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);

    const runs = await listRuns();
    const stored = JSON.parse(String(runs[0]?.evidenceSnapshotJson));
    expect(seen[0]).toEqual(stored);
    expect(stored.debateId).toBe(DEBATE_A);
    expect(stored.papers[0]?.externalId).toBe(EXT_ID);
    expect(result.runId).toBe(runs[0]?.id);
  });

  it("27. snapshot parse failure → no LLM, failRun", async () => {
    const llm = vi.fn(async () => {
      throw new Error("LLM must not run");
    });
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: mockSecret(true),
      runDebateRole: llm,
      createQueuedRun: async (input) => {
        const queued = await createQueuedRun(input);
        return {
          ...queued,
          evidenceSnapshotJson: "{not-valid-json",
        };
      },
    });
    await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      400,
    );
    expect(llm).not.toHaveBeenCalled();
    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(String(runs[0]?.errorMessage)).toBe(
      "Debate run validation failed.",
    );
    expect(await listMessages(runs[0]!.id)).toHaveLength(0);
  });

  it("28. unknown error with Secret/Prompt is redacted in DB and client", async () => {
    const leak =
      "boom sk-live-ABCDEF123 prompt=<claim>Scaling improves reasoning.</claim> api_key=supersecret";
    setStartDebateRunTestOverrides({
      resolveOpenRouterSecret: mockSecret(true),
      runDebateRole: vi.fn(async () => {
        throw new Error(leak);
      }),
    });
    const err = await expectActionFailure(
      startDebateRun.run(
        { debateId: DEBATE_A },
        { caller: "cli", userEmail: OWNER },
      ),
      500,
      "unexpectedly",
    );
    expect(String(err.message)).not.toContain("sk-live");
    expect(String(err.message)).not.toContain("Scaling improves");
    expect(String(err.message)).not.toContain("supersecret");

    const runs = await listRuns();
    expect(runs[0]?.status).toBe("failed");
    const stored = String(runs[0]?.errorMessage ?? "");
    expect(stored).toBe("Debate run failed.");
    expect(stored).not.toContain("sk-live");
    expect(stored).not.toContain("Scaling");
    expect(stored).not.toContain("supersecret");
    expect(stored).not.toContain("<claim>");
  });

  it("29. setStartDebateRunTestOverrides rejects outside Vitest", () => {
    expect(isStartDebateRunTestRuntime()).toBe(true);
    const prev = process.env.VITEST;
    try {
      delete process.env.VITEST;
      expect(() =>
        setStartDebateRunTestOverrides({
          resolveOpenRouterSecret: mockSecret(true),
        }),
      ).toThrow(/only available under Vitest/i);
    } finally {
      process.env.VITEST = prev;
      setStartDebateRunTestOverrides(undefined);
    }
  });
});

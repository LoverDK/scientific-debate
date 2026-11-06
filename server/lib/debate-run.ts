import { and, eq, sql } from "drizzle-orm";
import { isUniqueViolation } from "@agent-native/core/db";

import { getDb, schema } from "../db/index.js";
import type { EvidencePack } from "./debate-evidence.js";
import type { DebateRole, DebateRoleOutput } from "./debate-llm.js";

export type DebateDb = ReturnType<typeof getDb>;

export type DebateRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export type DebateRunRecord = {
  id: string;
  debateId: string;
  status: DebateRunStatus;
  modelId: string;
  evidenceSnapshotJson: string;
  createdByEmail: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  heartbeatAt: string | null;
  errorMessage: string | null;
};

export type DebateMessageRecord = {
  id: string;
  runId: string;
  role: DebateRole;
  payloadJson: string;
  citedExternalIdsJson: string;
  createdAt: string;
};

type DebateRunErrorOptions = {
  statusCode: number;
  code: string;
};

/** Base domain error for debate run persistence. */
export class DebateRunError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, options: DebateRunErrorOptions) {
    super(message);
    this.name = "DebateRunError";
    this.statusCode = options.statusCode;
    this.code = options.code;
  }
}

export class DebateRunActiveConflictError extends DebateRunError {
  constructor(
    message = "A debate run is already in progress for this debate.",
  ) {
    super(message, {
      statusCode: 409,
      code: "debate_run_active_conflict",
    });
    this.name = "DebateRunActiveConflictError";
  }
}

export class DebateRunNotEligibleError extends DebateRunError {
  constructor(
    message = "Debate run is not eligible for this state transition.",
  ) {
    super(message, {
      statusCode: 409,
      code: "debate_run_not_eligible",
    });
    this.name = "DebateRunNotEligibleError";
  }
}

export class DebateRunMessageConflictError extends DebateRunError {
  constructor(
    message = "A message for this role already exists on the debate run.",
  ) {
    super(message, {
      statusCode: 409,
      code: "debate_run_message_conflict",
    });
    this.name = "DebateRunMessageConflictError";
  }
}

export class DebateRunValidationError extends DebateRunError {
  constructor(message: string) {
    super(message, {
      statusCode: 400,
      code: "debate_run_validation_error",
    });
    this.name = "DebateRunValidationError";
  }
}

export class DebateRunSerializationError extends DebateRunError {
  constructor(message = "Failed to serialize debate run payload.") {
    super(message, {
      statusCode: 500,
      code: "debate_run_serialization_error",
    });
    this.name = "DebateRunSerializationError";
  }
}

export function isDebateRunError(error: unknown): error is DebateRunError {
  return error instanceof DebateRunError;
}

/** Walk Drizzle/PGlite wrapper causes so 23505 / duplicate-key is visible. */
function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (isUniqueViolation(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  const message = String(
    error && typeof error === "object" && "message" in error
      ? (error as { message?: unknown }).message
      : error,
  ).toLowerCase();
  return (
    message.includes("unique") ||
    message.includes("duplicate key") ||
    message.includes("23505")
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function asRunStatus(value: string): DebateRunStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed"
  ) {
    return value;
  }
  throw new DebateRunValidationError(`Unexpected debate run status: ${value}`);
}

function mapRunRow(row: typeof schema.debateRuns.$inferSelect): DebateRunRecord {
  return {
    id: row.id,
    debateId: row.debateId,
    status: asRunStatus(row.status),
    modelId: row.modelId,
    evidenceSnapshotJson: row.evidenceSnapshotJson,
    createdByEmail: row.createdByEmail,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    updatedAt: row.updatedAt,
    heartbeatAt: row.heartbeatAt ?? null,
    errorMessage: row.errorMessage ?? null,
  };
}

function safeJsonStringify(value: unknown, label: string): string {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string") {
      throw new Error("JSON.stringify returned non-string");
    }
    return json;
  } catch {
    throw new DebateRunSerializationError(
      `Failed to serialize ${label}.`,
    );
  }
}

export function parseEvidenceSnapshot(json: string): EvidencePack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DebateRunValidationError(
      "evidence_snapshot_json is not valid JSON.",
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as EvidencePack).debateId !== "string" ||
    typeof (parsed as EvidencePack).claim !== "string" ||
    !Array.isArray((parsed as EvidencePack).papers)
  ) {
    throw new DebateRunValidationError(
      "evidence_snapshot_json is not a valid EvidencePack.",
    );
  }
  return parsed as EvidencePack;
}

/**
 * Update debates.status only when this run still owns current_run_id.
 * Returns whether any debate row was updated. Does not throw on 0 rows.
 */
async function updateDebateMirrorIfOwned(
  tx: DebateDb,
  input: {
    debateId: string;
    runId: string;
    mirrorStatus: "debating" | "completed" | "failed";
    now: string;
    /** When taking ownership (create), also set current_run_id. */
    takeOwnership?: boolean;
  },
): Promise<number> {
  const { debates } = schema;
  if (input.takeOwnership) {
    const updated = await tx
      .update(debates)
      .set({
        status: input.mirrorStatus,
        currentRunId: input.runId,
        updatedAt: input.now,
      })
      .where(eq(debates.id, input.debateId))
      .returning({ id: debates.id });
    return updated.length;
  }

  const updated = await tx
    .update(debates)
    .set({
      status: input.mirrorStatus,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(debates.id, input.debateId),
        eq(debates.currentRunId, input.runId),
      ),
    )
    .returning({ id: debates.id });
  return updated.length;
}

export type CreateQueuedRunInput = {
  db: DebateDb;
  debateId: string;
  modelId: string;
  evidencePack: EvidencePack;
  createdByEmail: string;
};

/**
 * Insert a queued run and take mirror ownership (status=debating, current_run_id).
 * Relies on partial unique index for active-run exclusivity.
 * INSERT or debate mirror UPDATE failure rolls back the whole transaction.
 */
export async function createQueuedRun(
  input: CreateQueuedRunInput,
): Promise<DebateRunRecord> {
  const modelId = input.modelId.trim();
  const createdByEmail = input.createdByEmail.trim();
  if (!modelId) {
    throw new DebateRunValidationError("modelId must be a non-empty string.");
  }
  if (!createdByEmail) {
    throw new DebateRunValidationError(
      "createdByEmail must be a non-empty string.",
    );
  }
  if (input.evidencePack.debateId !== input.debateId) {
    throw new DebateRunValidationError(
      "EvidencePack.debateId does not match debateId.",
    );
  }

  const evidenceSnapshotJson = safeJsonStringify(
    input.evidencePack,
    "EvidencePack snapshot",
  );
  const now = nowIso();
  const id = crypto.randomUUID();
  const { debateRuns } = schema;

  try {
    const created = await input.db.transaction(async (tx) => {
      const { debates } = schema;
      const [debate] = await tx.select({
        claim: debates.claim, archivedAt: debates.archivedAt,
      }).from(debates).where(and(eq(debates.id, input.debateId), eq(debates.ownerEmail, createdByEmail)))
        .for("update");
      if (!debate) throw new DebateRunValidationError("Debate not found.");
      if (debate.archivedAt !== null || debate.claim !== input.evidencePack.claim) {
        throw new DebateRunNotEligibleError("The debate was archived or its claim changed.");
      }

      const inserted = await tx
        .insert(debateRuns)
        .values({
          id,
          debateId: input.debateId,
          status: "queued",
          modelId,
          evidenceSnapshotJson,
          createdByEmail,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          finishedAt: null,
          heartbeatAt: null,
          errorMessage: null,
        })
        .returning();

      const row = inserted[0];
      if (!row) {
        throw new DebateRunValidationError("Failed to create debate run.");
      }

      const mirrorRows = await updateDebateMirrorIfOwned(tx, {
        debateId: input.debateId,
        runId: row.id,
        mirrorStatus: "debating",
        now,
        takeOwnership: true,
      });
      if (mirrorRows === 0) {
        throw new DebateRunValidationError(
          "Debate not found; queued run was not created.",
        );
      }

      return mapRunRow(row);
    });
    return created;
  } catch (error) {
    if (error instanceof DebateRunError) throw error;
    if (isUniqueConstraintError(error)) {
      throw new DebateRunActiveConflictError();
    }
    throw error;
  }
}

export type ClaimRunInput = {
  db: DebateDb;
  runId: string;
};

/**
 * Conditional queued → running. Returns the claimed row or throws if ineligible.
 */
export async function claimRun(
  input: ClaimRunInput,
): Promise<DebateRunRecord> {
  const now = nowIso();
  const { debateRuns } = schema;

  const updated = await input.db
    .update(debateRuns)
    .set({
      status: "running",
      startedAt: now,
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(
      and(eq(debateRuns.id, input.runId), eq(debateRuns.status, "queued")),
    )
    .returning();

  const row = updated[0];
  if (!row) {
    throw new DebateRunNotEligibleError(
      "Debate run could not be claimed (not queued).",
    );
  }
  return mapRunRow(row);
}

export type PersistRoleMessageInput = {
  db: DebateDb;
  runId: string;
  role: DebateRole;
  usage?: import("./debate-llm.js").RoleUsage | undefined;
  output: DebateRoleOutput;
};

/**
 * Atomically heartbeat a running run and insert the role message.
 */
export async function persistRoleMessage(
  input: PersistRoleMessageInput,
): Promise<DebateMessageRecord> {
  if (input.output.role !== input.role) {
    throw new DebateRunValidationError(
      "Role output.role does not match the message role.",
    );
  }

  const payloadJson = safeJsonStringify(input.output, "role payload");
  const citedExternalIdsJson = safeJsonStringify(
    input.output.citedExternalIds,
    "citedExternalIds",
  );
  const now = nowIso();
  const messageId = crypto.randomUUID();
  const { debateRuns, debateMessages } = schema;

  try {
    return await input.db.transaction(async (tx) => {
      const claimed = await tx
        .update(debateRuns)
        .set({
          heartbeatAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(debateRuns.id, input.runId),
            eq(debateRuns.status, "running"),
          ),
        )
        .returning({ id: debateRuns.id });

      if (!claimed[0]) {
        throw new DebateRunNotEligibleError(
          "Debate run is not running; message was not written.",
        );
      }

      const inserted = await tx
        .insert(debateMessages)
        .values({
          id: messageId,
          runId: input.runId,
          role: input.role,
          payloadJson,
          usageJson: input.usage ? JSON.stringify(input.usage) : null,
          citedExternalIdsJson,
          createdAt: now,
        })
        .returning();

      const row = inserted[0];
      if (!row) {
        throw new DebateRunValidationError(
          "Failed to persist debate role message.",
        );
      }

      return {
        id: row.id,
        runId: row.runId,
        role: row.role as DebateRole,
        payloadJson: row.payloadJson,
        citedExternalIdsJson: row.citedExternalIdsJson,
        createdAt: row.createdAt,
      };
    });
  } catch (error) {
    if (error instanceof DebateRunError) throw error;
    if (isUniqueConstraintError(error)) {
      throw new DebateRunMessageConflictError();
    }
    throw error;
  }
}

export type CompleteRunInput = {
  db: DebateDb;
  runId: string;
};

/**
 * Conditional running → completed, then mirror update if current_run_id matches.
 * Mirror 0-row updates do not roll back a successful run terminalization.
 */
export async function completeRun(
  input: CompleteRunInput,
): Promise<DebateRunRecord> {
  const now = nowIso();
  const { debateRuns } = schema;

  return input.db.transaction(async (tx) => {
    const updated = await tx
      .update(debateRuns)
      .set({
        status: "completed",
        finishedAt: now,
        updatedAt: now,
        heartbeatAt: now,
        errorMessage: null,
      })
      .where(
        and(eq(debateRuns.id, input.runId), eq(debateRuns.status, "running")),
      )
      .returning();

    const row = updated[0];
    if (!row) {
      throw new DebateRunNotEligibleError(
        "Debate run could not be completed (not running).",
      );
    }

    // Ownership fence: only the current_run_id owner may write the mirror.
    // Zero rows here is intentional (stale run) and must not undo the run UPDATE.
    await updateDebateMirrorIfOwned(tx, {
      debateId: row.debateId,
      runId: row.id,
      mirrorStatus: "completed",
      now,
    });

    return mapRunRow(row);
  });
}

export type FailRunInput = {
  db: DebateDb;
  runId: string;
  errorMessage: string;
};

/**
 * Conditional queued|running → failed, then mirror update if current_run_id matches.
 * Mirror 0-row updates do not roll back a successful run terminalization.
 * Does not delete existing debate_messages.
 */
export async function failRun(
  input: FailRunInput,
): Promise<DebateRunRecord> {
  const trimmed =
    typeof input.errorMessage === "string" ? input.errorMessage.trim() : "";
  if (!trimmed) {
    throw new DebateRunValidationError(
      "errorMessage must be a non-empty string.",
    );
  }
  // Keep stored errors short and free of accidental secret-looking blobs.
  const errorMessage = trimmed.slice(0, 500);
  const now = nowIso();
  const { debateRuns } = schema;

  return input.db.transaction(async (tx) => {
    const updated = await tx
      .update(debateRuns)
      .set({
        status: "failed",
        finishedAt: now,
        updatedAt: now,
        heartbeatAt: now,
        errorMessage,
      })
      .where(
        and(
          eq(debateRuns.id, input.runId),
          sql`${debateRuns.status} IN ('queued', 'running')`,
        ),
      )
      .returning();

    const row = updated[0];
    if (!row) {
      throw new DebateRunNotEligibleError(
        "Debate run could not be failed (already terminal or missing).",
      );
    }

    // Ownership fence: only the current_run_id owner may write the mirror.
    // Zero rows here is intentional (stale run) and must not undo the run UPDATE.
    await updateDebateMirrorIfOwned(tx, {
      debateId: row.debateId,
      runId: row.id,
      mirrorStatus: "failed",
      now,
    });

    return mapRunRow(row);
  });
}

/** Test/helper read of a run by id. */
export async function getDebateRunById(
  db: DebateDb,
  runId: string,
): Promise<DebateRunRecord | null> {
  const { debateRuns } = schema;
  const [row] = await db
    .select()
    .from(debateRuns)
    .where(eq(debateRuns.id, runId))
    .limit(1);
  return row ? mapRunRow(row) : null;
}

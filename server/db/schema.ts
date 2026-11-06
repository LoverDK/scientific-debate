import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { ownableColumns } from "@agent-native/core/db/schema";

/**
 * Scientific Debate — one row per scientific claim under evaluation.
 * Status values: pending | researching | debating | completed | failed
 * Input types: text | paper
 */
export const debates = pgTable("debates", {
  id: text("id").primaryKey(),
  claim: text("claim").notNull(),
  inputType: text("input_type").notNull().default("text"),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
  /**
   * Ownership handle for debates.status mirror updates.
   * Set by createQueuedRun; complete/fail only mutate the mirror when this
   * equals the finalizing run id. Nullable for pre-v4 rows.
   */
  archivedAt: text("archived_at"),
  currentRunId: text("current_run_id"),
  ...ownableColumns(),
});

/**
 * Cached scholarly paper metadata (OpenAlex-first).
 * Global by (source, external_id); not ownable — ownership lives on debates /
 * debate_papers.
 */
export const papers = pgTable(
  "papers",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    providerUrl: text("provider_url").notNull(),
    title: text("title"),
    venue: text("venue"),
    authorsJson: text("authors_json").notNull().default("[]"),
    year: integer("year"),
    doi: text("doi"),
    abstract: text("abstract"),
    citationCount: integer("citation_count"),
    url: text("url"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    uniqueIndex("papers_source_external_id_uidx").on(
      table.source,
      table.externalId,
    ),
  ],
);

/**
 * Links a debate to a cached paper. Owner checks happen in Actions against
 * debates.owner_email; this table stores who attached the link.
 */
export const debatePapers = pgTable(
  "debate_papers",
  {
    id: text("id").primaryKey(),
    debateId: text("debate_id")
      .notNull()
      .references(() => debates.id, { onDelete: "cascade" }),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, { onDelete: "restrict" }),
    addedAt: text("added_at")
      .notNull()
      .default(sql`now()`),
    addedByEmail: text("added_by_email").notNull(),
    /** Agent/heuristic stance: supports | opposes | uncertain */
    stance: text("stance"),
    stanceRationale: text("stance_rationale"),
  },
  (table) => [
    // Also serves debate_id lookups (leftmost prefix); no separate debate_id index.
    uniqueIndex("debate_papers_debate_id_paper_id_uidx").on(
      table.debateId,
      table.paperId,
    ),
  ],
);

/**
 * One serial debate engine attempt (Proponent → Opponent → Judge).
 * Status values: queued | running | completed | failed
 * Authority for run lifecycle; debates.status remains a denormalized mirror.
 */
export const debateRuns = pgTable(
  "debate_runs",
  {
    id: text("id").primaryKey(),
    debateId: text("debate_id")
      .notNull()
      .references(() => debates.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    modelId: text("model_id").notNull(),
    evidenceSnapshotJson: text("evidence_snapshot_json").notNull(),
    createdByEmail: text("created_by_email").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`now()`),
    heartbeatAt: text("heartbeat_at"),
    errorMessage: text("error_message"),
  },
  (table) => [
    // At most one active (queued|running) run per debate.
    uniqueIndex("debate_runs_one_active_uidx")
      .on(table.debateId)
      .where(sql`${table.status} IN ('queued', 'running')`),
  ],
);

/**
 * One structured message per role within a debate run (MVP: UNIQUE run+role).
 */
export const debateMessages = pgTable(
  "debate_messages",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => debateRuns.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    usageJson: text("usage_json"),
    payloadJson: text("payload_json").notNull(),
    citedExternalIdsJson: text("cited_external_ids_json").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    uniqueIndex("debate_messages_run_id_role_uidx").on(table.runId, table.role),
  ],
);

/** Optional research workspace grouping multiple debates (module 14 MVP). */
export const researchProjects = pgTable("research_projects", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  createdAt: text("created_at")
    .notNull()
    .default(sql`now()`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`now()`),
  archivedAt: text("archived_at"),
  ...ownableColumns(),
});

export const researchProjectDebates = pgTable(
  "research_project_debates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => researchProjects.id, { onDelete: "cascade" }),
    debateId: text("debate_id")
      .notNull()
      .references(() => debates.id, { onDelete: "cascade" }),
    addedAt: text("added_at")
      .notNull()
      .default(sql`now()`),
    addedByEmail: text("added_by_email").notNull(),
  },
  (table) => [
    uniqueIndex("research_project_debates_uidx").on(
      table.projectId,
      table.debateId,
    ),
  ],
);

/** Owner-authored notes are separate from immutable model output. */
export const debateRunDiscussion = pgTable("debate_run_discussion", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => debateRuns.id, { onDelete: "cascade" }),
  authorEmail: text("author_email").notNull(),
  kind: text("kind").notNull(),
  role: text("role"),
  citedExternalId: text("cited_external_id"),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
}, table => [index("debate_run_discussion_run_idx").on(table.runId, table.createdAt, table.id)]);
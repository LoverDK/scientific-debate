import type { MigrationEntry } from "@agent-native/core/db";

/** Bookkeeping table for Scientific Debate app schema migrations. */
export const DEBATES_APP_MIGRATIONS_TABLE = "debates_app_migrations";

/**
 * Canonical migration list used by `server/plugins/db.ts` and migration tests.
 * Keep SQL here as the single source of truth — do not duplicate elsewhere.
 */
export const debatesAppMigrations: MigrationEntry[] = [
  {
    version: 1,
    name: "debates",
    sql: `CREATE TABLE IF NOT EXISTS debates (
  id TEXT PRIMARY KEY,
  claim TEXT NOT NULL,
  input_type TEXT NOT NULL DEFAULT 'text',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (now()),
  updated_at TEXT NOT NULL DEFAULT (now()),
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE INDEX IF NOT EXISTS debates_owner_org_idx ON debates (owner_email, org_id, created_at)`,
  },
  {
    version: 2,
    name: "papers_and_debate_papers",
    sql: `CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  provider_url TEXT NOT NULL,
  title TEXT,
  authors_json TEXT NOT NULL DEFAULT '[]',
  year INTEGER,
  doi TEXT,
  abstract TEXT,
  citation_count INTEGER,
  url TEXT,
  created_at TEXT NOT NULL DEFAULT (now()),
  updated_at TEXT NOT NULL DEFAULT (now())
);
CREATE UNIQUE INDEX IF NOT EXISTS papers_source_external_id_uidx ON papers (source, external_id);

CREATE TABLE IF NOT EXISTS debate_papers (
  id TEXT PRIMARY KEY,
  debate_id TEXT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE RESTRICT,
  added_at TEXT NOT NULL DEFAULT (now()),
  added_by_email TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS debate_papers_debate_id_paper_id_uidx ON debate_papers (debate_id, paper_id)`,
  },
  {
    version: 3,
    name: "debate_runs_and_messages",
    sql: `CREATE TABLE IF NOT EXISTS debate_runs (
  id TEXT PRIMARY KEY,
  debate_id TEXT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  model_id TEXT NOT NULL,
  evidence_snapshot_json TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now()),
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (now()),
  heartbeat_at TEXT,
  error_message TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS debate_runs_one_active_uidx
  ON debate_runs (debate_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS debate_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES debate_runs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  cited_external_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (now())
);
CREATE UNIQUE INDEX IF NOT EXISTS debate_messages_run_id_role_uidx
  ON debate_messages (run_id, role)`,
  },
  {
    version: 4,
    name: "debates_current_run_id",
    sql: `ALTER TABLE debates ADD COLUMN current_run_id TEXT`,
  },
  {
    version: 5,
    name: "debate_archive_and_paper_venue",
    sql: `ALTER TABLE debates ADD COLUMN archived_at TEXT;
ALTER TABLE papers ADD COLUMN venue TEXT`,
  },
  {
    version: 6,
    name: "research_projects",
    sql: `CREATE TABLE IF NOT EXISTS research_projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (now()),
  updated_at TEXT NOT NULL DEFAULT (now()),
  archived_at TEXT,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE INDEX IF NOT EXISTS research_projects_owner_idx
  ON research_projects (owner_email, created_at);

CREATE TABLE IF NOT EXISTS research_project_debates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
  debate_id TEXT NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (now()),
  added_by_email TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS research_project_debates_uidx
  ON research_project_debates (project_id, debate_id)`,
  },
  {
    version: 7,
    name: "debate_papers_stance",
    sql: `ALTER TABLE debate_papers ADD COLUMN stance TEXT;
ALTER TABLE debate_papers ADD COLUMN stance_rationale TEXT`,
  },
  {
    version: 8,
    name: "debate_run_discussion",
    sql: `CREATE TABLE debate_run_discussion (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES debate_runs(id) ON DELETE CASCADE,
  author_email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('viewpoint', 'question', 'challenge', 'citation_explanation', 'follow_up')),
  role TEXT CHECK (role IN ('proponent', 'opponent', 'judge')),
  cited_external_id TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX debate_run_discussion_run_idx ON debate_run_discussion (run_id, created_at, id)`,
  },
  { version: 9, name: "role_usage", sql: "ALTER TABLE debate_messages ADD COLUMN usage_json TEXT" },
];

import { and, asc, desc, eq } from "drizzle-orm";

import { getDb, schema } from "../db/index.js";

/** Max papers included in one EvidencePack (newest attachments first). */
export const EVIDENCE_PACK_MAX_PAPERS = 10;

/** Max characters retained per paper abstract in the pack. */
export const EVIDENCE_PACK_ABSTRACT_MAX_CHARS = 1200;

export type EvidencePackPaper = {
  id: string;
  externalId: string;
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  url: string | null;
  providerUrl: string;
  abstract: string | null;
  abstractTruncated: boolean;
  stance: "supports" | "opposes" | "uncertain" | null;
};

/** Immutable, JSON-serializable evidence snapshot for one debate run. */
export type EvidencePack = {
  debateId: string;
  claim: string;
  papers: EvidencePackPaper[];
};

export type DebateDb = ReturnType<typeof getDb>;

type DebateEvidenceErrorOptions = {
  statusCode: number;
  code: string;
};

/** Base error for EvidencePack builders; Actions map `statusCode` to HTTP. */
export class DebateEvidenceError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, options: DebateEvidenceErrorOptions) {
    super(message);
    this.name = "DebateEvidenceError";
    this.statusCode = options.statusCode;
    this.code = options.code;
  }
}

/** Debate missing or not owned — same 404 for both (no existence leak). */
export class DebateEvidenceNotFoundError extends DebateEvidenceError {
  constructor(message = "Debate not found.") {
    super(message, {
      statusCode: 404,
      code: "debate_evidence_not_found",
    });
    this.name = "DebateEvidenceNotFoundError";
  }
}

/** Owner debate has no attached papers — map to HTTP 400 upstream. */
export class DebateEvidenceNoPapersError extends DebateEvidenceError {
  constructor(
    message = "Debate has no attached papers. Attach at least one paper before starting a debate run.",
  ) {
    super(message, {
      statusCode: 400,
      code: "debate_evidence_no_papers",
    });
    this.name = "DebateEvidenceNoPapersError";
  }
}

/** Linked paper row is missing required evidence fields. */
export class DebateEvidenceInvalidPaperError extends DebateEvidenceError {
  constructor(message: string) {
    super(message, {
      statusCode: 500,
      code: "debate_evidence_invalid_paper",
    });
    this.name = "DebateEvidenceInvalidPaperError";
  }
}

/** citedExternalIds are not a subset of the EvidencePack whitelist. */
export class DebateEvidenceInvalidCitationError extends DebateEvidenceError {
  constructor(message: string) {
    super(message, {
      statusCode: 400,
      code: "debate_evidence_invalid_citation",
    });
    this.name = "DebateEvidenceInvalidCitationError";
  }
}

export function isDebateEvidenceError(
  error: unknown,
): error is DebateEvidenceError {
  return error instanceof DebateEvidenceError;
}

/** Same contract as list/attach: invalid JSON → []. */
export function parseAuthorsJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/**
 * Truncate to at most EVIDENCE_PACK_ABSTRACT_MAX_CHARS UTF-16 code units
 * without leaving a lone surrogate at the cut boundary.
 */
function truncateAbstract(raw: string | null): {
  abstract: string | null;
  abstractTruncated: boolean;
} {
  if (raw === null) {
    return { abstract: null, abstractTruncated: false };
  }
  if (raw.length <= EVIDENCE_PACK_ABSTRACT_MAX_CHARS) {
    return { abstract: raw, abstractTruncated: false };
  }

  let truncated = raw.slice(0, EVIDENCE_PACK_ABSTRACT_MAX_CHARS);
  const last = truncated.charCodeAt(truncated.length - 1);
  // slice may split a surrogate pair; drop the trailing high surrogate.
  if (isHighSurrogate(last)) {
    truncated = truncated.slice(0, -1);
  } else if (isLowSurrogate(last)) {
    // Defensive: also reject a lone low surrogate at the boundary.
    if (truncated.length === 1) {
      truncated = "";
    } else {
      const prev = truncated.charCodeAt(truncated.length - 2);
      if (!isHighSurrogate(prev)) {
        truncated = truncated.slice(0, -1);
      }
    }
  }

  return {
    abstract: truncated,
    abstractTruncated: true,
  };
}

function requireNonEmptyString(
  value: unknown,
  fieldLabel: string,
  paperId: string,
): string {
  if (typeof value !== "string") {
    throw new DebateEvidenceInvalidPaperError(
      `Paper ${paperId} has invalid ${fieldLabel}.`,
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new DebateEvidenceInvalidPaperError(
      `Paper ${paperId} has empty ${fieldLabel}.`,
    );
  }
  return trimmed;
}

/**
 * Build an immutable EvidencePack for an owned debate from local DB rows only.
 * Does not call OpenAlex or enlarge the evidence set beyond attached papers.
 */
export async function buildDebateEvidencePack(
  db: DebateDb,
  debateId: string,
  ownerEmail: string,
): Promise<EvidencePack> {
  const { debates, papers, debatePapers } = schema;

  const [ownedDebate] = await db
    .select({
      id: debates.id,
      claim: debates.claim,
    })
    .from(debates)
    .where(and(eq(debates.id, debateId), eq(debates.ownerEmail, ownerEmail)))
    .limit(1);

  if (!ownedDebate) {
    throw new DebateEvidenceNotFoundError();
  }

  const rows = await db
    .select({
      id: papers.id,
      externalId: papers.externalId,
      providerUrl: papers.providerUrl,
      title: papers.title,
      authorsJson: papers.authorsJson,
      year: papers.year,
      doi: papers.doi,
      url: papers.url,
      abstract: papers.abstract,
      stance: debatePapers.stance,
    })
    .from(debatePapers)
    .innerJoin(papers, eq(papers.id, debatePapers.paperId))
    .where(eq(debatePapers.debateId, debateId))
    .orderBy(desc(debatePapers.addedAt), asc(debatePapers.id))
    .limit(EVIDENCE_PACK_MAX_PAPERS * 3);

  if (rows.length === 0) {
    throw new DebateEvidenceNoPapersError();
  }

  const hasLabeledStance = rows.some(
    (row) => row.stance === "supports" || row.stance === "opposes",
  );
  // Without stance labels, preserve historical behavior: newest LIMIT 10 first.
  const orderedRows = hasLabeledStance
    ? [
        ...rows.filter((row) => row.stance === "supports"),
        ...rows.filter((row) => row.stance === "opposes"),
        ...rows.filter(
          (row) => row.stance !== "supports" && row.stance !== "opposes",
        ),
      ]
    : rows.slice(0, EVIDENCE_PACK_MAX_PAPERS);

  const seenExternalIds = new Set<string>();
  const packPapers: EvidencePackPaper[] = [];
  let supports = 0;
  let opposes = 0;

  for (const row of orderedRows) {
    if (packPapers.length >= EVIDENCE_PACK_MAX_PAPERS) break;
    if (hasLabeledStance && row.stance === "supports" && supports >= 5) {
      continue;
    }
    if (hasLabeledStance && row.stance === "opposes" && opposes >= 5) {
      continue;
    }
    const externalId = requireNonEmptyString(
      row.externalId,
      "externalId",
      row.id,
    );
    if (seenExternalIds.has(externalId)) {
      continue;
    }
    seenExternalIds.add(externalId);

    const title = requireNonEmptyString(row.title, "title", row.id);
    const providerUrl = requireNonEmptyString(
      row.providerUrl,
      "providerUrl",
      row.id,
    );
    const { abstract, abstractTruncated } = truncateAbstract(row.abstract);

    const stance =
      row.stance === "supports" ||
      row.stance === "opposes" ||
      row.stance === "uncertain"
        ? row.stance
        : null;
    if (stance === "supports") supports += 1;
    if (stance === "opposes") opposes += 1;

    packPapers.push({
      id: row.id,
      externalId,
      title,
      authors: parseAuthorsJson(row.authorsJson),
      year: row.year,
      doi: row.doi,
      url: row.url,
      providerUrl,
      abstract,
      abstractTruncated,
      stance,
    });
  }

  if (packPapers.length === 0) {
    throw new DebateEvidenceNoPapersError(
      "Debate has no usable attached papers after validation.",
    );
  }

  return {
    debateId: ownedDebate.id,
    claim: ownedDebate.claim,
    papers: packPapers,
  };
}

/**
 * Ensure every cited external id is in the EvidencePack whitelist.
 * Empty arrays are allowed (arguments that cite no papers).
 * Invalid or unknown ids throw — never silently dropped.
 */
export function validateCitedExternalIds(
  citedIds: unknown,
  evidencePack: EvidencePack,
): string[] {
  if (!Array.isArray(citedIds)) {
    throw new DebateEvidenceInvalidCitationError(
      "citedExternalIds must be an array of strings.",
    );
  }

  const allowed = new Set(
    evidencePack.papers.map((paper) => paper.externalId),
  );
  const normalized: string[] = [];

  for (let i = 0; i < citedIds.length; i++) {
    const value = citedIds[i];
    if (typeof value !== "string") {
      throw new DebateEvidenceInvalidCitationError(
        `citedExternalIds[${i}] must be a string.`,
      );
    }
    if (!allowed.has(value)) {
      throw new DebateEvidenceInvalidCitationError(
        `citedExternalIds[${i}] "${value}" is not in the EvidencePack.`,
      );
    }
    normalized.push(value);
  }

  return normalized;
}

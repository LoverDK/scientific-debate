import { z } from "zod";

/** Public snapshot whitelist; accepts historical snapshots without stance. */
export const debateSnapshotSchema = z.object({
  debateId: z.string().min(1),
  claim: z.string(),
  papers: z.array(z.object({
    id: z.string().min(1),
    externalId: z.string().regex(/^W\d+$/),
    title: z.string().min(1),
    authors: z.array(z.string()),
    year: z.number().int().nullable(),
    doi: z.string().nullable(),
    url: z.string().nullable(),
    providerUrl: z.string(),
    abstract: z.string().nullable(),
    abstractTruncated: z.boolean(),
    stance: z.enum(["supports", "opposes", "uncertain"]).nullable().default(null),
  })),
});

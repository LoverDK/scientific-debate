import { z } from "zod";

export const discussionAnswerSchema = z.strictObject({
  answer: z.string().trim().min(1).max(6000),
  citedExternalIds: z.array(z.string().regex(/^W\d+$/)).max(10),
});
export const savedDiscussionReplySchema = z.object({
  parentId: z.string().min(1),
  status: z.enum(["pending", "completed", "failed"]),
  modelId: z.string(),
  answer: z.string(),
  citedExternalIds: z.array(z.string()),
  error: z.string().nullable(),
});
export type SavedDiscussionReply = z.infer<typeof savedDiscussionReplySchema>;

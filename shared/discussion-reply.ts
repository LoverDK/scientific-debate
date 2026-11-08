import { z } from "zod";

// Shared fixed messages: never display an arbitrary database/provider exception.
export const discussionReplyErrors = {
  discussion_context_unavailable: "The saved debate could not be read. No AI call was made. Your contribution is saved.",
  discussion_read_failed: "The saved discussion could not be read. Refresh discussion before requesting a reply.",
  discussion_secret_unavailable: "OpenRouter credentials could not be read. No AI call was made. Your contribution is saved.",
  discussion_key_missing: "Connect OpenRouter in Settings. No AI call was made. Your contribution is saved.",
  discussion_claim_failed: "The server could not reserve this reply. No AI call was made. Refresh discussion before requesting a reply.",
  discussion_persistence_unconfirmed: "The AI request finished, but saving its result could not be confirmed. Refresh discussion; do not resubmit the question.",
} as const;

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

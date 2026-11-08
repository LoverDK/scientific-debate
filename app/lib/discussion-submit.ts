import { callAction } from "@agent-native/core/client/use-action";
import { discussionReplyErrors } from "../../shared/discussion-reply";

export type DiscussionInput = {
  runId: string;
  kind: "viewpoint" | "question" | "challenge" | "citation_explanation" | "follow_up";
  body: string;
  role?: "proponent" | "opponent" | "judge" | undefined;
  citedExternalId?: string | undefined;
};

/** Save once, then request one reply. A reply failure must never resubmit the note. */
export async function submitDiscussionWithReply(input: DiscussionInput, onSaved: () => void) {
  const saved = await callAction("add-run-discussion", input);
  onSaved();
  return requestSavedDiscussionReply(saved.runId, saved.id);
}

export async function requestSavedDiscussionReply(runId: string, contributionId: string) {
  let httpStatus: number | undefined;
  try {
    const reply = await callAction("reply-run-discussion", { runId, contributionId }, {
      timeoutMs: 90_000, onResponse: response => { httpStatus = response.status; },
    });
    return { savedId: contributionId, status: reply.status, error: reply.error };
  } catch (caught) {
    const code = caught && typeof caught === "object" && "errorCode" in caught ? caught.errorCode : undefined;
    const known = typeof code === "string" && Object.prototype.hasOwnProperty.call(discussionReplyErrors, code)
      ? discussionReplyErrors[code as keyof typeof discussionReplyErrors] : undefined;
    const error = known ?? (httpStatus === 400 ? "The reply request was rejected. Your contribution is saved. Refresh discussion to check its state."
      : httpStatus === 503 ? "The server is temporarily unavailable. Your contribution is saved."
      : httpStatus === 401 || httpStatus === 403 ? "Sign in again before checking the saved contribution."
      : httpStatus === 404 ? "The reply Action or saved contribution could not be found. Refresh this page."
      : httpStatus === 409 ? "This discussion is read-only or unavailable for a new reply."
      : httpStatus === 500 ? "The reply request failed on the server. Your contribution is saved, but the AI reply state is unknown. Refresh discussion; do not resubmit the question."
      : "The reply request timed out or could not be confirmed. Refresh discussion to check its saved state; do not resubmit the question.");
    return { savedId: contributionId, status: "unconfirmed" as const, error };
  }
}

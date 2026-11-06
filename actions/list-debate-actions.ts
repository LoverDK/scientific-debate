import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

/**
 * Discoverability catalog for Agents — which Scientific Debate Actions to call,
 * in which order, and which must not be auto-retried.
 */
export default defineAction({
  description:
    "List Scientific Debate Agent Actions with suggested workflow order. Prefer gather-debate-evidence after create-debate. Never auto-retry start-debate-run; inspect run status after timeouts and cancel only on an explicit owner request.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => ({
    workflow: [
      "create-debate",
      "gather-debate-evidence (preferred) or search-papers + attach-paper-to-debate",
      "list-debate-papers / get-debate-evidence",
      "list-debate-models",
      "start-debate-run (do not auto-retry)",
      "get-debate-run / get-debate-result / list-debate-runs",
      "export-debate-run",
    ],
    actions: [
      { name: "list-run-discussion", purpose: "Read human contributions on an owned run", write: false, retrySafe: true },
      { name: "add-run-discussion", purpose: "Save a human contribution alongside a run", write: true, retrySafe: false },
      { name: "list-research-projects", purpose: "List owned research projects", write: false, retrySafe: true },
      { name: "create-research-project", purpose: "Create a research project", write: true, retrySafe: false },
      { name: "list-project-debates", purpose: "Read claims in an owned project", write: false, retrySafe: true },
      { name: "add-debate-to-project", purpose: "Link an owned claim to an owned project", write: true, retrySafe: true },
      { name: "archive-research-project", purpose: "Archive an owned project", write: true, retrySafe: false },
      {
        name: "create-debate",
        purpose: "Create a claim",
        write: true,
        retrySafe: false,
      },
      {
        name: "get-debate",
        purpose: "Read one owned debate",
        write: false,
        retrySafe: true,
      },
      {
        name: "list-debates",
        purpose: "List owned debates",
        write: false,
        retrySafe: true,
      },
      {
        name: "edit-debate",
        purpose: "Update claim when no active run",
        write: true,
        retrySafe: false,
      },
      {
        name: "archive-debate",
        purpose: "Archive debate",
        write: true,
        retrySafe: false,
      },
      {
        name: "search-papers",
        purpose: "OpenAlex search (manual path)",
        write: false,
        retrySafe: true,
      },
      {
        name: "attach-paper-to-debate",
        purpose: "Attach one OpenAlex paper",
        write: true,
        retrySafe: true,
      },
      {
        name: "remove-paper-from-debate",
        purpose: "Detach one paper",
        write: true,
        retrySafe: false,
      },
      {
        name: "list-debate-papers",
        purpose: "List attachments with stance",
        write: false,
        retrySafe: true,
      },
      {
        name: "gather-debate-evidence",
        purpose: "Agent-first support+oppose gather + stance",
        write: true,
        retrySafe: false,
      },
      {
        name: "get-debate-evidence",
        purpose: "EvidencePack for start",
        write: false,
        retrySafe: true,
      },
      {
        name: "check-debate-model",
        purpose: "Check the fixed model's public listing and pricing",
        write: false,
        retrySafe: true,
      },
      {
        name: "list-debate-models",
        purpose: "Allowlisted models only",
        write: false,
        retrySafe: true,
      },
      {
        name: "start-debate-run",
        purpose: "Proponent→Opponent→Judge (long; not retrySafe)",
        write: true,
        retrySafe: false,
      },
      {
        name: "cancel-debate-run",
        purpose: "Record explicit owner cancellation; an in-flight call may still finish",
        write: true,
        retrySafe: false,
      },
      {
        name: "list-debate-runs",
        purpose: "Run history",
        write: false,
        retrySafe: true,
      },
      {
        name: "get-debate-run",
        purpose: "Full run + messages + EvidencePack",
        write: false,
        retrySafe: true,
      },
      {
        name: "get-debate-result",
        purpose: "Compact judge/result view",
        write: false,
        retrySafe: true,
      },
      {
        name: "export-debate-run",
        purpose: "Markdown / JSON / HTML private export",
        write: false,
        retrySafe: true,
      },
    ],
    notes: [
      "UI and Agent share these Actions.",
      "Exports stay private; public share links are out of scope.",
      "Only allowlisted free models may start runs unless product expands the allowlist.",
    ],
  }),
});

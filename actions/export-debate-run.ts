import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";
import getRun from "./get-debate-run.js";
import { debateSnapshotSchema as evidenceSchema } from "../server/lib/debate-snapshot.js";

function literal(text: string) {
  return text.split(/\r\n|[\r\n]/).map(line => "    " + line).join("\n");
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export default defineAction({
  description: "Export a private report from an owned run's saved evidence and role messages.",
  schema: z.object({
    runId: z.string().trim().min(1),
    format: z.enum(["markdown", "json", "html"]).default("markdown"),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async ({ runId, format }, ctx) => {
    const run = await getRun.run({ runId }, ctx);
    const snapshot = evidenceSchema.safeParse(run.evidencePack);
    if (!snapshot.success || snapshot.data.debateId !== run.debateId) {
      fail("Stored debate run data could not be read.", { statusCode: 500 });
    }
    const evidencePack = snapshot.data;
    const { claim } = evidencePack;
    const roles = run.messages.map(message => message.output);
    const judge = roles.find(output => output.role === "judge");
    const summaryText = [
      "Claim: " + claim, "Status: " + run.status,
      judge ? "Verdict: " + judge.verdict + " (" + Math.round(judge.confidence * 100) + "%)" : "Verdict: (not available)",
      judge?.summary, run.errorSummary,
    ].filter(Boolean).join("\n");
    const sections = [
      "# Scientific Debate report", "## Claim", literal(claim),
      literal(["Run: " + run.id, "Status: " + run.status, "Model: " + run.modelId,
        "Created: " + run.createdAt, run.finishedAt && "Finished: " + run.finishedAt,
        run.errorSummary].filter(Boolean).join("\n")),
    ];
    for (const role of roles) {
      sections.push("## " + role.role, literal(role.summary));
      for (const arg of role.arguments) {
        sections.push(literal([arg.claim, arg.support, "Citations: " + (arg.citedExternalIds.join(", ") || "none")].join("\n")));
      }
      if (role.role === "judge") {
        sections.push("### Verdict", literal([role.verdict, "Confidence: " + role.confidence,
          ...role.limitations.map(item => "Limitation: " + item)].join("\n")));
        if (role.researchNotes) {
          sections.push("### Research notes", literal([
            "Evidence conflicts: " + role.researchNotes.evidenceConflict,
            "Reasoning gap: " + role.researchNotes.reasoningGap,
            ...role.researchNotes.nextQuestions.map(q => "Research question: " + q),
          ].join("\n")));
        }
      }
    }
    sections.push("## EvidencePack");
    for (const paper of evidencePack.papers) {
      sections.push(literal([paper.title, paper.authors.join(", "), paper.year,
        paper.externalId, paper.providerUrl, paper.doi, paper.url,
        paper.stance && "Stance: " + paper.stance, paper.abstract || "No abstract available",
        paper.abstractTruncated && "Abstract truncated in the saved snapshot."].filter(Boolean).join("\n")));
    }
    const disclaimer = "Model-assisted evaluation based on the saved paper metadata and abstracts.";
    sections.push(disclaimer);
    const markdown = sections.join("\n\n");
    const json = format === "json" ? {
      debateId: run.debateId, runId, claim, status: run.status, modelId: run.modelId,
      createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt,
      errorSummary: run.errorSummary, roles, evidencePack, disclaimer,
    } : null;
    const html = format === "html" ? `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Scientific Debate report</title><style>body{max-width:48rem;margin:2rem auto;font:16px Georgia,serif}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}@media print{body{margin:0}}</style>
</head><body><pre>${escapeHtml(markdown)}</pre></body></html>` : null;
    return { format, debateId: run.debateId, runId, summaryText, markdown, json, html };
  },
});

import type getDebateRun from "../../actions/get-debate-run";

export type RunReport = Awaited<ReturnType<typeof getDebateRun.run>>;
export const roleNames = { proponent: "正方", opponent: "反方", judge: "裁判" };
export const verdicts = { supports: "支持命题", opposes: "反对命题", insufficient_evidence: "证据不足" };

export function reportMarkdown(run: RunReport) {
  // Indent all external text as literal Markdown, including embedded newlines.
  const literal = (s: string) => s.split(/\r\n|[\r\n]/).map(line => "    " + line).join("\n");
  const sections = ["# 科学辩论报告", literal(run.evidencePack.claim),
    literal([run.id, run.modelId, run.status, run.createdAt].join(" · ")),
    "论证基于运行时保存的论文元数据和可用摘要。裁判判断为模型评估。"];
  for (const { output } of run.messages) {
    sections.push("## " + roleNames[output.role], literal(output.summary));
    for (const arg of output.arguments) sections.push(literal([arg.claim, arg.support,
      "引用：" + (arg.citedExternalIds.join("、") || "无")].join("\n")));
    if (output.role === "judge") sections.push(literal([
      verdicts[output.verdict], "模型置信度：" + output.confidence,
      ...output.limitations.map(item => "局限：" + item),
    ].join("\n")));
  }
  sections.push("## 论文快照");
  for (const p of run.evidencePack.papers) sections.push(literal([
    p.title, p.externalId, p.providerUrl, p.abstract || "无摘要",
  ].join("\n")));
  return sections.join("\n\n");
}

export function downloadReport(run: RunReport, format: "md" | "json") {
  const json = format === "json";
  const url = URL.createObjectURL(new Blob([json ? JSON.stringify(run, null, 2) : reportMarkdown(run)],
    { type: json ? "application/json" : "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "scientific-debate-" + run.id + "." + format;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

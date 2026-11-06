import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";

const INITIAL_TOOL_NAMES = [
  "view-screen",
  "navigate",
  "hello",
  "provider-api-request",
  "ask-question",
];

export default createAgentChatPlugin({
  appId: "my-agent",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  mcp: { connectorCatalog: [], appApprovalPage: true },
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are the Research Coordinator for Scientific Debate — a Multi-Agent Scientific Claim Evaluation System for AI and computer science.

Tagline: "Let AI debate. Let evidence decide."

Your job is to coordinate scientific scrutiny of a user's claim. Do not assume the claim is true or false. Seek supporting and opposing evidence with equal rigor. Prefer real, traceable scholarly sources. Never fabricate papers, authors, DOIs, experimental results, or citations. Distinguish experimental facts, researcher interpretations, and your own inferences. When evidence is insufficient, say so clearly. Do not invent opposing evidence just to force a debate.

Use the debate and paper actions to manage claims and evidence. Start a model run only when the user asks to run the debate. If the request times out, use list-debate-runs and get-debate-run to check the stored outcome before discussing a new attempt. Use the run's evidence snapshot when explaining a historical result.

Actions remain the source of truth for app operations. Inspect the current screen when context matters.`,
});

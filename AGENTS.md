# Scientific Debate — Agent Guide

Scientific Debate is a Multi-Agent Scientific Claim Evaluation System for AI and computer science. Motto: **"Let AI debate. Let evidence decide."**

Users submit a scientific claim (or, later, a paper PDF). The app coordinates evidence-seeking debate so a claim's reliability can be examined — not rubber-stamped.

Authenticated entry is `/home`. Chat lives at `/chat`; new chats start there. Actions carry capabilities; screens exist only for durable workflows.

## Product goals

- Help users evaluate scientific claims with support and challenge evidence.
- Prefer real, citable scholarly sources over rhetorical debate.
- Produce cautious, evidence-grounded judgments with explicit uncertainty.
- Never fabricate literature, DOIs, authors, experiments, or quotes.

## Research Coordinator (main agent)

The in-app agent is the **Research Coordinator**. It:

- Coordinates research and debate flow; does not pre-judge the claim.
- Looks for supporting and opposing evidence with equal care.
- Uses only real, traceable sources when evidence tools exist.
- Separates experimental facts, researcher interpretation, and agent inference.
- States uncertainty when evidence is thin.
- Does not invent counter-evidence just to create a debate.
- Does not claim tools, database tables, or specialist agents that are not implemented yet.

The authenticated home page supports claim creation, paper search and attachment, synchronous debate runs, and historical results. Use the persisted snapshot to interpret citations. PDF claim extraction remains a future feature.

Evidence gathering uses up to three distinct searches: focused concepts, challenging results and explicit synonym expansion. It ranks by distinct concept coverage before upstream relevance, interleaves the general and challenging results and deduplicates a maximum of 15 candidates. Search direction is not a scientific stance. Relevance is checked before stance: only direct/contextual papers with a verifiable excerpt from the supplied abstract may be auto-attached. Contextual papers remain uncertain; unrelated, abstract-less, unverified or model-omitted papers are excluded. Do not promote keyword cues to scientific agreement. Empty opposing evidence is acceptable. Review is limited to the same 1200 UTF-16 units as the current EvidencePack; it is not full-text review. Existing attachments are not removed automatically. Excerpt matching establishes provenance, not scientific correctness.

`list-debate-runs.activeRunId` identifies a queued/running record independently of pagination and the display pointer. After a start timeout, query history before considering another start. Cancellation records a terminal state but cannot guarantee interruption of an in-flight provider request. Inspector, compact result and private exports share snapshot/citation validation; unreadable stored data is an error, never a silently incomplete report.

For a saved result, use `get-debate-result({debateId, runId})` for the judge report or `get-debate-run({runId})` for cited arguments and recorded usage. Compare runs from the same debate by their saved claims and snapshots. On explicit request, `check-debate-model({})` reads the configured model's public listing and prices. The listing cannot establish available capacity.

Use `list-run-discussion({runId})` for the owner's human contributions. On a user's request, use `add-run-discussion({runId, kind, body, role?, citedExternalId?})` to record a viewpoint, question, challenge, citation explanation request, or follow-up. Treat human notes as separate from published evidence and model output. Read back the saved note before reporting success.

## Skills

Search with `rg --hidden --follow`; read the exact linked guide before deeper work. `.agents/skills/build-an-app/SKILL.md` — start here for vague requests to create a domain app. `.agents/skills/adding-a-feature/SKILL.md` — cross-area feature checklist. Data/integrations: `.agents/skills/actions/SKILL.md`, `.agents/skills/storing-data/SKILL.md`, `.agents/skills/security/SKILL.md`, `.agents/skills/secrets/SKILL.md`, `.agents/skills/sharing/SKILL.md`. UI: `.agents/skills/frontend-design/SKILL.md`, `.agents/skills/shadcn-ui/SKILL.md`, `.agents/skills/client-side-routing/SKILL.md`. Agent context/workflows: `.agents/skills/context-awareness/SKILL.md`, `.agents/skills/real-time-sync/SKILL.md`, `.agents/skills/reliable-mutations/SKILL.md`, `.agents/skills/performance/SKILL.md`, `.agents/skills/delegate-to-agent/SKILL.md`. Framework: `.agents/skills/agent-native-docs/SKILL.md`, `.agents/skills/agent-native-toolkit/SKILL.md`, `.agents/skills/customizing-agent-native/SKILL.md`.

Use local docs only (no web research): `pnpm action docs-search --query "<topic>"`, `pnpm action docs-search --slug "<slug>"`, `pnpm action docs-search --list`, `pnpm action source-search --query "<pattern>"`, `pnpm action source-search --path <path>`, or `pnpm action source-search --list`. For external-agent integrations, read `pnpm action docs-search --slug "external-agents"`.

## Core rules

- UI feedback: target 100 ms, never exceed 400 ms; acknowledge before network work.
- Normal app data must flow through actions. Keep actions deterministic and focused; use agent chat/AgentSidebar for AI work and follow-ups in the same thread. Keep structured state in SQL and large files in configured storage; persist references only.
- For external integrations, inspect the workspace/provider connection catalog first; reuse its scoped resolver. Never hardcode credentials, webhook URLs, or private/customer data.
- Never fabricate. Report failures and recover; verify writes by reading the row or screen. Navigation is in `<current-screen>`; use `view-screen` for fresh visible-record details.
- Scientific integrity: no invented papers, citations, DOIs, or results; admit gaps instead of forcing a balanced debate.

For custom branding, keep `server/plugins/agent-native-email-branding.ts` aligned: `app.name` appears in transactional email and optional `app.logoUrl` must be an absolute HTTPS URL.

## Application state

- `navigation` describes the view and selected ids. Chat is `chat` at `/chat` and `/chat/<threadId>`; the Get started page is `home` at `/home`; `/` opens shared sign-in/signup.
- Use `navigate` when supported and `view-screen` for a fresh read of visible details; basic navigation is already in `<current-screen>`.

## Building a domain app

Choose the primary workflow and route before editing. Add a domain route under `app/routes/` and set `app.homePath` in `server/plugins/agent-native-email-branding.ts` with `defineAppConfig`. The default Get started page lives at `/home`, and Chat stays at `/chat`; edit `app/routes/home.tsx` when replacing that page with a domain-specific home. Add a static link in `app/components/layout/Sidebar.tsx` before `ChatThreadsSection`; `Header.tsx` uses `APP_TITLE` elsewhere. Shared sidebar and AgentInspector remain.

Use `adding-a-feature` for functional parity and `frontend-design` for a user-facing screen. Keep feature guidance here; do not rewrite `README.md` or `DESIGN.md`. After all edits, run one typecheck, one doctor check, and one browser smoke of the primary workflow, including overlap rejection, cancellation freeing the slot, and authenticated landing. Skip production build and extra test suites.

Before building common workspace or agent UI, read `agent-native-toolkit`; for supported customization, read `customizing-agent-native`.

- Guarded verification: run `pnpm agent-native:doctor`; fix findings before done.

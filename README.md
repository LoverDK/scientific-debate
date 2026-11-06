# Scientific Debate

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/LoverDK/scientific-debate?quickstart=1)

Scientific Debate helps you check a scientific claim against published papers. A proponent makes the case, an opponent challenges it, and a judge explains which arguments the evidence supports. Open a citation to see which paper the model used.

For example, a debate about Turing's imitation game reached *insufficient evidence*. The saved record contained the title and publication details of Turing's paper, but no abstract. You can inspect that distinction in a report: each argument lists its sources, and the judge records the limits of the evidence.

## Try it

Click **Open in GitHub Codespaces** above, sign in to GitHub, and create a codespace. Once setup finishes, open **Ports → 8080 → Open in Browser**. Each codespace starts with its own database. GitHub applies your account's Codespaces quota.

1. Sign in to the app and create a claim. On **Evidence**, review the papers the search finds. If the search comes back empty, try a paper title or shorter keywords.
2. Connect your OpenRouter key in **Settings** for stance classification and debate runs. For authenticated paper search, configure `OPENALEX_API_KEY` as a secret. Keep keys out of source files.
3. Select **Continue to Debate**, then start a run. If the browser times out, refresh the run history before starting another.
4. Open **Conclusion** to read the verdict and follow its citations. You can challenge an argument in **Human discussion**, compare two runs of the same claim, or export a private report as Markdown, JSON, or printable HTML.

## What a run records

The app freezes the claim and its evidence when a run starts. All three roles read that snapshot. Their citations must refer to papers in it. A later edit to the claim or its paper list leaves the earlier report intact.

Evidence comes from paper metadata and available abstracts. A debate can end with missing evidence or an inconclusive verdict. The confidence shown in a report is the judge model's own assessment.

The evidence classifier and debate runner request `nvidia/nemotron-3.5-super-vl:free` through OpenRouter. Both set a zero-price routing ceiling and disable provider fallback and automatic model retries. A rate limit stops the operation. The separate Agent-Native chat uses its own engine settings. Check its model before using chat on a zero budget.

## Run locally

Use Node.js 24 and pnpm 10.29.1 in a fresh checkout.

```sh
git clone https://github.com/LoverDK/scientific-debate.git
cd scientific-debate
pnpm install --frozen-lockfile
pnpm dev
```

Open the address printed in the terminal. Local development uses PGlite. Check your database settings before starting an existing checkout. For a hosted instance, follow the [deployment guide](docs/deployment.md).

## Inside the project

The React interface and the research agent call the same [Actions](actions/). For example, a paper attached through an Action appears on the evidence page. [Server code](server/lib/) builds the snapshot, validates citations, and saves each role's message. [Database migrations](server/db/migrations.ts) describe the stored data.

Run `pnpm typecheck` for TypeScript and `pnpm test` for the test suite. Tests use in-memory PGlite and simulated model responses.

Built with [Agent-Native](https://www.agent-native.com), React Router, Drizzle, OpenAlex and OpenRouter. Project code belongs to its authors, subject to the licenses of the framework and other dependencies.

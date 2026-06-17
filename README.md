# gpt-subagents-api

An [MCP](https://modelcontextprotocol.io) server that lets **Claude Code delegate to OpenAI
"expert" models as subagents** — and ships a small, extensible library of **orchestration
patterns** that teach the calling agent *how* to use those experts well.

Claude orchestrates; GPT gives a second opinion from a **different model family** (different blind
spots). The patterns make that second opinion **parallel, context-cheap, and ground-truth-checked**.

---

## The subagent tool

There's **one** tool — `ask_gpt`. You choose the `model`, write the `instructions` (its system
prompt), supply a `prompt`, and optionally set `reasoning_effort` and `context`.

There's no separate "worker" and "architect" tool: that distinction is just **which orchestration
pattern you apply, plus the model and effort you pick** —

| Role | How | Pattern |
|------|-----|---------|
| **Worker** — routine coding, patches, debugging, tests, repo inspection | `ask_gpt` with a fast model (e.g. `gpt-5.3-codex`) | [`worker-orchestrator`](./patterns/worker-orchestrator.md) |
| **Architect** — hard reasoning, architecture, security / threat modeling, review of large/high-risk changes | `ask_gpt` with a strong model (e.g. `gpt-5.5`) + `reasoning_effort: "high"` | [`two-layer-cross-model-expert`](./patterns/two-layer-cross-model-expert.md) |

`model`, `instructions`, and `prompt` are required (any valid OpenAI model id is accepted — the server
hardcodes none). Inbound `instructions`, `prompt`, and `context` are run through a `sanitizeContext`
pass that redacts obvious secrets before they leave your machine — a backstop, not a guarantee; avoid
pasting secrets.

---

## Orchestration patterns

Patterns are reusable playbooks (Markdown files in [`patterns/`](./patterns)) that describe *how* to
drive the expert tools — splitting work, bundling context, calling the expert, **verifying its
output against ground truth**, and aggregating results.

Two tools expose them to the agent:

- **`list_patterns`** — catalog of every pattern (name, title, summary, when to use).
- **`get_pattern("<name>")`** — the full text of one pattern.

Patterns are read from disk **at call time**, so adding or editing one needs no rebuild. The
server's startup `instructions` nudge the agent to consult patterns before any non-trivial
`ask_gpt` work — or any review, audit, or large-document analysis.

**Shipped patterns**

| name | what it does |
|------|--------------|
| [`two-layer-cross-model-expert`](./patterns/two-layer-cross-model-expert.md) | Wrap the GPT expert in verifying Claude subagents so the orchestrator only ever sees parallel, context-cheap, ground-truth-checked conclusions. |
| [`worker-orchestrator`](./patterns/worker-orchestrator.md) | Fan concrete work out to the GPT worker through cheap Sonnet wrapper subagents — validated by execution, not a verification gate. |

Both patterns ship a rendered, styled diagram under
[`patterns/html/`](./patterns/html) — open one in a browser for the visual walkthrough.

See [`patterns/README.md`](./patterns/README.md) to add your own.

---

## Setup

**Requirements:** Node 18+ and an OpenAI API key.

```bash
# 1. Install dependencies
npm install

# 2. Add your key (this file is gitignored and must never be committed)
cp .env.example .env
#   then edit .env and set OPENAI_API_KEY=sk-...

# 3. Build
npm run build
```

This compiles to `dist/`. The server loads `.env` from the project root (one level up from
`dist/server.js`), or falls back to an inherited `OPENAI_API_KEY` in the environment.

### Register with Claude Code

```bash
claude mcp add gpt-subagents-api -- node /absolute/path/to/gpt-subagents-api/dist/server.js
```

Or add it to your MCP client config manually:

```jsonc
{
  "mcpServers": {
    "gpt-subagents-api": {
      "command": "node",
      "args": ["/absolute/path/to/gpt-subagents-api/dist/server.js"]
    }
  }
}
```

Once connected, the server advertises three tools: `ask_gpt`, `list_patterns`, and `get_pattern`.

---

## Project layout

```
gpt-subagents-api/
├── server.ts        # MCP server: the ask_gpt tool + server instructions
├── gptAgents.ts     # The OpenAI call (ask_gpt) and secret sanitization
├── patterns.ts      # Loads/parses pattern Markdown from patterns/
├── patterns/        # Orchestration patterns (one Markdown file each)
│   ├── README.md
│   ├── two-layer-cross-model-expert.md
│   └── worker-orchestrator.md
├── .env.example     # Placeholder; copy to .env (gitignored)
└── dist/            # Build output (gitignored)
```

---

## Security notes

- **`.env` is gitignored** and never tracked — only the `.env.example` placeholder is committed.
  Local agent/editor state (`.mempalace/`, `.claude/`, `CLAUDE.local.md`, IDE folders) is gitignored
  too, so dev-environment data doesn't leak into the repo.
- **`sanitizeContext`** redacts `sk-…` keys and `OPENAI_API_KEY=` / `ANTHROPIC_API_KEY=` assignments
  from outbound context. It's a backstop, not a guarantee — keep secrets out of prompts.
- **Verify expert output against ground truth.** The `two-layer-cross-model-expert` pattern is the
  recommended way to drive `ask_gpt` (architect-style) so its output is checked before you act on it.

---

## License

MIT

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { askGpt } from "./gptAgents.js";
import { listPatterns, getPattern, patternNames } from "./patterns.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Global install: compiled to <pkg>/dist/server.js, so the colocated .env is one
// level up. Falls back silently to any inherited process.env.OPENAI_API_KEY.
config({ path: resolve(__dirname, "..", ".env") });

const server = new McpServer(
  {
    name: "gpt-subagents-api",
    version: "1.0.0",
  },
  {
    instructions: `
This server lets you delegate to an OpenAI "expert" model from inside your agent loop, via a SINGLE tool:

- ask_gpt: ask any OpenAI model. You choose the model, write the instructions (its system prompt), and
  optionally set reasoning_effort. There is NO separate "worker" vs "architect" tool — that distinction
  is just the orchestration PATTERN you apply plus your model/effort choice:
  - Concrete code work (patches, debugging, tests, repo inspection): a fast model (e.g. gpt-5.3-codex)
    + the worker-orchestrator pattern.
  - Hard reasoning, architecture, security/threat modeling, review of large/high-risk changes: a strong
    model (e.g. gpt-5.5) + reasoning_effort "high" + the two-layer-cross-model-expert pattern.

ORCHESTRATION PATTERNS: Before any non-trivial use of ask_gpt — reviews, audits, threat modeling,
large-document analysis, anything whose output you would act on — call list_patterns and apply the most
relevant pattern, then read it in full with get_pattern. Patterns are reusable playbooks that keep
expert output parallel, context-cheap, and verified against ground truth.

DATA BOUNDARY: instructions, prompt, and context are sent to an external OpenAI API. Secrets are
stripped on a best-effort basis (common API keys, tokens, and private keys are redacted), but this is
not guaranteed — do NOT paste highly sensitive data and rely on redaction to protect it.
    `.trim(),
  }
);

// Input size caps. These bound what we forward to the API so an oversized
// argument can't be used to burn API credit, overflow context, or buffer huge
// strings. Matches the sibling subscription server's limits.
const MAX_INSTRUCTIONS_CHARS = 32_000;
const MAX_PROMPT_CHARS = 100_000;
const MAX_CONTEXT_CHARS = 200_000;
const MAX_PATTERN_NAME_CHARS = 100;

// Convert any thrown error into a generic, caller-safe message. Details
// (including the original error) are logged to stderr by gptAgents/here, never
// returned to the MCP client where they could disclose local paths/metadata.
function errorText(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

server.tool(
  "ask_gpt",
  "Ask an OpenAI model as an expert subagent. ONE tool for everything: you choose the `model`, write the `instructions` (its system prompt), and optionally set `reasoning_effort`. There is no separate 'worker' vs 'architect' tool — the difference is the orchestration PATTERN you apply plus your model/effort choice: a fast model (e.g. gpt-5.3-codex) with the worker-orchestrator pattern for concrete code work (patches, debugging, tests, repo inspection); a strong model (e.g. gpt-5.5) + reasoning_effort 'high' with the two-layer-cross-model-expert pattern for hard reasoning, architecture, security/threat modeling, and review. Call list_patterns / get_pattern first for non-trivial work.",
  {
    model: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe(
        "The OpenAI model id (required): e.g. 'gpt-5.3-codex' for fast/coding work, 'gpt-5.5' for deep reasoning. Any valid OpenAI model id is accepted."
      ),
    instructions: z
      .string()
      .trim()
      .min(1)
      .max(MAX_INSTRUCTIONS_CHARS)
      .describe(
        "System instructions for the model (required): its role and how to respond. Write these for the task at hand — e.g. a coding-subagent prompt for worker-style work, or a reviewer/architect prompt for analysis."
      ),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(MAX_PROMPT_CHARS)
      .describe("The task or question for the model."),
    reasoning_effort: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe(
        "Reasoning effort (higher = deeper but slower). Use 'high' for deep audits / architecture review."
      ),
    context: z
      .string()
      .max(MAX_CONTEXT_CHARS)
      .optional()
      .describe(
        "Code snippets, error messages, stack traces, constraints, or other relevant context."
      ),
  },
  async ({ model, instructions, prompt, reasoning_effort, context }) => {
    try {
      const result = await askGpt({
        model,
        instructions,
        prompt,
        reasoningEffort: reasoning_effort,
        context,
      });
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err) {
      console.error("[gpt-subagents] ask_gpt handler error:", err);
      return {
        isError: true,
        content: [{ type: "text" as const, text: errorText(err) }],
      };
    }
  }
);

server.tool(
  "list_patterns",
  "List available orchestration patterns for driving ask_gpt. Call this before non-trivial expert work — reviews, audits, threat modeling, large-document analysis — then read the chosen one with get_pattern. Returns each pattern's name, title, summary, and when to use it.",
  {},
  async () => {
    const patterns = listPatterns();
    if (patterns.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No patterns found." }],
      };
    }
    const text = patterns
      .map(
        (p) =>
          `- ${p.name} — ${p.title}\n  Summary: ${p.summary}\n  Use when: ${p.use_when}`
      )
      .join("\n\n");
    return {
      content: [
        {
          type: "text" as const,
          text: `Available orchestration patterns (read one in full with get_pattern):\n\n${text}`,
        },
      ],
    };
  }
);

server.tool(
  "get_pattern",
  "Return the full text of an orchestration pattern by name (see list_patterns). Use it to apply the pattern when orchestrating ask_gpt calls.",
  {
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_PATTERN_NAME_CHARS)
      .describe(
        "The pattern name from list_patterns, e.g. 'two-layer-cross-model-expert'"
      ),
  },
  async ({ name }) => {
    const pattern = getPattern(name);
    if (!pattern) {
      const available = patternNames();
      const list = available.length ? available.join(", ") : "(none found)";
      // JSON.stringify + truncate the echoed name so control chars / a huge
      // value can't inject newlines or formatting into the reflected message.
      const echoed = JSON.stringify(name.slice(0, MAX_PATTERN_NAME_CHARS));
      return {
        content: [
          {
            type: "text" as const,
            text: `No pattern named ${echoed}. Available patterns: ${list}`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `# ${pattern.title}\n\n${pattern.body}`,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GPT subagent MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

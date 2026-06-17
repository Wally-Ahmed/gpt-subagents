import OpenAI from "openai";

let openai: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openai) {
    const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
    if (!apiKey) {
      throw new Error("Missing OPENAI_API_KEY in environment variables.");
    }
    openai = new OpenAI({ apiKey });
  }
  return openai;
}

type AskGptInput = {
  model: string;
  instructions: string;
  prompt: string;
  context?: string;
  reasoningEffort?: "low" | "medium" | "high";
};

// Best-effort secret redaction for anything we send to the external API. Every
// pattern is linear (a single repetition over a simple character class, no
// nested quantifiers) so this is ReDoS-safe even on hostile input.
export function sanitizeContext(context = ""): string {
  return (
    context
      // PEM private-key blocks (any "... PRIVATE KEY" label). [\s\S] is the
      // body; the lazy *? plus distinct delimiters keep this linear.
      .replace(
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
        "[REDACTED_PRIVATE_KEY]"
      )
      // Provider API tokens (prefix-identified, high-signal).
      .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_OPENAI_KEY]")
      .replace(/github_pat_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
      .replace(/gh[pousr]_[A-Za-z0-9]+/g, "[REDACTED_GITHUB_TOKEN]")
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]")
      .replace(/\bAIza[A-Za-z0-9_-]{35}\b/g, "[REDACTED_GOOGLE_KEY]")
      .replace(/\bxox[baprs]-[A-Za-z0-9-]+/g, "[REDACTED_SLACK_TOKEN]")
      // Generic `Bearer <token>` auth headers.
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]")
      // Sensitive assignments in either `KEY=value` or `KEY: value` form,
      // including quoted values, covering common YAML/JSON/.env shapes. Kept
      // conservative: only key names ending in API_KEY / SECRET / TOKEN /
      // PASSWORD, plus the legacy OPENAI/ANTHROPIC names.
      .replace(
        /\b([A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g,
        "$1=[REDACTED]"
      )
      // Generic high-entropy token catch-all (runs last). Require the 40+ char
      // run to MIX lower + UPPER + digit — the signature of a random secret — so
      // ordinary long strings pass through untouched: git SHAs and other hex
      // digests (no uppercase), SCREAMING_CONSTANTS / snake_case identifiers (no
      // digit), and plain prose. The three lookaheads each scan a fixed class
      // with no nested quantifiers, so this stays linear (ReDoS-safe).
      .replace(
        /\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g,
        "[REDACTED_TOKEN]"
      )
  );
}

// Run an outbound API call, converting any SDK error into a generic, redacted
// Error so request metadata / local paths (the .env lives in this dir) never
// reach the MCP client. Full detail goes to stderr only.
async function callOpenAI(
  label: string,
  fn: () => Promise<{ output_text?: string }>
): Promise<string> {
  try {
    const response = await fn();
    return response.output_text ?? "";
  } catch (err) {
    console.error(`[gpt-subagents] ${label} failed:`, err);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} failed: ${sanitizeContext(detail)}`);
  }
}

// A single entry point. There is no separate "worker" vs "architect" function:
// the caller picks the model, writes the instructions (system prompt), and
// optionally sets the reasoning effort. Which role it plays — fast concrete
// worker vs deep reasoning expert — is a matter of those choices plus the
// orchestration pattern applied around it, not a different code path.
export async function askGpt({
  model,
  instructions,
  prompt,
  context = "",
  reasoningEffort,
}: AskGptInput): Promise<string> {
  const client = getClient();
  // Everything outbound is run through the secret redactor.
  const safeInstructions = sanitizeContext(instructions);
  const safePrompt = sanitizeContext(prompt);
  const safeContext = sanitizeContext(context);
  const input = safeContext
    ? `${safePrompt}\n\nContext:\n${safeContext}`
    : safePrompt;

  return callOpenAI("ask_gpt", () =>
    client.responses.create({
      model,
      instructions: safeInstructions,
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      input,
    })
  );
}

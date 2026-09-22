import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import { config } from "../config.js";
import { TOOLS, runTool, type ToolContext } from "../tools/index.js";
import { STABLE_SYSTEM_PROMPT, callerContext } from "./prompt.js";
import type { Caller } from "../policy/rbac.js";

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * Tool definitions are built once and never reordered — the tool block is the
 * first thing in the cached prefix, so any churn here costs every cache hit.
 */
const TOOL_DEFS: Anthropic.Tool[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: zodToJsonSchema(t.schema, { $refStrategy: "none" }) as Anthropic.Tool.InputSchema,
}));

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; input: unknown }
  | { type: "tool_end"; name: string; ok: boolean }
  | { type: "done"; stopReason: string | null }
  | { type: "error"; message: string };

export interface ChatTurnArgs {
  caller: Caller;
  history: Anthropic.MessageParam[];
  userMessage: string;
  onEvent: (e: AgentEvent) => void;
}

/**
 * Every loop iteration is a billed API call, so the loop is bounded twice:
 * per turn, and per session. Both fail closed — an unbounded agent loop is a
 * runaway bill, not just a bug.
 */
const sessionCalls = new Map<string, number>();

function budgetCheck(sessionId: string): string | null {
  const used = sessionCalls.get(sessionId) ?? 0;
  if (used >= config.anthropic.maxCallsPerSession) {
    return `This session has used ${used} API calls, its configured limit. ` +
           `Start a new conversation, or raise MAX_CALLS_PER_SESSION.`;
  }
  return null;
}

/** Cumulative token usage per session, so spend is reportable rather than opaque. */
const sessionUsage = new Map<string, { input: number; output: number }>();

export function usageFor(sessionId: string) {
  return sessionUsage.get(sessionId) ?? { input: 0, output: 0 };
}

/**
 * A manual tool loop rather than the SDK tool runner: every tool call has to
 * pass through runTool() for RBAC and audit, and we stream per-tool progress
 * to the UI as it happens.
 */
export async function runChatTurn({
  caller, history, userMessage, onEvent,
}: ChatTurnArgs): Promise<Anthropic.MessageParam[]> {
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userMessage },
  ];
  const ctx: ToolContext = { caller };

  const overBudget = budgetCheck(caller.sessionId);
  if (overBudget) {
    onEvent({ type: "error", message: overBudget });
    return messages;
  }

  for (let i = 0; i < config.anthropic.maxIterations; i++) {
    sessionCalls.set(caller.sessionId, (sessionCalls.get(caller.sessionId) ?? 0) + 1);
    const stream = client.messages.stream({
      model: config.anthropic.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: [
        { type: "text", text: STABLE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        { type: "text", text: callerContext(caller) },
      ],
      tools: TOOL_DEFS,
      messages,
    });

    stream.on("text", (delta) => onEvent({ type: "text", text: delta }));

    let response: Anthropic.Message;
    try {
      response = await stream.finalMessage();
    } catch (e) {
      const message = e instanceof Anthropic.APIError
        ? `Claude API error ${e.status}: ${e.message}`
        : e instanceof Error ? e.message : String(e);
      onEvent({ type: "error", message });
      return messages;
    }

    const u = sessionUsage.get(caller.sessionId) ?? { input: 0, output: 0 };
    u.input += response.usage.input_tokens;
    u.output += response.usage.output_tokens;
    sessionUsage.set(caller.sessionId, u);

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") {
      onEvent({ type: "error", message: "The request was declined." });
      return messages;
    }
    if (response.stop_reason !== "tool_use") {
      onEvent({ type: "done", stopReason: response.stop_reason });
      return messages;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // Parallel tool calls must all come back in a SINGLE user message.
    const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (block) => {
        onEvent({ type: "tool_start", name: block.name, input: block.input });
        try {
          const out = await runTool(block.name, block.input, ctx);
          const isError = typeof out === "object" && out !== null && "error" in out;
          onEvent({ type: "tool_end", name: block.name, ok: !isError });
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: JSON.stringify(out),
            ...(isError ? { is_error: true } : {}),
          };
        } catch (e) {
          onEvent({ type: "tool_end", name: block.name, ok: false });
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
            is_error: true,
          };
        }
      }),
    );

    messages.push({ role: "user", content: results });
  }

  onEvent({ type: "error", message: `Stopped after ${config.anthropic.maxIterations} tool iterations (spend guard).` });
  return messages;
}

import { Router } from "express";
import type Anthropic from "@anthropic-ai/sdk";
import { runChatTurn } from "../orchestrator/agent.js";
import type { Caller } from "../policy/rbac.js";

export const chatRouter = Router();

/**
 * In-memory conversation store. Replace with Redis or Postgres before running
 * more than one server instance — sessions are sticky to a process today.
 */
const conversations = new Map<string, Anthropic.MessageParam[]>();

chatRouter.post("/chat", async (req, res) => {
  const caller = req.caller as Caller | undefined;
  if (!caller) return res.status(401).json({ error: "Not authenticated" });

  const { message, conversation_id } = req.body as {
    message?: string; conversation_id?: string;
  };
  if (!message?.trim()) return res.status(400).json({ error: "message is required" });

  const convoId = conversation_id ?? caller.sessionId;
  const history = conversations.get(convoId) ?? [];

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  try {
    const updated = await runChatTurn({
      caller,
      history,
      userMessage: message,
      onEvent: send,
    });
    conversations.set(convoId, trimHistory(updated));
  } catch (e) {
    send({ type: "error", message: e instanceof Error ? e.message : String(e) });
  } finally {
    res.write("data: [DONE]\n\n");
    res.end();
  }
});

/** Keep the last N turns so long sessions don't grow without bound. */
function trimHistory(messages: Anthropic.MessageParam[], keep = 40): Anthropic.MessageParam[] {
  if (messages.length <= keep) return messages;
  const trimmed = messages.slice(-keep);
  // Never start history on a tool_result — it would orphan its tool_use block.
  while (trimmed.length > 0 && isToolResult(trimmed[0])) trimmed.shift();
  return trimmed;
}

function isToolResult(m: Anthropic.MessageParam | undefined): boolean {
  return Boolean(
    m && Array.isArray(m.content) &&
    m.content.some((b) => typeof b === "object" && b.type === "tool_result"),
  );
}

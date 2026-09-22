import { Router } from "express";
import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { runChatTurn } from "../orchestrator/agent.js";
import type { Caller } from "../policy/rbac.js";

export const pollingRouter = Router();

/**
 * Polling transport for Lightning Web Components, which cannot consume SSE.
 * A turn runs asynchronously here and the client polls for progress; the same
 * orchestrator and the same tool layer serve both transports.
 */
interface Turn {
  conversationId: string;
  callerUserId: string;
  status: "working" | "complete" | "error";
  text: string;
  activity: Array<{ name: string; state: "running" | "ok" | "failed" }>;
  error?: string;
  history: Anthropic.MessageParam[];
  updatedAt: number;
}

const turns = new Map<string, Turn>();

pollingRouter.post("/chat/turn", async (req, res) => {
  const caller = req.caller as Caller | undefined;
  if (!caller) return res.status(401).json({ status: "error", error: "Not authenticated" });

  const { message, conversation_id } = req.body as {
    message?: string; conversation_id?: string | null;
  };
  if (!message?.trim()) {
    return res.status(400).json({ status: "error", error: "message is required" });
  }

  const conversationId = conversation_id ?? randomUUID();
  const prior = turns.get(conversationId);

  // A conversation belongs to the user who started it.
  if (prior && prior.callerUserId !== caller.userId) {
    return res.status(403).json({ status: "error", error: "This conversation belongs to another user." });
  }
  if (prior?.status === "working") {
    return res.status(409).json({ status: "error", error: "A turn is already in progress." });
  }

  const turn: Turn = {
    conversationId,
    callerUserId: caller.userId,
    status: "working",
    text: "",
    activity: [],
    history: prior?.history ?? [],
    updatedAt: Date.now(),
  };
  turns.set(conversationId, turn);

  // Respond immediately; the turn continues in the background.
  res.json({ conversationId, status: "working", text: "", activity: [] });

  try {
    const history = await runChatTurn({
      caller,
      history: turn.history,
      userMessage: message,
      onEvent: (e) => {
        turn.updatedAt = Date.now();
        if (e.type === "text") {
          turn.text += e.text;
        } else if (e.type === "tool_start") {
          turn.activity = [...turn.activity, { name: e.name, state: "running" }];
        } else if (e.type === "tool_end") {
          // Mark the most recent running entry for this tool.
          for (let i = turn.activity.length - 1; i >= 0; i--) {
            if (turn.activity[i]!.name === e.name && turn.activity[i]!.state === "running") {
              turn.activity[i] = { name: e.name, state: e.ok ? "ok" : "failed" };
              break;
            }
          }
          turn.activity = [...turn.activity];
        } else if (e.type === "error") {
          turn.status = "error";
          turn.error = e.message;
        }
      },
    });
    turn.history = trimHistory(history);
    if (turn.status !== "error") turn.status = "complete";
  } catch (e) {
    turn.status = "error";
    turn.error = e instanceof Error ? e.message : String(e);
  } finally {
    turn.updatedAt = Date.now();
  }
});

pollingRouter.get("/chat/poll", (req, res) => {
  const caller = req.caller as Caller | undefined;
  if (!caller) return res.status(401).json({ status: "error", error: "Not authenticated" });

  const conversationId = String(req.query.conversation_id ?? "");
  const turn = turns.get(conversationId);
  if (!turn) return res.status(404).json({ status: "error", error: "Unknown conversation." });
  if (turn.callerUserId !== caller.userId) {
    return res.status(403).json({ status: "error", error: "This conversation belongs to another user." });
  }

  res.json({
    conversationId,
    status: turn.status,
    text: turn.status === "complete" ? turn.text : "",
    activity: turn.activity,
    error: turn.error ?? null,
  });
});

function trimHistory(messages: Anthropic.MessageParam[], keep = 40): Anthropic.MessageParam[] {
  if (messages.length <= keep) return messages;
  const trimmed = messages.slice(-keep);
  while (trimmed.length > 0 && isToolResult(trimmed[0])) trimmed.shift();
  return trimmed;
}

function isToolResult(m: Anthropic.MessageParam | undefined): boolean {
  return Boolean(
    m && Array.isArray(m.content) &&
    m.content.some((b) => typeof b === "object" && b.type === "tool_result"),
  );
}

// Drop conversations idle for over an hour.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [k, v] of turns) if (v.updatedAt < cutoff) turns.delete(k);
}, 5 * 60 * 1000).unref();

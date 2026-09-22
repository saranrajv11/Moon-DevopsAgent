/**
 * Terminal chat client. Same orchestrator, same tools, same gates as the LWC —
 * just a different front end, so the AI layer can be judged before any
 * Salesforce or GitHub setup exists.
 *
 *   npm run chat
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { runChatTurn, usageFor } from "./orchestrator/agent.js";
import type { Caller, Role } from "./policy/rbac.js";

const C = {
  dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m",
  blue: "\x1b[34m", green: "\x1b[32m", red: "\x1b[31m",
  yellow: "\x1b[33m", cyan: "\x1b[36m",
};

const roles = (process.env.CHAT_ROLES ?? "developer").split(",") as Role[];
const caller: Caller = {
  userId: process.env.CHAT_USER_ID ?? "005CLI000001",
  username: process.env.CHAT_USERNAME ?? "you@local",
  displayName: process.env.CHAT_NAME ?? "You",
  roles,
  sessionId: "cli-" + Date.now(),
};

/** Rough running cost. Rates are per million tokens. */
const RATES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

function estimateCost(u: { input: number; output: number }): number {
  const r = RATES[config.anthropic.model] ?? RATES["claude-sonnet-5"]!;
  return (u.input / 1e6) * r.in + (u.output / 1e6) * r.out;
}

function banner() {
  console.log(`\n${C.bold}Moon${C.reset} ${C.dim}— DevOps agent, terminal client${C.reset}`);
  console.log(`${C.dim}model ${config.anthropic.model} · ${config.demoMode ? "DEMO data" : "LIVE org"} · roles: ${roles.join(", ")}${C.reset}`);
  if (config.demoMode) {
    console.log(`${C.dim}seeded stories: 0001 (ready for QA) · 0002 (failed in QA) · 0003 (blocked)${C.reset}`);
  }
  console.log(`${C.dim}try: "tell me everything about 0001" · "what does PR 0001 change?"${C.reset}`);
  console.log(`${C.dim}     "why did 0002 fail in QA?" · "deploy 0001 to QA"${C.reset}`);
  const r = RATES[config.anthropic.model];
  if (r) console.log(`${C.dim}billing: $${r.in}/$${r.out} per million tokens in/out · cost shown after each turn${C.reset}`);
  console.log(`${C.dim}ctrl-c to exit${C.reset}\n`);
}

async function main() {
  if (!config.anthropic.apiKey || config.anthropic.apiKey.startsWith("sk-ant-...")) {
    console.error(`${C.red}No Claude API key.${C.reset} Set ANTHROPIC_API_KEY in server/.env`);
    process.exit(1);
  }

  banner();
  const rl = createInterface({ input: stdin, output: stdout });
  let history: Anthropic.MessageParam[] = [];

  for (;;) {
    const line = (await rl.question(`${C.bold}${C.blue}› ${C.reset}`)).trim();
    if (!line) continue;
    if (line === "/reset") { history = []; console.log(`${C.dim}conversation cleared${C.reset}\n`); continue; }
    if (line === "/quit" || line === "/exit") break;

    let printedHeader = false;
    let sawText = false;

    history = await runChatTurn({
      caller,
      history,
      userMessage: line,
      onEvent: (e) => {
        if (e.type === "tool_start") {
          console.log(`  ${C.dim}· ${e.name}${C.reset}`);
        } else if (e.type === "tool_end") {
          const mark = e.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
          stdout.write(`\x1b[1A\x1b[2K  ${mark} ${C.dim}${e.name}${C.reset}\n`);
        } else if (e.type === "text") {
          if (!printedHeader) { console.log(); printedHeader = true; }
          sawText = true;
          stdout.write(e.text);
        } else if (e.type === "error") {
          console.log(`\n${C.red}error:${C.reset} ${e.message}`);
        }
      },
    });

    if (sawText) console.log();

    // Spend is shown after every turn rather than accumulating unseen.
    const u = usageFor(caller.sessionId);
    console.log(`${C.dim}  ${u.input.toLocaleString()} in / ${u.output.toLocaleString()} out · ~$${estimateCost(u).toFixed(3)} this session${C.reset}\n`);
  }

  rl.close();
}

main().catch((e) => {
  console.error(`${C.red}fatal:${C.reset}`, e instanceof Error ? e.message : e);
  process.exit(1);
});

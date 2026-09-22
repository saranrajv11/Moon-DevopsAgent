/**
 * One cheap API call to prove the key, the model id and the tool wiring all
 * work before spending anything on a real conversation.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { TOOLS } from "./tools/index.js";

const C = { red: "\x1b[31m", green: "\x1b[32m", dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m" };

async function main() {
  const key = config.anthropic.apiKey;
  if (!key || key.startsWith("sk-ant-...")) {
    console.error(`${C.red}✗${C.reset} No API key. Put ANTHROPIC_API_KEY in server/.env`);
    process.exit(1);
  }
  console.log(`${C.dim}key      ${key.slice(0, 14)}…${key.slice(-4)}${C.reset}`);
  console.log(`${C.dim}model    ${config.anthropic.model}${C.reset}`);
  console.log(`${C.dim}tools    ${TOOLS.length}${C.reset}`);
  console.log(`${C.dim}demo     ${config.demoMode}${C.reset}\n`);

  const client = new Anthropic({ apiKey: key });
  try {
    const res = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly: ready" }],
    });
    const text = res.content.find((b) => b.type === "text");
    console.log(`${C.green}✓${C.reset} API reachable — model replied ${C.bold}${text && "text" in text ? text.text.trim() : "?"}${C.reset}`);
    console.log(`${C.dim}  tokens in/out: ${res.usage.input_tokens}/${res.usage.output_tokens}${C.reset}`);
    console.log(`\n${C.green}Ready.${C.reset} Run ${C.bold}npm run chat${C.reset}`);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      console.error(`${C.red}✗ Key rejected.${C.reset} Check it was copied whole from console.anthropic.com`);
    } else if (e instanceof Anthropic.NotFoundError) {
      console.error(`${C.red}✗ Model "${config.anthropic.model}" not available to this account.${C.reset}`);
    } else if (e instanceof Anthropic.APIError && e.status === 400 && /credit|balance/i.test(e.message)) {
      console.error(`${C.red}✗ No credit.${C.reset} Add a payment method under Billing at console.anthropic.com`);
    } else {
      console.error(`${C.red}✗${C.reset}`, e instanceof Error ? e.message : e);
    }
    process.exit(1);
  }
}

main();

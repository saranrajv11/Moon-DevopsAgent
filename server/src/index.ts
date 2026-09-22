import express from "express";
import { config } from "./config.js";
import { authenticate } from "./auth.js";
import { chatRouter } from "./routes/chat.js";
import { pollingRouter } from "./routes/chatPolling.js";
import { webhookRouter } from "./routes/webhooks.js";

const app = express();

// Webhooks authenticate by signature, not by user session, and the Git handler
// needs the raw body — so it must be mounted before the JSON parser.
app.use("/api", webhookRouter);
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, cicd: config.cicd.provider }));

app.use("/api", authenticate, chatRouter);
app.use("/api", authenticate, pollingRouter);

app.listen(config.port, () => {
  console.log(`sfdevops-copilot listening on :${config.port} (cicd=${config.cicd.provider})`);
});

import { Router, raw } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import * as sf from "../connectors/salesforce.js";

export const webhookRouter = Router();

/**
 * Git webhook. Every handler is idempotent via external-id upsert, so a
 * redelivered event is harmless.
 */
webhookRouter.post("/webhooks/git", raw({ type: "application/json" }), async (req, res) => {
  const signature = req.header("x-hub-signature-256");
  const body = req.body as Buffer;

  if (!verifySignature(body, signature)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.header("x-github-event");
  const payload = JSON.parse(body.toString("utf8"));

  // Acknowledge immediately; GitHub times out at 10s and will redeliver.
  res.status(202).json({ received: true });

  try {
    if (event === "push") await handlePush(payload);
    else if (event === "pull_request" || event === "pull_request_review") await handlePullRequest(payload);
  } catch (e) {
    console.error(`[webhook] ${event} handler failed`, e);
  }
});

function verifySignature(body: Buffer, signature: string | undefined): boolean {
  if (!signature || !config.git.webhookSecret) return false;
  const expected =
    "sha256=" + createHmac("sha256", config.git.webhookSecret).update(body).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handlePush(payload: {
  ref: string;
  commits: Array<{
    id: string; message: string; url: string; timestamp: string;
    author: { name: string; email: string };
    added: string[]; modified: string[]; removed: string[];
  }>;
}) {
  const branch = payload.ref.replace("refs/heads/", "");
  // The User Story stores the branch the developer chose; that is the join.
  const us = await sf.getUserStoryByBranch(branch);
  if (!us) {
    console.warn(`[webhook] push to ${branch} but no User Story references that branch`);
    return;
  }

  const commits = payload.commits.map((c) => ({
    Commit_SHA__c: c.id,
    User_Story__c: us.Id,
    Commit_Message__c: c.message,
    Author__c: c.author.name,
    Author_Email__c: c.author.email,
    Commit_Timestamp__c: c.timestamp,
    Branch__c: branch,
    Git_URL__c: c.url,
    Files_Changed__c: [...c.added, ...c.modified, ...c.removed].join("\n").slice(0, 32000),
    Name: c.id.slice(0, 7),
  }));

  await sf.upsertByExternalId("DevOps_Commit__c", "Commit_SHA__c", commits);

  const latest = payload.commits.at(-1);
  if (latest) {
    await sf.updateRecords("DevOps_User_Story__c", [{
      Id: us.Id,
      Latest_Commit_SHA__c: latest.id,
      Latest_Commit_Message__c: latest.message.split("\n")[0]?.slice(0, 255),
      Latest_Commit_Date__c: latest.timestamp,
      Commit_Count__c: (us.Commit_Count__c ?? 0) + payload.commits.length,
    }]);
  }
}

async function handlePullRequest(payload: {
  pull_request: {
    number: number; node_id: string; title: string; state: string; draft: boolean;
    html_url: string; created_at: string; merged_at: string | null; merged: boolean;
    mergeable: boolean | null;
    head: { ref: string; sha: string }; base: { ref: string };
    user: { login: string } | null;
    requested_reviewers?: Array<{ login: string }>;
  };
}) {
  const pr = payload.pull_request;
  const us = await sf.getUserStoryByBranch(pr.head.ref);
  if (!us) return;

  const status = pr.merged ? "Merged"
    : pr.state === "closed" ? "Closed"
    : "Open";

  await sf.upsertByExternalId("DevOps_Pull_Request__c", "PR_External_Id__c", [{
    PR_External_Id__c: pr.node_id,
    User_Story__c: us.Id,
    PR_Number__c: pr.number,
    PR_Title__c: pr.title.slice(0, 255),
    Source_Branch__c: pr.head.ref,
    Target_Branch__c: pr.base.ref,
    Author__c: pr.user?.login ?? "unknown",
    Status__c: status,
    Reviewers__c: (pr.requested_reviewers ?? []).map((r) => r.login).join(", "),
    Mergeable__c: pr.mergeable ?? false,
    Created_Date_Git__c: pr.created_at,
    Merged_Date__c: pr.merged_at,
    PR_URL__c: pr.html_url,
    Name: `PR-${pr.number}`,
  }]);

  await sf.updateRecords("DevOps_User_Story__c", [{
    Id: us.Id,
    PR_Number__c: pr.number,
    PR_Status__c: status,
    PR_URL__c: pr.html_url,
  }]);
}

/**
 * CI/CD callback. Your pipeline posts here on completion so Salesforce reflects
 * the outcome without the chatbot having to be watching.
 */
webhookRouter.post("/webhooks/pipeline", async (req, res) => {
  const {
    pipeline_run_id, feature_id, target_environment, status,
    logs_url, error_details, components, test_results, commit_sha,
  } = req.body as Record<string, string | undefined>;

  if (!pipeline_run_id || !feature_id || !target_environment || !status) {
    return res.status(400).json({ error: "pipeline_run_id, feature_id, target_environment and status are required" });
  }

  const us = await sf.getUserStoryByFeatureId(feature_id);
  if (!us) return res.status(404).json({ error: `No User Story for Feature ID ${feature_id}` });

  const succeeded = status.toLowerCase() === "succeeded" || status.toLowerCase() === "success";
  const now = new Date().toISOString();

  await sf.upsertByExternalId("DevOps_Pipeline_Run__c", "External_Id__c", [{
    External_Id__c: pipeline_run_id,
    User_Story__c: us.Id,
    Status__c: succeeded ? "Succeeded" : "Failed",
    Completed_At__c: now,
    Logs_URL__c: logs_url ?? null,
  }]);

  await sf.upsertByExternalId("DevOps_Deployment__c", "External_Id__c", [{
    External_Id__c: `${pipeline_run_id}:${target_environment}`,
    User_Story__c: us.Id,
    Environment__c: target_environment,
    Status__c: succeeded ? "Succeeded" : "Failed",
    Completed_At__c: now,
    Commit_SHA__c: commit_sha ?? null,
    Error_Details__c: error_details?.slice(0, 32000) ?? null,
    Components_Deployed__c: components?.slice(0, 32000) ?? null,
    Test_Results__c: test_results?.slice(0, 32000) ?? null,
  }]);

  await sf.updateRecords("DevOps_User_Story__c", [{
    Id: us.Id,
    [`Env_${target_environment}_Status__c`]: succeeded ? "Succeeded" : "Failed",
    Deployment_Status__c: succeeded ? "Succeeded" : "Failed",
    Last_Deployment__c: now,
    ...(succeeded ? { Current_Environment__c: target_environment } : {}),
  }]);

  res.json({ ok: true });
});

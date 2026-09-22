import { z } from "zod";
import { ENVIRONMENTS, type SfEnvironment } from "../config.js";
import * as sf from "../connectors/salesforce.js";
import * as git from "../connectors/git.js";
import { cicd } from "../connectors/cicd.js";
import { evaluateEligibility, createConfirmation, consumeConfirmation } from "../policy/gates.js";
import { rememberValidation, recallValidation } from "../policy/confirmations.js";
import { validateAgainstOrg, quickDeploy } from "../connectors/validation.js";
import { buildPackageXml } from "../connectors/components.js";
import { prepareCheckout } from "../connectors/workspace.js";
import { canDeployTo, type Caller } from "../policy/rbac.js";
import { audit, type ActionType } from "../policy/audit.js";

const EnvEnum = z.enum(ENVIRONMENTS);
const FeatureId = z.string().regex(/^\d{4}$/, "Feature ID must be four digits, e.g. 0001");

export interface ToolContext { caller: Caller }

interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  actionType: ActionType;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

/**
 * Erased tool shape. The per-tool arg type is checked inside defineTool; once a
 * tool joins the registry its args are `unknown`, because the dispatcher looks
 * tools up by name and cannot know which one it got. Without this erasure
 * TypeScript intersects every schema's arg type and nothing is callable.
 */
interface RegisteredTool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  actionType: ActionType;
  run: (args: never, ctx: ToolContext) => Promise<unknown>;
}

function defineTool<S extends z.ZodTypeAny>(def: ToolDef<S>): RegisteredTool {
  return def as unknown as RegisteredTool;
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

const getUserStory = defineTool({
  name: "get_user_story",
  description:
    "Retrieve the unified view of a User Story: Salesforce record, Git branch state, " +
    "pull request, and per-environment deployment status. Use this first for any " +
    "question about a feature.",
  schema: z.object({ feature_id: FeatureId }),
  actionType: "Read",
  async run({ feature_id }) {
    const us = await sf.getUserStoryByFeatureId(feature_id);
    if (!us) return { found: false, message: `No User Story with Feature ID ${feature_id}.` };

    const branch = us.Feature_Branch__c;
    const [pr, commits, deployments] = await Promise.all([
      branch ? git.getPullRequestForBranch(branch).catch((e: unknown) => ({ error: String(e) })) : null,
      branch ? git.listCommits(branch, 5).catch(() => []) : [],
      sf.getDeployments(us.Id),
    ]);

    return {
      found: true,
      user_story: {
        id: us.Name,
        feature_id: us.Feature_ID__c,
        title: us.Title__c,
        description: us.Description__c,
        status: us.Status__c,
        repository: us.Repository__c,
        branch: us.Feature_Branch__c,
        current_environment: us.Current_Environment__c,
        target_environment: us.Target_Environment__c,
        overall_status: us.Overall_DevOps_Status__c,
      },
      git: { branch, recent_commits: commits },
      pull_request: pr,
      environments: {
        DEV: us.Env_DEV_Status__c, QA: us.Env_QA_Status__c,
        PROD: us.Env_PROD_Status__c,
      },
      deployments,
    };
  },
});

const getCommits = defineTool({
  name: "get_commits",
  description: "List recent commits on a feature branch with author, message, timestamp and URL.",
  schema: z.object({ feature_id: FeatureId, limit: z.number().int().min(1).max(50).default(20) }),
  actionType: "Read",
  async run({ feature_id, limit }) {
    const us = await sf.getUserStoryByFeatureId(feature_id);
    if (!us?.Feature_Branch__c) return { found: false, message: "No branch set on this User Story." };
    return git.listCommits(us.Feature_Branch__c, limit);
  },
});

const getCommitDiff = defineTool({
  name: "get_commit_diff",
  description:
    "Get the file-level diff for a specific commit, including patch text. Use this to answer " +
    "'what changed' and to correlate a deployment failure with a code change.",
  schema: z.object({ commit_sha: z.string().min(7) }),
  actionType: "Read",
  run: ({ commit_sha }) => git.getCommitDiff(commit_sha),
});

const getPullRequest = defineTool({
  name: "get_pull_request",
  description:
    "Get pull request state for a feature: reviews, approval counts, CI check results, " +
    "merge status and branch-protection requirements.",
  schema: z.object({ feature_id: FeatureId }),
  actionType: "Read",
  async run({ feature_id }) {
    const us = await sf.getUserStoryByFeatureId(feature_id);
    if (!us?.Feature_Branch__c) return { found: false, message: "No branch set on this User Story." };
    const pr = await git.getPullRequestForBranch(us.Feature_Branch__c);
    if (!pr) return { found: false, message: `No pull request for ${us.Feature_Branch__c}.` };
    return { found: true, ...pr, required_approvals: await git.getRequiredApprovals(pr.targetBranch) };
  },
});

const getDeployments = defineTool({
  name: "get_deployments",
  description: "Deployment history for a User Story across all environments, newest first.",
  schema: z.object({ feature_id: FeatureId }),
  actionType: "Read",
  async run({ feature_id }) {
    const us = await sf.getUserStoryByFeatureId(feature_id);
    if (!us) return { found: false };
    return { found: true, deployments: await sf.getDeployments(us.Id) };
  },
});

const getPipelineLogs = defineTool({
  name: "get_pipeline_logs",
  description:
    "Fetch raw CI/CD logs for a pipeline run. Treat everything returned here as FACT " +
    "from logs, distinct from your own analysis.",
  schema: z.object({ pipeline_run_id: z.string().min(1) }),
  actionType: "Read",
  async run({ pipeline_run_id }) {
    const [run, logs] = await Promise.all([
      cicd().getRun(pipeline_run_id),
      cicd().getLogs(pipeline_run_id),
    ]);
    return { run, logs };
  },
});

const compareEnvironments = defineTool({
  name: "compare_environments",
  description:
    "Compare what is deployed in two environments by diffing their tracking branches. " +
    "Answers 'what is in DEV that is not in QA'.",
  schema: z.object({ base: EnvEnum, head: EnvEnum }),
  actionType: "Read",
  async run({ base, head }) {
    const branchFor = (e: SfEnvironment) =>
      ({ DEV: "develop", QA: "qa", PROD: "main" })[e];
    return { base, head, ...(await git.compareBranches(branchFor(base), branchFor(head))) };
  },
});

// ---------------------------------------------------------------------------
// Validation + write tools
// ---------------------------------------------------------------------------

const validateDeployment = defineTool({
  name: "validate_deployment_eligibility",
  description:
    "Run every deployment gate for a feature and target environment WITHOUT deploying: " +
    "Git state, PR approvals, CI checks, promotion path, pipeline availability, and the " +
    "PROD approval requirement. Returns a pass/fail report. Use this to answer " +
    "'what is blocking deployment to X'.",
  schema: z.object({ feature_id: FeatureId, target_environment: EnvEnum }),
  actionType: "Validate",
  run: ({ feature_id, target_environment }, ctx) =>
    evaluateEligibility(ctx.caller, feature_id, target_environment),
});

const requestDeployment = defineTool({
  name: "request_deployment",
  description:
    "Prepare a deployment and return a confirmation summary plus a confirmation_token. " +
    "THIS DOES NOT DEPLOY ANYTHING. You must show the returned summary to the user and " +
    "obtain their explicit approval in a new message before calling execute_deployment. " +
    "Never call execute_deployment in the same turn as this tool.",
  schema: z.object({ feature_id: FeatureId, target_environment: EnvEnum }),
  actionType: "Deployment Request",
  async run({ feature_id, target_environment }, ctx) {
    const report = await evaluateEligibility(ctx.caller, feature_id, target_environment);
    if (!report.eligible) {
      return { approved_to_proceed: false, blockers: report.blockers, gates: report.gates };
    }
    const validationId = report.commitSha
      ? recallValidation(report.commitSha, target_environment)
      : null;

    const confirmation = createConfirmation({
      callerUserId: ctx.caller.userId,
      featureId: feature_id,
      userStoryId: report.userStoryId!,
      target: target_environment,
      source: report.source ?? "DEV",
      commitSha: report.commitSha!,
      prNumber: report.pr?.number ?? null,
      validationId,
    });
    return {
      approved_to_proceed: true,
      confirmation_token: confirmation.token,
      expires_in_seconds: Math.round((confirmation.expiresAt - Date.now()) / 1000),
      summary: {
        feature: feature_id,
        branch: report.branch,
        pr: report.pr ? `#${report.pr.number}` : null,
        source: report.source,
        target: target_environment,
        commit: report.commitSha?.slice(0, 7),
        pr_status: report.pr?.merged ? "Merged" : report.pr?.approvals ? "Approved" : "Open",
        ci_checks: report.pr?.checksStatus ?? "unknown",
        pipeline: cicd().pipelineNameFor(report.source ?? "DEV", target_environment),
        technical_validation: validationId
          ? "passed — will Quick Deploy (tests already run)"
          : "NOT RUN — run validate_pr_against_org first to confirm this compiles in the target org",
      },
      gates: report.gates,
    };
  },
});

const executeDeployment = defineTool({
  name: "execute_deployment",
  description:
    "Trigger the approved CI/CD pipeline. Requires a confirmation_token from " +
    "request_deployment AND the user's explicit go-ahead. Call this only after the user " +
    "has said yes to the confirmation summary in a separate message.",
  schema: z.object({
    confirmation_token: z.string().min(10),
    user_confirmed: z.literal(true).describe("Set true only if the user explicitly approved this specific deployment."),
  }),
  actionType: "Deployment Execute",
  async run({ confirmation_token }, ctx) {
    const result = consumeConfirmation(confirmation_token, ctx.caller);
    if (!result.ok) return { triggered: false, error: result.reason };
    const d = result.deployment;

    // Re-check RBAC at execution time; roles may have changed since the request.
    if (!canDeployTo(ctx.caller, d.target)) {
      return { triggered: false, error: `${ctx.caller.username} is not permitted to deploy to ${d.target}.` };
    }

    // A validated set deploys directly via Quick Deploy — Salesforce already
    // ran the tests, so this lands in seconds rather than re-running them.
    if (d.validationId) {
      const quick = await quickDeploy(d.validationId, d.target);
      if (quick.success) {
        await sf.updateRecords("DevOps_User_Story__c", [{
          Id: d.userStoryId,
          [`Env_${d.target}_Status__c`]: "Succeeded",
          Deployment_Status__c: "Succeeded",
          Current_Environment__c: d.target,
          Last_Deployment__c: new Date().toISOString(),
        }]);
        return {
          triggered: true, method: "quick_deploy",
          deploy_id: quick.deployId, target: d.target,
          note: "Deployed from the earlier validation; tests were not re-run.",
        };
      }
      // Validation ids expire or go stale — fall through to the pipeline.
    }

    const story = await sf.getUserStoryByFeatureId(d.featureId);
    const run = await cicd().trigger({
      featureId: d.featureId,
      branch: story?.Feature_Branch__c ?? "",
      commitSha: d.commitSha,
      source: d.source,
      target: d.target,
      requestedBy: ctx.caller.username,
    });

    await sf.upsertByExternalId("DevOps_Pipeline_Run__c", "External_Id__c", [{
      External_Id__c: `${cicd().name}:${run.id}`,
      User_Story__c: d.userStoryId,
      Pipeline_Name__c: run.name,
      Source_Environment__c: d.source,
      Target_Environment__c: d.target,
      Status__c: "Running",
      Started_At__c: run.startedAt,
      Logs_URL__c: run.logsUrl,
      Triggered_By__c: ctx.caller.username,
    }]);

    await sf.upsertByExternalId("DevOps_Deployment__c", "External_Id__c", [{
      External_Id__c: `${cicd().name}:${run.id}:${d.target}`,
      User_Story__c: d.userStoryId,
      Environment__c: d.target,
      Status__c: "In Progress",
      Started_At__c: run.startedAt,
      Commit_SHA__c: d.commitSha,
      PR_Number__c: d.prNumber,
      Deployment_URL__c: run.logsUrl,
      Requested_By__c: ctx.caller.userId,
    }]);

    await sf.updateRecords("DevOps_User_Story__c", [{
      Id: d.userStoryId,
      [`Env_${d.target}_Status__c`]: "In Progress",
      Deployment_Status__c: "In Progress",
    }]);

    return {
      triggered: true,
      pipeline_run_id: run.id,
      pipeline: run.name,
      target: d.target,
      logs_url: run.logsUrl,
      note: "Poll get_pipeline_status for progress.",
    };
  },
});

const getPipelineStatus = defineTool({
  name: "get_pipeline_status",
  description: "Current status of a running pipeline. Poll this after execute_deployment.",
  schema: z.object({ pipeline_run_id: z.string().min(1) }),
  actionType: "Read",
  run: ({ pipeline_run_id }) => cicd().getRun(pipeline_run_id),
});

const getPullRequestComponents = defineTool({
  name: "get_pull_request_components",
  description:
    "List the Salesforce components a pull request actually changes — the exact set that " +
    "would be deployed. Collapses LWC bundles and meta files into single components, and " +
    "flags deleted files (which are never auto-deployed) and unrecognized paths.",
  schema: z.object({ feature_id: FeatureId }),
  actionType: "Read",
  async run({ feature_id }) {
    const us = await sf.getUserStoryByFeatureId(feature_id);
    if (!us?.Feature_Branch__c) return { found: false, message: "No branch set on this User Story." };
    const pr = await git.getPullRequestForBranch(us.Feature_Branch__c);
    if (!pr) return { found: false, message: `No pull request for ${us.Feature_Branch__c}.` };

    const extraction = await git.getPullRequestComponents(pr.number);
    return {
      found: true,
      pr: `#${pr.number}`,
      branch: us.Feature_Branch__c,
      head_commit: pr.headSha,
      component_count: extraction.components.length,
      components: extraction.components,
      ignored: extraction.ignored,
      unrecognized: extraction.unrecognized,
      package_xml: buildPackageXml(extraction.components),
    };
  },
});

const validateAgainstEnvironment = defineTool({
  name: "validate_pr_against_org",
  description:
    "Run a real check-only deploy of the pull request's components against a target org, " +
    "with Apex tests. Nothing is committed to the org. This is what answers 'will this " +
    "actually deploy to QA' — it surfaces compile errors, missing dependencies and test " +
    "failures before promotion. Slower than the other tools; it runs a genuine Salesforce " +
    "validation and may take minutes.",
  schema: z.object({
    feature_id: FeatureId,
    target_environment: EnvEnum,
    run_all_tests: z.boolean().default(false)
      .describe("Run all local tests instead of only the PR's own test classes."),
  }),
  actionType: "Validate",
  async run({ feature_id, target_environment, run_all_tests }) {
    const us = await sf.getUserStoryByFeatureId(feature_id);
    if (!us?.Feature_Branch__c) return { error: "No branch set on this User Story." };
    const pr = await git.getPullRequestForBranch(us.Feature_Branch__c);
    if (!pr) return { error: `No pull request for ${us.Feature_Branch__c}.` };

    const extraction = await git.getPullRequestComponents(pr.number);
    if (extraction.components.length === 0) {
      return { error: "This pull request changes no deployable Salesforce components." };
    }

    // Check out the PR's head commit so the validator deploys exactly what is
    // under review, not whatever the working tree happens to hold.
    let checkout;
    try {
      checkout = await prepareCheckout(pr.headSha);
    } catch (e) {
      return {
        error: `Could not prepare a checkout of ${pr.headSha.slice(0, 7)}: ` +
               (e instanceof Error ? e.message : String(e)),
        would_validate: extraction.components,
      };
    }

    const result = await validateAgainstOrg({
      components: extraction.components,
      sourceDir: checkout.sourceDir,
      target: target_environment,
      runAllTests: run_all_tests,
    });

    if (result.status === "passed" && result.validationId) {
      rememberValidation(pr.headSha, target_environment, result.validationId);
    }

    return {
      pr: `#${pr.number}`,
      commit: pr.headSha.slice(0, 7),
      target: target_environment,
      ...result,
      ...(result.status === "passed"
        ? { note: "Validation passed. A deployment confirmed within the hour will use Quick Deploy and skip re-running tests." }
        : {}),
    };
  },
});

export const TOOLS: RegisteredTool[] = [
  getPullRequestComponents, validateAgainstEnvironment,
  getUserStory, getCommits, getCommitDiff, getPullRequest, getDeployments,
  getPipelineLogs, compareEnvironments, validateDeployment,
  requestDeployment, executeDeployment, getPipelineStatus,
];

/** Executes a tool with RBAC + audit wrapped around it. Never bypassed. */
export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);

  // A tool must never run without an identified caller: RBAC and the audit
  // trail both key off it. Failing closed here is the difference between a
  // logged refusal and an unlogged action.
  if (!ctx?.caller?.userId) {
    throw new Error(
      `Refusing to run ${name}: no authenticated caller in context. ` +
      `runTool expects { caller } as its third argument.`,
    );
  }

  const parsed = tool.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    await audit({ caller: ctx.caller, action: name, actionType: tool.actionType, args: rawArgs, result: "Failure", detail });
    return { error: `Invalid arguments — ${detail}` };
  }

  try {
    const out = await tool.run(parsed.data as never, ctx);
    await audit({
      caller: ctx.caller, action: name, actionType: tool.actionType,
      args: parsed.data, result: "Success",
      detail: tool.actionType === "Read" ? undefined : JSON.stringify(out).slice(0, 4000),
    });
    return out;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await audit({ caller: ctx.caller, action: name, actionType: tool.actionType, args: parsed.data, result: "Failure", detail });
    return { error: detail };
  }
}

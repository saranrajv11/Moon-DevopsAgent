import { config, nextEnvironment, type SfEnvironment } from "../config.js";
import { getUserStoryByFeatureId, getApprovalForEnvironment, type UserStoryRecord } from "../connectors/salesforce.js";
import { branchExists, getPullRequestForBranch, getRequiredApprovals, type PullRequestState } from "../connectors/git.js";
import { cicd } from "../connectors/cicd.js";
import { canDeployTo, type Caller } from "./rbac.js";

export interface Gate {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  /** A blocking gate stops the deployment. A soft gate is reported but advisory. */
  blocking: boolean;
}

export interface EligibilityReport {
  featureId: string;
  userStoryId: string | null;
  branch: string;
  source: SfEnvironment | null;
  target: SfEnvironment;
  eligible: boolean;
  gates: Gate[];
  blockers: string[];
  pr: PullRequestState | null;
  commitSha: string | null;
}

/**
 * Steps 2-4 of the deployment workflow: Git state, PR state, and deployment
 * eligibility. Returns facts only — no inference. The caller decides what to
 * do with a failed gate; this function never triggers anything.
 */
export async function evaluateEligibility(
  caller: Caller,
  featureId: string,
  target: SfEnvironment,
): Promise<EligibilityReport> {
  const gates: Gate[] = [];
  const push = (g: Gate) => gates.push(g);

  const us: UserStoryRecord | null = await getUserStoryByFeatureId(featureId);
  const branch = us?.Feature_Branch__c ?? "";

  push({
    id: "user_story_exists",
    label: "User Story exists in Salesforce",
    passed: us !== null,
    detail: us ? `${us.Name} — ${us.Title__c}` : `No User Story with Feature ID ${featureId}`,
    blocking: true,
  });

  // RBAC first: an unauthorized caller gets no further information about the
  // target environment's state.
  const authorized = canDeployTo(caller, target);
  push({
    id: "rbac",
    label: `Caller may deploy to ${target}`,
    passed: authorized,
    detail: authorized
      ? `${caller.username} holds roles: ${caller.roles.join(", ")}`
      : `${caller.username} (${caller.roles.join(", ") || "no roles"}) is not permitted to deploy to ${target}`,
    blocking: true,
  });

  if (!us || !authorized) {
    return finish(featureId, us, branch, target, gates, null, null);
  }

  // --- Step 2: Git state --------------------------------------------------
  const exists = branch.length > 0 && (await branchExists(branch));
  push({
    id: "branch_exists",
    label: `Branch ${branch} exists`,
    passed: exists,
    detail: !branch ? "User Story has no Feature Branch set"
      : exists ? `${branch} found in ${us.Repository__c}` : `${branch} not found`,
    blocking: true,
  });

  const pr = exists ? await getPullRequestForBranch(branch) : null;

  // --- Step 3: PR validation ---------------------------------------------
  push({
    id: "pr_exists",
    label: "Pull request exists",
    passed: pr !== null,
    detail: pr ? `PR #${pr.number}: ${pr.title}` : "No pull request found for this branch",
    blocking: true,
  });

  if (pr) {
    push({
      id: "pr_not_closed",
      label: "PR is not closed unmerged",
      passed: !(pr.state === "closed" && !pr.merged),
      detail: pr.state === "closed" && !pr.merged ? "PR was closed without merging" : `PR state: ${pr.state}`,
      blocking: true,
    });

    push({
      id: "pr_not_draft",
      label: "PR is not a draft",
      passed: !pr.draft,
      detail: pr.draft ? "PR is still marked draft" : "PR is ready for review",
      blocking: true,
    });

    const required = Math.max(await getRequiredApprovals(pr.targetBranch), 1);
    push({
      id: "pr_approvals",
      label: "Required approvals received",
      passed: pr.approvals >= required && pr.changesRequested === 0,
      detail: pr.changesRequested > 0
        ? `${pr.changesRequested} reviewer(s) requested changes`
        : `${pr.approvals}/${required} approvals`,
      blocking: true,
    });

    push({
      id: "ci_checks",
      label: "CI checks passed",
      passed: pr.checksStatus === "passed",
      detail: pr.checksStatus === "failed"
        ? `Failed checks: ${pr.failedChecks.join(", ")}`
        : `Checks: ${pr.checksStatus}`,
      blocking: true,
    });

    push({
      id: "mergeable",
      label: "Branch has no merge conflicts",
      passed: pr.merged || pr.mergeable !== false,
      detail: pr.mergeable === false
        ? `Merge conflict (state: ${pr.mergeableState})`
        : pr.merged ? "Already merged" : "No conflicts detected",
      blocking: true,
    });

    // Promotion beyond DEV requires the PR to actually be merged, not just approved.
    if (target !== "DEV" && config.requireMergedPrBeyondDev) {
      push({
        id: "pr_merged",
        label: `PR merged before promoting to ${target}`,
        passed: pr.merged,
        detail: pr.merged ? `Merged at ${pr.mergedAt}` : "PR is approved but not yet merged",
        blocking: true,
      });
    }
  }

  // --- Step 4: deployment eligibility ------------------------------------
  const source = us.Current_Environment__c;
  const expectedTarget = source ? nextEnvironment(source) : "DEV";
  const pathOk = target === "DEV" || target === expectedTarget;
  push({
    id: "promotion_path",
    label: "Target follows the promotion path",
    passed: pathOk,
    detail: pathOk
      ? `${source ?? "(none)"} → ${target}`
      : `Cannot deploy to ${target} from ${source ?? "(none)"}; next valid environment is ${expectedTarget ?? "none"}`,
    blocking: true,
  });

  const prevStatus = source ? envStatus(us, source) : "Succeeded";
  push({
    id: "source_env_healthy",
    label: "Source environment deployment succeeded",
    passed: source === null || prevStatus === "Succeeded",
    detail: source === null ? "No prior environment" : `${source} status: ${prevStatus}`,
    blocking: true,
  });

  const pipelineName = cicd().pipelineNameFor(source ?? "DEV", target);
  const available = await cicd().isAvailable(source ?? "DEV", target);
  push({
    id: "pipeline_available",
    label: "CI/CD pipeline is available",
    passed: available,
    detail: available ? `Pipeline: ${pipelineName}` : `Pipeline ${pipelineName} not found in ${cicd().name}`,
    blocking: true,
  });

  const targetStatus = envStatus(us, target);
  push({
    id: "no_deploy_in_flight",
    label: "No deployment already running to target",
    passed: targetStatus !== "In Progress",
    detail: targetStatus === "In Progress" ? `A deployment to ${target} is already in progress` : `${target} status: ${targetStatus}`,
    blocking: true,
  });

  // --- PROD approval gate -------------------------------------------------
  if (target === "PROD") {
    const approval = await getApprovalForEnvironment(us.Id, "PROD");
    const notExpired = approval?.Expires_At__c ? new Date(approval.Expires_At__c as string) > new Date() : true;
    const shaMatches = !approval?.Commit_SHA__c || approval.Commit_SHA__c === pr?.headSha;
    push({
      id: "prod_release_approval",
      label: "Release-manager approval on record for PROD",
      passed: Boolean(approval) && notExpired && shaMatches,
      detail: !approval
        ? "No approved DevOps_Deployment_Approval__c record for PROD"
        : !notExpired ? `Approval expired at ${approval.Expires_At__c}`
        : !shaMatches ? `Approval is for commit ${approval.Commit_SHA__c}, not ${pr?.headSha}`
        : `Approved by ${approval.Approver__c} at ${approval.Approved_At__c}`,
      blocking: true,
    });
  }

  return finish(featureId, us, branch, target, gates, pr, pr?.headSha ?? us.Latest_Commit_SHA__c ?? null);
}

function envStatus(us: UserStoryRecord, env: SfEnvironment): string {
  const key = `Env_${env}_Status__c` as keyof UserStoryRecord;
  return (us[key] as string | null) ?? "Not Started";
}

function finish(
  featureId: string, us: UserStoryRecord | null, branch: string,
  target: SfEnvironment, gates: Gate[], pr: PullRequestState | null, commitSha: string | null,
): EligibilityReport {
  const blockers = gates.filter((g) => g.blocking && !g.passed).map((g) => `${g.label}: ${g.detail}`);
  return {
    featureId,
    userStoryId: us?.Id ?? null,
    branch,
    source: us?.Current_Environment__c ?? null,
    target,
    eligible: blockers.length === 0,
    gates,
    blockers,
    pr,
    commitSha,
  };
}

export { createConfirmation, consumeConfirmation } from "./confirmations.js";

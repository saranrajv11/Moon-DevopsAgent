import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { config } from "../config.js";
import { DEMO_COMMITS, DEMO_PRS, DEMO_DIFFS } from "../demoData.js";
import { extractComponents, type ComponentExtraction } from "./components.js";

let octokit: Octokit | null = null;

/** GitHub App installation auth — short-lived tokens, repo-scoped, revocable. */
export function gh(): Octokit {
  if (octokit) return octokit;
  octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.git.appId,
      privateKey: config.git.privateKey,
      installationId: config.git.installationId,
    },
  });
  return octokit;
}

const repoArgs = () => ({ owner: config.git.owner, repo: config.git.repo });

export async function branchExists(branch: string): Promise<boolean> {
  if (config.demoMode) return Object.values(DEMO_COMMITS).some((_, i) => i >= 0) && demoBranchExists(branch);
  try {
    await gh().repos.getBranch({ ...repoArgs(), branch });
    return true;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return false;
    throw e;
  }
}

export async function listCommits(branch: string, limit = 20) {
  if (config.demoMode) return demoCommitsFor(branch).slice(0, limit);
  const { data } = await gh().repos.listCommits({
    ...repoArgs(),
    sha: branch,
    per_page: limit,
  });
  return data.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    author: c.commit.author?.name ?? c.author?.login ?? "unknown",
    authorEmail: c.commit.author?.email ?? null,
    timestamp: c.commit.author?.date ?? null,
    url: c.html_url,
  }));
}

export async function getCommitDiff(sha: string) {
  if (config.demoMode) {
    return DEMO_DIFFS[sha] ?? { error: `No diff recorded for ${sha} in demo data.` };
  }
  const { data } = await gh().repos.getCommit({ ...repoArgs(), ref: sha });
  return {
    sha: data.sha,
    message: data.commit.message,
    author: data.commit.author?.name ?? "unknown",
    stats: data.stats,
    files: (data.files ?? []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch?.slice(0, 4000) ?? null,
    })),
  };
}

export interface PullRequestState {
  number: number;
  nodeId: string;
  title: string;
  state: string;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  url: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  headSha: string;
  createdAt: string;
  mergedAt: string | null;
  approvals: number;
  changesRequested: number;
  reviewers: string[];
  checksStatus: "passed" | "failed" | "pending" | "not_run";
  failedChecks: string[];
}

/** Every file the PR changes, which becomes the deployable component set. */
export async function getPullRequestComponents(prNumber: number): Promise<ComponentExtraction> {
  if (config.demoMode) {
    return extractComponents(DEMO_PR_FILES[String(prNumber)] ?? []);
  }
  const files = await gh().paginate(gh().pulls.listFiles, {
    ...repoArgs(), pull_number: prNumber, per_page: 100,
  });
  return extractComponents(files.map((f) => ({ filename: f.filename, status: f.status })));
}

/**
 * The PR for a branch. The User Story stores the branch name the developer
 * actually used, and GitHub finds its PRs directly — no naming convention and
 * no ID embedded anywhere.
 */
export async function getPullRequestForBranch(branch: string): Promise<PullRequestState | null> {
  if (config.demoMode) return demoPrFor(branch);
  const { data: open } = await gh().pulls.list({
    ...repoArgs(),
    head: `${config.git.owner}:${branch}`,
    state: "all",
    sort: "created",
    direction: "desc",
    per_page: 1,
  });
  const pr = open[0];
  if (!pr) return null;

  const [{ data: full }, { data: reviews }] = await Promise.all([
    gh().pulls.get({ ...repoArgs(), pull_number: pr.number }),
    gh().pulls.listReviews({ ...repoArgs(), pull_number: pr.number, per_page: 100 }),
  ]);

  // Latest review per reviewer wins — an APPROVED that was later superseded by
  // CHANGES_REQUESTED must not count as an approval.
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (!r.user?.login) continue;
    if (r.state === "COMMENTED") continue;
    latest.set(r.user.login, r.state);
  }

  const checks = await getChecksForRef(full.head.sha);

  return {
    number: full.number,
    nodeId: full.node_id,
    title: full.title,
    state: full.state,
    draft: full.draft ?? false,
    sourceBranch: full.head.ref,
    targetBranch: full.base.ref,
    author: full.user?.login ?? "unknown",
    url: full.html_url,
    merged: full.merged ?? false,
    mergeable: full.mergeable,
    mergeableState: full.mergeable_state ?? "unknown",
    headSha: full.head.sha,
    createdAt: full.created_at,
    mergedAt: full.merged_at,
    approvals: [...latest.values()].filter((s) => s === "APPROVED").length,
    changesRequested: [...latest.values()].filter((s) => s === "CHANGES_REQUESTED").length,
    reviewers: [...latest.keys()],
    checksStatus: checks.status,
    failedChecks: checks.failed,
  };
}

async function getChecksForRef(ref: string) {
  const { data } = await gh().checks.listForRef({ ...repoArgs(), ref, per_page: 100 });
  const runs = data.check_runs;
  if (runs.length === 0) return { status: "not_run" as const, failed: [] as string[] };
  const failed = runs
    .filter((r) => r.conclusion && !["success", "neutral", "skipped"].includes(r.conclusion))
    .map((r) => r.name);
  const pending = runs.some((r) => r.status !== "completed");
  if (failed.length > 0) return { status: "failed" as const, failed };
  if (pending) return { status: "pending" as const, failed: [] };
  return { status: "passed" as const, failed: [] };
}

/** Branch protection rules for the PR's target branch — the real approval floor. */
export async function getRequiredApprovals(targetBranch: string): Promise<number> {
  if (config.demoMode) return 2;
  try {
    const { data } = await gh().repos.getBranchProtection({ ...repoArgs(), branch: targetBranch });
    return data.required_pull_request_reviews?.required_approving_review_count ?? 0;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return 0; // unprotected branch
    throw e;
  }
}

export async function compareBranches(base: string, head: string) {
  if (config.demoMode) {
    return {
      status: "ahead", aheadBy: 2, behindBy: 0,
      commits: [
        { sha: "abc123d", message: "Add payment validation logic", author: "John Mathew" },
        { sha: "bb2299e", message: "Handle null payment method", author: "John Mathew" },
      ],
      files: ["force-app/main/default/classes/PaymentValidator.cls"],
    };
  }
  const { data } = await gh().repos.compareCommitsWithBasehead({
    ...repoArgs(),
    basehead: `${base}...${head}`,
  });
  return {
    status: data.status,
    aheadBy: data.ahead_by,
    behindBy: data.behind_by,
    commits: data.commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      author: c.commit.author?.name ?? "unknown",
    })),
    files: (data.files ?? []).map((f) => f.filename),
  };
}


// ---------------------------------------------------------------------------
// Demo-mode lookups, keyed by branch name rather than feature id.
// ---------------------------------------------------------------------------

function demoBranchExists(branch: string): boolean {
  return Object.values(DEMO_PRS).some((pr) => pr.sourceBranch === branch);
}

function demoCommitsFor(branch: string) {
  const entry = Object.entries(DEMO_PRS).find(([, pr]) => pr.sourceBranch === branch);
  return entry ? (DEMO_COMMITS[entry[0]] ?? []) : [];
}

function demoPrFor(branch: string): PullRequestState | null {
  const found = Object.values(DEMO_PRS).find((pr) => pr.sourceBranch === branch);
  return (found as PullRequestState | undefined) ?? null;
}

const DEMO_PR_FILES: Record<string, Array<{ filename: string; status: string }>> = {
  "245": [
    { filename: "force-app/main/default/classes/PaymentValidator.cls", status: "modified" },
    { filename: "force-app/main/default/classes/PaymentValidatorTest.cls", status: "added" },
    { filename: "force-app/main/default/objects/Order__c/fields/Payment_Status__c.field-meta.xml", status: "added" },
    { filename: "force-app/main/default/lwc/paymentPanel/paymentPanel.js", status: "modified" },
    { filename: "force-app/main/default/lwc/paymentPanel/paymentPanel.html", status: "modified" },
    { filename: "README.md", status: "modified" },
  ],
  "251": [
    { filename: "force-app/main/default/classes/OrderTotalService.cls", status: "modified" },
    { filename: "force-app/main/default/classes/OrderTotalServiceTest.cls", status: "modified" },
  ],
  "258": [
    { filename: "force-app/main/default/classes/LoginController.cls", status: "modified" },
  ],
};

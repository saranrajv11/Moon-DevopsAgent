import "dotenv/config";
import { readFileSync } from "node:fs";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const ENVIRONMENTS = ["DEV", "QA", "PROD"] as const;
export type SfEnvironment = (typeof ENVIRONMENTS)[number];

/** The only legal promotion path. Index order is the promotion order. */
export const PROMOTION_PATH: SfEnvironment[] = ["DEV", "QA", "PROD"];

export function nextEnvironment(from: SfEnvironment): SfEnvironment | null {
  const i = PROMOTION_PATH.indexOf(from);
  return i >= 0 && i < PROMOTION_PATH.length - 1 ? PROMOTION_PATH[i + 1]! : null;
}

export const config = {
  demoMode: opt("DEMO_MODE", "false") === "true",
  port: Number(opt("PORT", "3001")),
  anthropic: {
    apiKey: opt("ANTHROPIC_API_KEY"),
    model: opt("CLAUDE_MODEL", "claude-sonnet-5"),
    /** Hard ceiling on tool iterations per turn. Each one is a billed API call. */
    maxIterations: Number(opt("MAX_TOOL_ITERATIONS", "12")),
    /** Refuse to start a turn once a session has spent this many API calls. */
    maxCallsPerSession: Number(opt("MAX_CALLS_PER_SESSION", "60")),
  },
  salesforce: {
    /** Dev only: reuse a CLI-authorized org instead of the JWT flow. */
    cliOrgAlias: opt("SF_CLI_ORG_ALIAS"),
    loginUrl: opt("SF_LOGIN_URL", "https://login.salesforce.com"),
    clientId: opt("SF_CLIENT_ID"),
    username: opt("SF_USERNAME"),
    privateKey: (() => {
      const p = opt("SF_PRIVATE_KEY_PATH");
      try { return p ? readFileSync(p, "utf8") : ""; } catch { return ""; }
    })(),
  },
  git: {
    provider: opt("GIT_PROVIDER", "github"),
    appId: opt("GITHUB_APP_ID"),
    privateKey: (() => {
      const p = opt("GITHUB_PRIVATE_KEY_PATH");
      try { return p ? readFileSync(p, "utf8") : ""; } catch { return ""; }
    })(),
    installationId: opt("GITHUB_INSTALLATION_ID"),
    webhookSecret: opt("GITHUB_WEBHOOK_SECRET"),
    owner: opt("GITHUB_OWNER"),
    repo: opt("GITHUB_REPO"),
  },
  cicd: {
    provider: opt("CICD_PROVIDER", "mock"),
    jenkinsBaseUrl: opt("JENKINS_BASE_URL"),
    jenkinsUser: opt("JENKINS_USER"),
    jenkinsToken: opt("JENKINS_API_TOKEN"),
  },
  confirmationTtlSeconds: Number(opt("CONFIRMATION_TTL_SECONDS", "300")),
  /** Where validation clones live. The PR's head commit is checked out here. */
  workspaceRoot: opt("WORKSPACE_ROOT", "/tmp/sfdevops-workspaces"),
  /** Metadata root inside the repo, passed to the deploy as --source-dir. */
  sourcePath: opt("SOURCE_PATH", "force-app"),
  /**
   * Whether promoting beyond DEV requires the PR to be merged, not merely
   * approved. Your spec allowed either ("merged or ready according to
   * deployment policy"); this makes the policy explicit rather than assumed.
   */
  requireMergedPrBeyondDev: opt("REQUIRE_MERGED_PR_BEYOND_DEV", "true") === "true",
};



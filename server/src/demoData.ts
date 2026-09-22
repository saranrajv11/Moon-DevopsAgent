import type { SfEnvironment } from "./config.js";

/**
 * In-memory stand-in for Salesforce, used when DEMO_MODE=true. Lets the whole
 * system — tools, gates, confirmation flow, orchestrator — run end to end with
 * no org, no Git app and no CI/CD. Shapes match the real connectors exactly, so
 * switching to a live org changes configuration, not code.
 */

export interface DemoStory {
  Id: string;
  Name: string;
  Feature_ID__c: string;
  Feature_Branch__c: string;
  Title__c: string;
  Description__c: string;
  Status__c: string;
  Repository__c: string;
  Current_Environment__c: SfEnvironment | null;
  Target_Environment__c: SfEnvironment | null;
  Commit_Count__c: number;
  Latest_Commit_SHA__c: string;
  Latest_Commit_Message__c: string;
  PR_Number__c: number | null;
  PR_Status__c: string;
  PR_URL__c: string | null;
  Deployment_Status__c: string;
  Overall_DevOps_Status__c: string;
  Env_DEV_Status__c: string;
  Env_QA_Status__c: string;
  Env_PROD_Status__c: string;
}

const REPO = "saranrajv11/Moon-DevopsAgent";

export const DEMO_STORIES: DemoStory[] = [
  {
    Id: "a01DEMO000001", Name: "US-0001", Feature_ID__c: "0001",
    Feature_Branch__c: "saran/payment-validation",
    Title__c: "Add Payment Validation",
    Description__c: "Validate payment method and amount before order submission.",
    Status__c: "Ready for QA", Repository__c: REPO,
    Current_Environment__c: "DEV", Target_Environment__c: "QA",
    Commit_Count__c: 7,
    Latest_Commit_SHA__c: "abc123def4567890abc123def4567890abc123de",
    Latest_Commit_Message__c: "Add payment validation logic",
    PR_Number__c: 245, PR_Status__c: "Approved",
    PR_URL__c: `https://github.com/${REPO}/pull/245`,
    Deployment_Status__c: "Succeeded",
    Overall_DevOps_Status__c: "⏳ Ready to Deploy",
    Env_DEV_Status__c: "Succeeded", Env_QA_Status__c: "Ready",
    Env_PROD_Status__c: "Not Started",
  },
  {
    // Failed in QA — exercises the RCA path.
    Id: "a01DEMO000002", Name: "US-0002", Feature_ID__c: "0002",
    Feature_Branch__c: "refactor/order-totals",
    Title__c: "Refactor Order Totals",
    Description__c: "Consolidate tax and discount calculation into one service.",
    Status__c: "Blocked", Repository__c: REPO,
    Current_Environment__c: "DEV", Target_Environment__c: "QA",
    Commit_Count__c: 12,
    Latest_Commit_SHA__c: "f00dcafe1234567890f00dcafe1234567890f00d",
    Latest_Commit_Message__c: "Consolidate discount rounding",
    PR_Number__c: 251, PR_Status__c: "Merged",
    PR_URL__c: `https://github.com/${REPO}/pull/251`,
    Deployment_Status__c: "Failed",
    Overall_DevOps_Status__c: "❌ Deployment Failed",
    Env_DEV_Status__c: "Succeeded", Env_QA_Status__c: "Failed",
    Env_PROD_Status__c: "Not Started",
  },
  {
    // PR still open with a failing check — exercises the blocking gates.
    Id: "a01DEMO000003", Name: "US-0003", Feature_ID__c: "0003",
    Feature_Branch__c: "sw/login-rate-limit",
    Title__c: "Customer Portal Login Rate Limit",
    Description__c: "Throttle repeated failed logins on the community portal.",
    Status__c: "In Review", Repository__c: REPO,
    Current_Environment__c: null, Target_Environment__c: "DEV",
    Commit_Count__c: 3,
    Latest_Commit_SHA__c: "99aa88bb77cc66dd55ee44ff33aa22bb11cc00dd",
    Latest_Commit_Message__c: "Add throttle counter to LoginController",
    PR_Number__c: 258, PR_Status__c: "Open",
    PR_URL__c: `https://github.com/${REPO}/pull/258`,
    Deployment_Status__c: "Not Started",
    Overall_DevOps_Status__c: "👀 In Review",
    Env_DEV_Status__c: "Ready", Env_QA_Status__c: "Not Started",
    Env_PROD_Status__c: "Not Started",
  },
];

export const DEMO_COMMITS: Record<string, Array<{
  sha: string; message: string; author: string; authorEmail: string;
  timestamp: string; url: string;
}>> = {
  "0001": [
    c("abc123def4567890abc123def4567890abc123de", "Add payment validation logic", "John Mathew", "2026-09-19T09:51:00Z"),
    c("bb2299ee44aa1177cc3388ff55dd0066aa99bb22", "Handle null payment method", "John Mathew", "2026-09-19T08:32:00Z"),
    c("cc3311aa88ff2255dd7744bb99ee0033cc66aa11", "Add PaymentValidatorTest", "John Mathew", "2026-09-18T17:14:00Z"),
  ],
  "0002": [
    c("f00dcafe1234567890f00dcafe1234567890f00d", "Consolidate discount rounding", "Priya Nair", "2026-09-19T14:02:00Z"),
    c("ab77cd44ef11ab77cd44ef11ab77cd44ef11ab77", "Move tax calc into OrderTotalService", "Priya Nair", "2026-09-19T11:47:00Z"),
  ],
  "0003": [
    c("99aa88bb77cc66dd55ee44ff33aa22bb11cc00dd", "Add throttle counter to LoginController", "Sam Whitfield", "2026-09-20T10:05:00Z"),
  ],
};

function c(sha: string, message: string, author: string, timestamp: string) {
  return {
    sha, message, author,
    authorEmail: author.toLowerCase().replace(/\s+/g, ".") + "@example.com",
    timestamp,
    url: `https://github.com/${REPO}/commit/${sha}`,
  };
}

export const DEMO_PRS: Record<string, {
  number: number; nodeId: string; title: string; state: string; draft: boolean;
  sourceBranch: string; targetBranch: string; author: string; url: string;
  merged: boolean; mergeable: boolean | null; mergeableState: string;
  headSha: string; createdAt: string; mergedAt: string | null;
  approvals: number; changesRequested: number; reviewers: string[];
  checksStatus: "passed" | "failed" | "pending" | "not_run"; failedChecks: string[];
}> = {
  "0001": {
    number: 245, nodeId: "PR_demo245", title: "Add payment validation",
    state: "open", draft: false, sourceBranch: "saran/payment-validation", targetBranch: "develop",
    author: "jmathew", url: `https://github.com/${REPO}/pull/245`,
    merged: false, mergeable: true, mergeableState: "clean",
    headSha: "abc123def4567890abc123def4567890abc123de",
    createdAt: "2026-09-18T16:00:00Z", mergedAt: null,
    approvals: 2, changesRequested: 0, reviewers: ["akhil", "lena"],
    checksStatus: "passed", failedChecks: [],
  },
  "0002": {
    number: 251, nodeId: "PR_demo251", title: "Refactor order totals",
    state: "closed", draft: false, sourceBranch: "refactor/order-totals", targetBranch: "develop",
    author: "pnair", url: `https://github.com/${REPO}/pull/251`,
    merged: true, mergeable: null, mergeableState: "unknown",
    headSha: "f00dcafe1234567890f00dcafe1234567890f00d",
    createdAt: "2026-09-19T10:00:00Z", mergedAt: "2026-09-19T15:20:00Z",
    approvals: 2, changesRequested: 0, reviewers: ["akhil", "lena"],
    checksStatus: "passed", failedChecks: [],
  },
  "0003": {
    number: 258, nodeId: "PR_demo258", title: "Rate limit portal logins",
    state: "open", draft: false, sourceBranch: "sw/login-rate-limit", targetBranch: "develop",
    author: "swhitfield", url: `https://github.com/${REPO}/pull/258`,
    merged: false, mergeable: true, mergeableState: "blocked",
    headSha: "99aa88bb77cc66dd55ee44ff33aa22bb11cc00dd",
    createdAt: "2026-09-20T09:40:00Z", mergedAt: null,
    approvals: 0, changesRequested: 1, reviewers: ["akhil"],
    checksStatus: "failed", failedChecks: ["apex-tests"],
  },
};

export const DEMO_DEPLOYMENTS: Record<string, unknown[]> = {
  "0001": [{
    Name: "DEP-00001", Environment__c: "DEV", Status__c: "Succeeded",
    Started_At__c: "2026-09-19T10:02:00Z", Completed_At__c: "2026-09-19T10:09:00Z",
    Commit_SHA__c: "abc123def4567890abc123def4567890abc123de", PR_Number__c: 245,
    Error_Details__c: null, Deployment_URL__c: `https://github.com/${REPO}/actions/runs/1012`,
  }],
  "0002": [{
    Name: "DEP-00004", Environment__c: "QA", Status__c: "Failed",
    Started_At__c: "2026-09-19T16:10:00Z", Completed_At__c: "2026-09-19T16:19:00Z",
    Commit_SHA__c: "f00dcafe1234567890f00dcafe1234567890f00d", PR_Number__c: 251,
    Deployment_URL__c: `https://github.com/${REPO}/actions/runs/1024`,
    Error_Details__c:
      "OrderTotalServiceTest.testDiscountRounding: System.AssertException: " +
      "Assertion Failed: Expected: 19.99, Actual: 20.00\n" +
      "Class.OrderTotalServiceTest.testDiscountRounding: line 42, column 1",
  }, {
    Name: "DEP-00003", Environment__c: "DEV", Status__c: "Succeeded",
    Started_At__c: "2026-09-19T15:30:00Z", Completed_At__c: "2026-09-19T15:38:00Z",
    Commit_SHA__c: "f00dcafe1234567890f00dcafe1234567890f00d", PR_Number__c: 251,
    Error_Details__c: null, Deployment_URL__c: `https://github.com/${REPO}/actions/runs/1021`,
  }],
  "0003": [],
};

export const DEMO_DIFFS: Record<string, {
  sha: string; message: string; author: string;
  stats: { additions: number; deletions: number; total: number };
  files: Array<{ filename: string; status: string; additions: number; deletions: number; patch: string | null }>;
}> = {
  f00dcafe1234567890f00dcafe1234567890f00d: {
    sha: "f00dcafe1234567890f00dcafe1234567890f00d",
    message: "Consolidate discount rounding",
    author: "Priya Nair",
    stats: { additions: 18, deletions: 11, total: 29 },
    files: [{
      filename: "force-app/main/default/classes/OrderTotalService.cls",
      status: "modified", additions: 18, deletions: 11,
      patch:
        "@@ -38,11 +38,18 @@\n" +
        "-        return amount.setScale(2, RoundingMode.HALF_UP);\n" +
        "+        // Round each component before summing\n" +
        "+        Decimal net = (amount - discount).setScale(2, RoundingMode.HALF_DOWN);\n" +
        "+        return net;\n",
    }],
  },
};

export const DEMO_LOGS: Record<string, string> = {
  "1024":
    "JOB deploy [failure]\n" +
    "    success  Checkout\n" +
    "    success  Install Salesforce CLI\n" +
    "    success  Authenticate to QA org\n" +
    "    failure  Deploy\n" +
    "=== Apex test results ===\n" +
    "OrderTotalServiceTest.testDiscountRounding  FAIL\n" +
    "  System.AssertException: Assertion Failed: Expected: 19.99, Actual: 20.00\n" +
    "  Class.OrderTotalServiceTest.testDiscountRounding: line 42, column 1\n" +
    "OrderTotalServiceTest.testTaxCalculation    PASS\n" +
    "Test run coverage: 81%\n",
  "1012":
    "JOB deploy [success]\n" +
    "    success  Checkout\n" +
    "    success  Deploy\n" +
    "All 34 tests passed. Coverage 87%.\n",
};

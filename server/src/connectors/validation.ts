import { existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config, type SfEnvironment } from "../config.js";
import { apexTestClasses, type SfComponent } from "./components.js";

const run = promisify(execFile);

export interface ValidationResult {
  status: "passed" | "failed" | "error";
  validationId: string | null;   // reusable for a Quick Deploy when it passes
  targetOrg: string;
  componentsChecked: number;
  componentErrors: Array<{ component: string; problem: string; line?: number }>;
  testsRun: number;
  testFailures: Array<{ testClass: string; method: string; message: string; stackTrace?: string }>;
  codeCoverage: number | null;
  elapsedMs: number;
  raw?: string;
}

/**
 * Check-only deploy of exactly the PR's components against the target org.
 *
 * This is the real Salesforce validation: components are compiled in the target,
 * Apex tests run, dependency errors surface. Nothing is committed to the org —
 * a passing run returns a validation id that a later Quick Deploy can reuse,
 * so the promotion does not have to re-run the tests.
 */
export async function validateAgainstOrg(args: {
  components: SfComponent[];
  sourceDir: string;           // local checkout of the PR's head commit
  target: SfEnvironment;
  runAllTests?: boolean;
}): Promise<ValidationResult> {
  const started = Date.now();
  const orgAlias = orgAliasFor(args.target);

  if (args.components.length === 0) {
    return {
      status: "error", validationId: null, targetOrg: orgAlias,
      componentsChecked: 0, componentErrors: [],
      testsRun: 0, testFailures: [], codeCoverage: null,
      elapsedMs: 0,
      raw: "No deployable components in this pull request.",
    };
  }

  // Scope tests to the PR's own test classes when we can; fall back to
  // RunLocalTests when the PR ships no tests of its own.
  const tests = apexTestClasses(args.components);
  const testArgs = args.runAllTests || tests.length === 0
    ? ["--test-level", "RunLocalTests"]
    : ["--test-level", "RunSpecifiedTests", ...tests.flatMap((t) => ["--tests", t])];

  // `sf` rejects --manifest together with --source-dir, and a manifest alone
  // cannot locate files on disk. So each component is passed as its own
  // --source-dir: the deploy then contains exactly the PR's components and
  // nothing else, which is the property the manifest was there to guarantee.
  const paths = componentPaths(args.components, args.sourceDir);
  if (paths.length === 0) {
    return errorResult(orgAlias, args.components.length, Date.now() - started,
      "None of the PR's components could be located in the checkout.");
  }

  // The sf CLI must run from inside an SFDX project, and paths are passed
  // relative to it, so the checkout's repo root is the working directory.
  const projectRoot = repoRootOf(args.sourceDir);
  const { stdout } = await run("sf", [
    "project", "deploy", "validate",
    ...paths.map((p) => ["--source-dir", relative(projectRoot, p)]).flat(),
    "--target-org", orgAlias,
    ...testArgs,
    "--json",
    "--wait", "30",
  ], { cwd: projectRoot, maxBuffer: 32 * 1024 * 1024 }).catch((e: { stdout?: string; stderr?: string }) => ({
    // sf exits non-zero on validation failure; the JSON body is still what we want.
    stdout: e.stdout ?? JSON.stringify({ status: 1, message: e.stderr ?? "sf CLI failed" }),
  }));

  return parseValidation(stdout, orgAlias, args.components.length, Date.now() - started);
}

/**
 * Resolve each component back to a path inside the checkout. A component's
 * own `path` came from the PR file list, so it is relative to the repo root
 * while sourceDir points at the metadata root — hence the two candidates.
 */
function componentPaths(components: SfComponent[], sourceDir: string): string[] {
  const out = new Set<string>();
  for (const c of components) {
    // Bundles and objects deploy as a directory; single files as themselves.
    const isDir = ["LightningComponentBundle", "AuraDefinitionBundle", "ExperienceBundle"]
      .includes(c.type);
    const rel = isDir ? dirname(c.path) : c.path;
    for (const candidate of [join(sourceDir, rel), join(sourceDir, "..", rel), rel]) {
      if (existsSync(candidate)) { out.add(candidate); break; }
    }
  }
  return [...out];
}

/** Walk up from the metadata dir to the directory holding sfdx-project.json. */
function repoRootOf(sourceDir: string): string {
  let dir = resolve(sourceDir);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "sfdx-project.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dirname(resolve(sourceDir));
}

function errorResult(
  orgAlias: string, count: number, elapsedMs: number, message: string,
): ValidationResult {
  return {
    status: "error", validationId: null, targetOrg: orgAlias,
    componentsChecked: count, componentErrors: [],
    testsRun: 0, testFailures: [], codeCoverage: null,
    elapsedMs, raw: message,
  };
}

function parseValidation(
  stdout: string, orgAlias: string, componentCount: number, elapsedMs: number,
): ValidationResult {
  let body: {
    status?: number;
    /** On failure the CLI returns an error envelope instead of `result`. */
    name?: string;
    message?: string;
    data?: { deployId?: string };
    result?: {
      id?: string; success?: boolean;
      numberComponentsTotal?: number; numberTestsTotal?: number;
      details?: {
        componentFailures?: Array<{ fullName?: string; componentType?: string; problem?: string; lineNumber?: number }>;
        runTestResult?: {
          failures?: Array<{ name?: string; methodName?: string; message?: string; stackTrace?: string }>;
          codeCoverage?: Array<{ numLocations?: number; numLocationsNotCovered?: number }>;
          numTestsRun?: number;
        };
      };
    };
  };

  try {
    body = JSON.parse(stdout);
  } catch {
    return {
      status: "error", validationId: null, targetOrg: orgAlias,
      componentsChecked: componentCount, componentErrors: [],
      testsRun: 0, testFailures: [], codeCoverage: null, elapsedMs,
      raw: stdout.slice(0, 4000),
    };
  }

  const r = body.result ?? {};

  // A failed validation comes back as an error envelope whose `message` carries
  // the failures as text, with no structured details. Parse them out so the
  // caller sees real test names rather than an opaque error.
  if (body.name && body.message && !r.details) {
    const parsed = parseFailureMessage(body.message);
    return {
      status: "failed",
      validationId: null,
      targetOrg: orgAlias,
      componentsChecked: componentCount,
      componentErrors: parsed.componentErrors,
      testsRun: parsed.testFailures.length,
      testFailures: parsed.testFailures,
      codeCoverage: null,
      elapsedMs,
      raw: body.message.slice(0, 4000),
    };
  }

  const failures = toArray(r.details?.componentFailures);
  const testFailures = toArray(r.details?.runTestResult?.failures);

  const cov = toArray(r.details?.runTestResult?.codeCoverage);
  const totalLines = cov.reduce((s, c) => s + (c.numLocations ?? 0), 0);
  const uncovered = cov.reduce((s, c) => s + (c.numLocationsNotCovered ?? 0), 0);

  return {
    status: r.success ? "passed" : failures.length || testFailures.length ? "failed" : "error",
    validationId: r.id ?? null,
    targetOrg: orgAlias,
    componentsChecked: r.numberComponentsTotal ?? componentCount,
    componentErrors: failures.map((f) => ({
      component: `${f.componentType ?? "?"}: ${f.fullName ?? "?"}`,
      problem: f.problem ?? "unknown error",
      ...(f.lineNumber ? { line: f.lineNumber } : {}),
    })),
    testsRun: r.details?.runTestResult?.numTestsRun ?? r.numberTestsTotal ?? 0,
    testFailures: testFailures.map((t) => ({
      testClass: t.name ?? "?",
      method: t.methodName ?? "?",
      message: t.message ?? "",
      ...(t.stackTrace ? { stackTrace: t.stackTrace } : {}),
    })),
    codeCoverage: totalLines > 0
      ? Math.round(((totalLines - uncovered) / totalLines) * 100)
      : null,
    elapsedMs,
    ...(body.message && !r.id ? { raw: body.message } : {}),
  };
}

/**
 * Deploy a previously-validated set using its validation id. Salesforce skips
 * the tests because it already ran them, so a promotion that was validated
 * minutes ago lands in seconds instead of re-running the whole suite.
 * Validation ids expire after 10 days, or when the target org changes beneath
 * them — a failure here means falling back to a full deploy.
 */
export async function quickDeploy(validationId: string, target: SfEnvironment): Promise<{
  success: boolean; deployId: string | null; error?: string;
}> {
  const orgAlias = orgAliasFor(target);
  try {
    const { stdout } = await run("sf", [
      "project", "deploy", "quick",
      "--job-id", validationId,
      "--target-org", orgAlias,
      "--json", "--wait", "30",
    ], { maxBuffer: 32 * 1024 * 1024 });
    const body = JSON.parse(stdout) as { result?: { id?: string; success?: boolean } };
    return { success: body.result?.success ?? false, deployId: body.result?.id ?? null };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    let message = err.stderr ?? "quick deploy failed";
    try {
      const body = JSON.parse(err.stdout ?? "{}") as { message?: string };
      if (body.message) message = body.message;
    } catch { /* keep stderr */ }
    return { success: false, deployId: null, error: message };
  }
}

/**
 * Pull structured failures out of the CLI's plain-text error message, e.g.
 *   PaymentValidatorTest.rejectsNonPositive - System.AssertException: ...
 *   ClassName - problem text
 */
function parseFailureMessage(message: string): {
  testFailures: ValidationResult["testFailures"];
  componentErrors: ValidationResult["componentErrors"];
} {
  const testFailures: ValidationResult["testFailures"] = [];
  const componentErrors: ValidationResult["componentErrors"] = [];

  for (const line of message.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (/^Failed to validate|^Due To:?$/i.test(line)) continue;

    const test = /^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s+-\s+(.*)$/.exec(line);
    if (test) {
      testFailures.push({ testClass: test[1]!, method: test[2]!, message: test[3]!.trim() });
      continue;
    }
    const comp = /^([A-Za-z0-9_.\/-]+)\s+-\s+(.*)$/.exec(line);
    if (comp) {
      componentErrors.push({ component: comp[1]!, problem: comp[2]!.trim() });
    }
  }
  return { testFailures, componentErrors };
}

function toArray<T>(v: T | T[] | undefined): T[] {
  // The Metadata API returns a bare object when there is exactly one failure.
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Org aliases follow the environment names; configurable per deployment. */
export function orgAliasFor(env: SfEnvironment): string {
  const custom = process.env[`SF_ORG_${env}`];
  return custom && custom.length > 0 ? custom : env.toLowerCase();
}

export { config };

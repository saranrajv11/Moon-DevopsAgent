import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

const run = promisify(execFile);

/**
 * A local git checkout the validator can deploy from.
 *
 * Validation needs real files on disk — the Metadata API deploys source, not a
 * diff. This keeps one bare-ish clone per repository and checks out the exact
 * commit under test, so two concurrent validations of different PRs cannot
 * fight over the working tree.
 */

const ROOT = config.workspaceRoot;

export interface Checkout {
  /** Directory to pass to `sf project deploy validate --source-dir`. */
  sourceDir: string;
  commitSha: string;
  repoDir: string;
}

let cloneLock: Promise<unknown> = Promise.resolve();

/**
 * Serialize git operations against the shared clone. Checkouts mutate the
 * working tree, so overlapping validations would otherwise read each other's
 * files.
 */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = cloneLock.then(fn, fn);
  cloneLock = next.catch(() => undefined);
  return next;
}

export async function prepareCheckout(commitSha: string): Promise<Checkout> {
  if (!config.git.owner || !config.git.repo) {
    throw new Error("GITHUB_OWNER and GITHUB_REPO must be set to validate from source.");
  }

  return withLock(async () => {
    await mkdir(ROOT, { recursive: true });
    const repoDir = join(ROOT, `${config.git.owner}__${config.git.repo}`);

    if (!(await exists(join(repoDir, ".git")))) {
      await git(["clone", await cloneUrl(), repoDir], ROOT);
    }

    // Fetch the specific commit; PR head commits are reachable even when the
    // branch has since moved on.
    await git(["fetch", "--force", "origin", `+${commitSha}:refs/copilot/${commitSha}`], repoDir)
      .catch(() => git(["fetch", "--force", "origin"], repoDir));

    await git(["checkout", "--force", commitSha], repoDir);
    await git(["clean", "-fdx", "--exclude=node_modules"], repoDir);

    const sourceDir = join(repoDir, config.sourcePath);
    if (!(await exists(sourceDir))) {
      throw new Error(
        `Source path "${config.sourcePath}" not found at ${commitSha.slice(0, 7)}. ` +
        `Set SOURCE_PATH if your metadata lives elsewhere.`,
      );
    }

    return { sourceDir, commitSha, repoDir };
  });
}

/**
 * HTTPS clone URL carrying a GitHub App installation token. Tokens are
 * short-lived, so the remote is rewritten on each clone rather than stored.
 */
async function cloneUrl(): Promise<string> {
  const { owner, repo } = config.git;
  const token = await installationToken();
  return token
    ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`;
}

async function installationToken(): Promise<string | null> {
  if (!config.git.appId || !config.git.privateKey) return null;
  const { gh } = await import("./git.js");
  const auth = await (gh() as unknown as {
    auth: (o: { type: string }) => Promise<{ token?: string }>;
  }).auth({ type: "installation" });
  return auth.token ?? null;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

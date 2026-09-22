import { config, type SfEnvironment } from "../config.js";
import { gh } from "./git.js";
import { DEMO_LOGS } from "../demoData.js";

export interface PipelineRun {
  id: string;
  name: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string | null;
  completedAt: string | null;
  logsUrl: string | null;
}

export interface TriggerArgs {
  featureId: string;
  branch: string;
  commitSha: string;
  source: SfEnvironment;
  target: SfEnvironment;
  requestedBy: string;
}

/**
 * The deployment mechanism lives behind this interface. Claude never speaks to
 * Salesforce metadata directly — it can only ask an adapter to start a pipeline
 * the organization already trusts.
 */
export interface CicdAdapter {
  readonly name: string;
  pipelineNameFor(source: SfEnvironment, target: SfEnvironment): string;
  isAvailable(source: SfEnvironment, target: SfEnvironment): Promise<boolean>;
  trigger(args: TriggerArgs): Promise<PipelineRun>;
  getRun(id: string): Promise<PipelineRun>;
  getLogs(id: string): Promise<string>;
}

// --------------------------------------------------------------------------
// GitHub Actions
// --------------------------------------------------------------------------

class GithubActionsAdapter implements CicdAdapter {
  readonly name = "github-actions";

  pipelineNameFor(source: SfEnvironment, target: SfEnvironment) {
    return `salesforce-${source.toLowerCase()}-to-${target.toLowerCase()}.yml`;
  }

  async isAvailable(source: SfEnvironment, target: SfEnvironment) {
    try {
      await gh().actions.getWorkflow({
        owner: config.git.owner,
        repo: config.git.repo,
        workflow_id: this.pipelineNameFor(source, target),
      });
      return true;
    } catch {
      return false;
    }
  }

  async trigger(args: TriggerArgs): Promise<PipelineRun> {
    const workflow = this.pipelineNameFor(args.source, args.target);
    // workflow_dispatch returns 204 with no body, so we correlate the run
    // afterwards by the feature_id input we passed in.
    await gh().actions.createWorkflowDispatch({
      owner: config.git.owner,
      repo: config.git.repo,
      workflow_id: workflow,
      ref: args.branch,
      inputs: {
        feature_id: args.featureId,
        commit_sha: args.commitSha,
        target_env: args.target,
        requested_by: args.requestedBy,
      },
    });

    const run = await this.findRecentRun(workflow, args.branch);
    return run ?? {
      id: "pending",
      name: workflow,
      status: "queued",
      startedAt: new Date().toISOString(),
      completedAt: null,
      logsUrl: null,
    };
  }

  private async findRecentRun(workflow: string, branch: string): Promise<PipelineRun | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const { data } = await gh().actions.listWorkflowRuns({
        owner: config.git.owner,
        repo: config.git.repo,
        workflow_id: workflow,
        branch,
        per_page: 1,
      });
      const run = data.workflow_runs[0];
      if (run && Date.now() - new Date(run.created_at).getTime() < 120_000) {
        return this.mapRun(run);
      }
    }
    return null;
  }

  private mapRun(r: {
    id: number; name?: string | null; status: string | null;
    conclusion: string | null; run_started_at?: string | null;
    updated_at: string; html_url: string;
  }): PipelineRun {
    let status: PipelineRun["status"] = "running";
    if (r.status === "queued" || r.status === "waiting") status = "queued";
    else if (r.status === "completed") {
      status = r.conclusion === "success" ? "succeeded"
        : r.conclusion === "cancelled" ? "cancelled" : "failed";
    }
    return {
      id: String(r.id),
      name: r.name ?? "workflow",
      status,
      startedAt: r.run_started_at ?? null,
      completedAt: r.status === "completed" ? r.updated_at : null,
      logsUrl: r.html_url,
    };
  }

  async getRun(id: string): Promise<PipelineRun> {
    const { data } = await gh().actions.getWorkflowRun({
      owner: config.git.owner, repo: config.git.repo, run_id: Number(id),
    });
    return this.mapRun(data);
  }

  async getLogs(id: string): Promise<string> {
    const { data } = await gh().actions.listJobsForWorkflowRun({
      owner: config.git.owner, repo: config.git.repo, run_id: Number(id),
    });
    // Full log archives are zipped; the step breakdown is what the RCA needs.
    return data.jobs
      .map((j) => {
        const steps = (j.steps ?? [])
          .map((s) => `    ${s.conclusion ?? s.status}  ${s.name}`)
          .join("\n");
        return `JOB ${j.name} [${j.conclusion ?? j.status}]\n${steps}`;
      })
      .join("\n\n");
  }
}

// --------------------------------------------------------------------------
// Jenkins
// --------------------------------------------------------------------------

class JenkinsAdapter implements CicdAdapter {
  readonly name = "jenkins";

  pipelineNameFor(source: SfEnvironment, target: SfEnvironment) {
    return `Salesforce-${source}-to-${target}`;
  }

  private auth() {
    const raw = `${config.cicd.jenkinsUser}:${config.cicd.jenkinsToken}`;
    return `Basic ${Buffer.from(raw).toString("base64")}`;
  }

  async isAvailable(source: SfEnvironment, target: SfEnvironment) {
    const job = this.pipelineNameFor(source, target);
    const res = await fetch(`${config.cicd.jenkinsBaseUrl}/job/${job}/api/json`, {
      headers: { Authorization: this.auth() },
    });
    return res.ok;
  }

  async trigger(args: TriggerArgs): Promise<PipelineRun> {
    const job = this.pipelineNameFor(args.source, args.target);
    const params = new URLSearchParams({
      FEATURE_ID: args.featureId,
      BRANCH: args.branch,
      COMMIT_SHA: args.commitSha,
      TARGET_ENV: args.target,
      REQUESTED_BY: args.requestedBy,
    });
    const res = await fetch(
      `${config.cicd.jenkinsBaseUrl}/job/${job}/buildWithParameters?${params}`,
      { method: "POST", headers: { Authorization: this.auth() } },
    );
    if (!res.ok) throw new Error(`Jenkins trigger failed: ${res.status} ${await res.text()}`);

    // Jenkins hands back a queue item; the build number appears once it leaves the queue.
    const queueUrl = res.headers.get("location");
    const buildId = queueUrl ? await this.resolveQueueItem(queueUrl) : "queued";
    return {
      id: buildId,
      name: job,
      status: "queued",
      startedAt: new Date().toISOString(),
      completedAt: null,
      logsUrl: `${config.cicd.jenkinsBaseUrl}/job/${job}/${buildId}/console`,
    };
  }

  private async resolveQueueItem(queueUrl: string): Promise<string> {
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const res = await fetch(`${queueUrl}api/json`, { headers: { Authorization: this.auth() } });
      if (!res.ok) continue;
      const body = (await res.json()) as { executable?: { number?: number } };
      if (body.executable?.number) return String(body.executable.number);
    }
    return "queued";
  }

  async getRun(id: string): Promise<PipelineRun> {
    // Job name is encoded into the id as "<job>#<number>" by the caller.
    const [job, number] = id.includes("#") ? id.split("#") : ["", id];
    const res = await fetch(
      `${config.cicd.jenkinsBaseUrl}/job/${job}/${number}/api/json`,
      { headers: { Authorization: this.auth() } },
    );
    const b = (await res.json()) as {
      building: boolean; result: string | null; timestamp: number; duration: number;
    };
    const status: PipelineRun["status"] = b.building
      ? "running"
      : b.result === "SUCCESS" ? "succeeded"
      : b.result === "ABORTED" ? "cancelled" : "failed";
    return {
      id,
      name: job ?? "jenkins",
      status,
      startedAt: new Date(b.timestamp).toISOString(),
      completedAt: b.building ? null : new Date(b.timestamp + b.duration).toISOString(),
      logsUrl: `${config.cicd.jenkinsBaseUrl}/job/${job}/${number}/console`,
    };
  }

  async getLogs(id: string): Promise<string> {
    const [job, number] = id.includes("#") ? id.split("#") : ["", id];
    const res = await fetch(
      `${config.cicd.jenkinsBaseUrl}/job/${job}/${number}/consoleText`,
      { headers: { Authorization: this.auth() } },
    );
    const text = await res.text();
    return text.slice(-40_000); // tail is where failures live
  }
}

// --------------------------------------------------------------------------
// Mock — lets the whole system run end to end before real CI/CD is wired up.
// --------------------------------------------------------------------------

class MockAdapter implements CicdAdapter {
  readonly name = "mock";
  private runs = new Map<string, PipelineRun & { logs: string }>();
  private seq = 1000;

  pipelineNameFor(source: SfEnvironment, target: SfEnvironment) {
    return `Salesforce-${source}-to-${target}`;
  }
  async isAvailable() { return true; }

  async trigger(args: TriggerArgs): Promise<PipelineRun> {
    const id = String(++this.seq);
    const run: PipelineRun & { logs: string } = {
      id,
      name: this.pipelineNameFor(args.source, args.target),
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      logsUrl: `https://mock.ci/runs/${id}`,
      logs: `[mock] deploying ${args.branch}@${args.commitSha.slice(0, 7)} to ${args.target}\n`,
    };
    this.runs.set(id, run);
    setTimeout(() => {
      run.status = "succeeded";
      run.completedAt = new Date().toISOString();
      run.logs += "[mock] validation passed\n[mock] deployment completed\n";
    }, 8000);
    return run;
  }

  async getRun(id: string): Promise<PipelineRun> {
    const r = this.runs.get(id);
    if (r) return r;
    if (DEMO_LOGS[id]) {
      const failed = DEMO_LOGS[id]!.includes("[failure]");
      return {
        id, name: "Salesforce-DEV-to-QA",
        status: failed ? "failed" : "succeeded",
        startedAt: "2026-09-19T16:10:00Z",
        completedAt: "2026-09-19T16:19:00Z",
        logsUrl: `https://github.com/saranrajv11/Moon-DevopsAgent/actions/runs/${id}`,
      };
    }
    throw new Error(`Unknown pipeline run: ${id}`);
  }
  async getLogs(id: string): Promise<string> {
    return this.runs.get(id)?.logs ?? DEMO_LOGS[id] ?? `No logs recorded for run ${id}.`;
  }

  async getRunOrDemo(id: string): Promise<PipelineRun | null> {
    return this.runs.get(id) ?? null;
  }
}

let adapter: CicdAdapter | null = null;

export function cicd(): CicdAdapter {
  if (adapter) return adapter;
  switch (config.cicd.provider) {
    case "github-actions": adapter = new GithubActionsAdapter(); break;
    case "jenkins": adapter = new JenkinsAdapter(); break;
    default: adapter = new MockAdapter();
  }
  return adapter;
}

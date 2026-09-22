import { Connection } from "jsforce";
import { config, type SfEnvironment } from "../config.js";
import * as cli from "./sfCli.js";
import { DEMO_STORIES, DEMO_DEPLOYMENTS } from "../demoData.js";

let cached: { conn: Connection; expires: number } | null = null;

/**
 * Server-to-server auth via the JWT bearer flow. No refresh token to rot,
 * no interactive login. The connected app is pre-authorized for one
 * dedicated integration user carrying the DevOps_Copilot_Integration perm set.
 */
export async function sfConnection(): Promise<Connection> {
  if (cached && cached.expires > Date.now()) return cached.conn;

  if (config.salesforce.cliOrgAlias) {
    throw new Error(
      "SF_CLI_ORG_ALIAS is set, so Salesforce access goes through the sf CLI. " +
      "This code path needs the JWT bearer flow — configure a Connected App, " +
      "or use the CLI-backed helpers instead.",
    );
  }

  const conn = new Connection({ loginUrl: config.salesforce.loginUrl });
  await conn.authorize({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: buildJwtAssertion(),
  } as never);

  cached = { conn, expires: Date.now() + 30 * 60 * 1000 };
  return conn;
}

function buildJwtAssertion(): string {
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const header = b64url(JSON.stringify({ alg: "RS256" }));
  const claims = b64url(
    JSON.stringify({
      iss: config.salesforce.clientId,
      sub: config.salesforce.username,
      aud: config.salesforce.loginUrl,
      exp: Math.floor(Date.now() / 1000) + 180,
    }),
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const sig = signer.sign(config.salesforce.privateKey, "base64");
  return `${header}.${claims}.${b64urlRaw(sig)}`;
}

const b64url = (s: string) => b64urlRaw(Buffer.from(s).toString("base64"));
const b64urlRaw = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------------------------------------------------------------------------
// Record shapes (only the fields the tools actually read)
// ---------------------------------------------------------------------------

export interface UserStoryRecord {
  Id: string;
  Name: string;
  Feature_ID__c: string;
  Feature_Branch__c: string;
  Title__c: string;
  Description__c: string | null;
  Status__c: string;
  Repository__c: string;
  Target_Environment__c: SfEnvironment | null;
  Current_Environment__c: SfEnvironment | null;
  Commit_Count__c: number | null;
  Latest_Commit_SHA__c: string | null;
  Latest_Commit_Message__c: string | null;
  PR_Number__c: number | null;
  PR_Status__c: string | null;
  PR_URL__c: string | null;
  Deployment_Status__c: string | null;
  Overall_DevOps_Status__c: string | null;
  Env_DEV_Status__c: string | null;
  Env_QA_Status__c: string | null;
  Env_PROD_Status__c: string | null;
}

const US_FIELDS = `Id, Name, Feature_ID__c, Feature_Branch__c, Title__c, Description__c,
  Status__c, Repository__c, Target_Environment__c, Current_Environment__c,
  Commit_Count__c, Latest_Commit_SHA__c, Latest_Commit_Message__c,
  PR_Number__c, PR_Status__c, PR_URL__c, Deployment_Status__c, Overall_DevOps_Status__c,
  Env_DEV_Status__c, Env_QA_Status__c, Env_PROD_Status__c`;

export async function getUserStoryByFeatureId(featureId: string): Promise<UserStoryRecord | null> {
  if (config.salesforce.cliOrgAlias) {
    const rows = await cli.query<UserStoryRecord>(
      config.salesforce.cliOrgAlias,
      `SELECT ${US_FIELDS} FROM DevOps_User_Story__c WHERE Feature_ID__c = '${cli.esc(featureId)}' LIMIT 1`,
    );
    return rows[0] ?? null;
  }
  if (config.demoMode) {
    return (DEMO_STORIES.find((s) => s.Feature_ID__c === featureId) as UserStoryRecord | undefined) ?? null;
  }
  const conn = await sfConnection();
  const r = await conn.query<UserStoryRecord>(
    `SELECT ${US_FIELDS} FROM DevOps_User_Story__c WHERE Feature_ID__c = '${esc(featureId)}' LIMIT 1`,
  );
  return r.records[0] ?? null;
}

/** Find the User Story that claims this Git branch. */
export async function getUserStoryByBranch(branch: string): Promise<UserStoryRecord | null> {
  if (config.salesforce.cliOrgAlias) {
    const rows = await cli.query<UserStoryRecord>(
      config.salesforce.cliOrgAlias,
      `SELECT ${US_FIELDS} FROM DevOps_User_Story__c WHERE Feature_Branch__c = '${cli.esc(branch)}' LIMIT 1`,
    );
    return rows[0] ?? null;
  }
  if (config.demoMode) {
    return (DEMO_STORIES.find((s) => s.Feature_Branch__c === branch) as UserStoryRecord | undefined) ?? null;
  }
  const conn = await sfConnection();
  const r = await conn.query<UserStoryRecord>(
    `SELECT ${US_FIELDS} FROM DevOps_User_Story__c WHERE Feature_Branch__c = '${esc(branch)}' LIMIT 1`,
  );
  return r.records[0] ?? null;
}

export async function getDeployments(userStoryId: string) {
  if (config.salesforce.cliOrgAlias) {
    return cli.query(
      config.salesforce.cliOrgAlias,
      `SELECT Id, Name, Environment__c, Status__c, Started_At__c, Completed_At__c,
              Commit_SHA__c, PR_Number__c, Error_Details__c, Deployment_URL__c
       FROM DevOps_Deployment__c WHERE User_Story__c = '${cli.esc(userStoryId)}'
       ORDER BY Started_At__c DESC LIMIT 50`,
    );
  }
  if (config.demoMode) {
    const story = DEMO_STORIES.find((s) => s.Id === userStoryId);
    return story ? (DEMO_DEPLOYMENTS[story.Feature_ID__c] ?? []) : [];
  }
  const conn = await sfConnection();
  const r = await conn.query(
    `SELECT Id, Name, Environment__c, Status__c, Started_At__c, Completed_At__c,
            Commit_SHA__c, PR_Number__c, Error_Details__c, Deployment_URL__c,
            Pipeline_Run__r.Name, Pipeline_Run__r.Logs_URL__c
     FROM DevOps_Deployment__c WHERE User_Story__c = '${esc(userStoryId)}'
     ORDER BY Started_At__c DESC LIMIT 50`,
  );
  return r.records;
}

export async function getApprovalForEnvironment(userStoryId: string, env: SfEnvironment) {
  if (config.salesforce.cliOrgAlias) {
    const rows = await cli.query<Record<string, unknown>>(
      config.salesforce.cliOrgAlias,
      `SELECT Id, Status__c, Approver__c, Approved_At__c, Expires_At__c, Commit_SHA__c
       FROM DevOps_Deployment_Approval__c
       WHERE User_Story__c = '${cli.esc(userStoryId)}' AND Target_Environment__c = '${cli.esc(env)}'
         AND Status__c = 'Approved'
       ORDER BY Approved_At__c DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }
  if (config.demoMode) return null;  // no PROD approvals exist in demo data
  const conn = await sfConnection();
  const r = await conn.query(
    `SELECT Id, Status__c, Approver__c, Approved_At__c, Expires_At__c, Commit_SHA__c
     FROM DevOps_Deployment_Approval__c
     WHERE User_Story__c = '${esc(userStoryId)}' AND Target_Environment__c = '${esc(env)}'
       AND Status__c = 'Approved'
     ORDER BY Approved_At__c DESC LIMIT 1`,
  );
  return r.records[0] ?? null;
}

/** Upsert by external id — safe to replay the same webhook twice. */
export async function upsertByExternalId(sobject: string, extIdField: string, records: object[]) {
  if (config.salesforce.cliOrgAlias) {
    await cli.upsert(config.salesforce.cliOrgAlias, sobject, extIdField,
      records as Array<Record<string, unknown>>);
    return [];
  }
  if (records.length === 0 || config.demoMode) return [];
  const conn = await sfConnection();
  return conn.sobject(sobject).upsert(records as never, extIdField);
}

export async function updateRecords(sobject: string, records: object[]) {
  if (config.salesforce.cliOrgAlias) {
    for (const r of records as Array<Record<string, unknown>>) {
      const { Id, ...rest } = r;
      if (typeof Id === "string") {
        await cli.update(config.salesforce.cliOrgAlias, sobject, Id, rest);
      }
    }
    return [];
  }
  if (records.length === 0 || config.demoMode) return [];
  const conn = await sfConnection();
  return conn.sobject(sobject).update(records as never);
}

export async function createRecord(sobject: string, record: object) {
  if (config.salesforce.cliOrgAlias) {
    const id = await cli.create(config.salesforce.cliOrgAlias, sobject,
      record as Record<string, unknown>);
    return { id: id ?? "", success: true };
  }
  if (config.demoMode) return { id: "demo", success: true };
  const conn = await sfConnection();
  return conn.sobject(sobject).create(record as never);
}

/** Minimal SOQL string escaping. All dynamic values must pass through this. */
export function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const run = promisify(execFile);

/**
 * Salesforce access via the `sf` CLI rather than a direct API client.
 *
 * Development shortcut: it reuses the authorization the user already granted
 * with `sf org login web`, so no Connected App, certificate or integration
 * user is needed. The CLI redacts tokens in its output and Salesforce refuses
 * to re-issue tokens minted for PlatformCLI, so borrowing the token directly
 * is not possible — shelling out is.
 *
 * Costs, which is why production should still use the JWT bearer flow:
 *  - one process spawn per query (tens of milliseconds, not microseconds)
 *  - runs as the logged-in human, not a least-privilege integration user
 *  - depends on the CLI staying installed and authorized on this machine
 */

export class SfCliError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "SfCliError";
  }
}

async function sf<T>(args: string[]): Promise<T> {
  let stdout: string;
  try {
    ({ stdout } = await run("sf", [...args, "--json"], {
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (e) {
    // The CLI exits non-zero on SOQL and DML errors but still prints JSON.
    const err = e as { stdout?: string; stderr?: string };
    stdout = err.stdout ?? "";
    if (!stdout.includes("{")) {
      throw new SfCliError("sf CLI failed", err.stderr ?? String(e));
    }
  }

  const start = stdout.indexOf("{");
  if (start < 0) throw new SfCliError("sf CLI returned no JSON", stdout.slice(0, 400));

  const body = JSON.parse(stdout.slice(start)) as {
    status?: number; result?: T; message?: string; name?: string;
  };
  if (body.status !== 0 && body.message) {
    throw new SfCliError(body.message, body.name);
  }
  return body.result as T;
}

/** Run a SOQL query and return the records. */
export async function query<T>(alias: string, soql: string): Promise<T[]> {
  const result = await sf<{ records?: T[] }>([
    "data", "query", "--target-org", alias, "--query", soql,
  ]);
  return result?.records ?? [];
}

/**
 * Insert records from a temporary CSV. Bulk import is used rather than
 * repeated `data create record` calls so a webhook carrying twenty commits is
 * one process spawn, not twenty.
 */
export async function insert(
  alias: string, sobject: string, rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  const dir = await mkdtemp(join(tmpdir(), "sfcli-"));
  try {
    const file = join(dir, "rows.csv");
    await writeFile(file, toCsv(rows), "utf8");
    await sf([
      "data", "import", "bulk",
      "--target-org", alias, "--sobject", sobject,
      "--file", file, "--wait", "10",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Update one record by Id. */
export async function update(
  alias: string, sobject: string, id: string, values: Record<string, unknown>,
): Promise<void> {
  const pairs = Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join(" ");
  if (!pairs) return;
  await sf([
    "data", "update", "record",
    "--target-org", alias, "--sobject", sobject,
    "--record-id", id, "--values", pairs,
  ]);
}

/** Create one record and return its Id. */
export async function create(
  alias: string, sobject: string, values: Record<string, unknown>,
): Promise<string | null> {
  const pairs = Object.entries(values)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join(" ");
  const result = await sf<{ id?: string }>([
    "data", "create", "record",
    "--target-org", alias, "--sobject", sobject, "--values", pairs,
  ]);
  return result?.id ?? null;
}

/**
 * Upsert by external id. The CLI has no single-record upsert, so this queries
 * for an existing row and branches — which keeps webhook replays idempotent.
 */
export async function upsert(
  alias: string, sobject: string, extIdField: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  for (const row of rows) {
    const key = row[extIdField];
    if (key === undefined || key === null) continue;
    const existing = await query<{ Id: string }>(
      alias,
      `SELECT Id FROM ${sobject} WHERE ${extIdField} = '${esc(String(key))}' LIMIT 1`,
    );
    if (existing[0]) {
      const { [extIdField]: _skip, ...rest } = row;
      await update(alias, sobject, existing[0].Id, rest);
    } else {
      await create(alias, sobject, row);
    }
  }
}

/** `--values` is space-separated, so any value containing spaces needs quoting. */
function quote(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => cell(r[c])).join(",")),
  ].join("\n") + "\n";
}

export function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

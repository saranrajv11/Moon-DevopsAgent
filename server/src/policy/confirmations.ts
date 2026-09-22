import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { config, type SfEnvironment } from "../config.js";
import type { Caller } from "./rbac.js";

// ---------------------------------------------------------------------------
// Confirmation tokens (Step 5)
// ---------------------------------------------------------------------------

/**
 * Validation ids from recent successful check-only deploys, keyed by
 * commit+target. A promotion confirmed within the window can Quick Deploy
 * instead of re-running the whole test suite.
 */
const VALIDATION_TTL_MS = 60 * 60 * 1000;
const validations = new Map<string, { id: string; at: number }>();

export function rememberValidation(commitSha: string, target: SfEnvironment, id: string): void {
  validations.set(`${commitSha}:${target}`, { id, at: Date.now() });
}

export function recallValidation(commitSha: string, target: SfEnvironment): string | null {
  const hit = validations.get(`${commitSha}:${target}`);
  if (!hit) return null;
  if (Date.now() - hit.at > VALIDATION_TTL_MS) {
    validations.delete(`${commitSha}:${target}`);
    return null;
  }
  return hit.id;
}

interface PendingDeployment {
  token: string;
  callerUserId: string;
  featureId: string;
  userStoryId: string;
  target: SfEnvironment;
  source: SfEnvironment;
  commitSha: string;
  prNumber: number | null;
  validationId: string | null;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
}

const pending = new Map<string, PendingDeployment>();

/**
 * A deployment request creates a token but changes nothing. Execution requires
 * presenting that token back. Because the token is minted only by the request
 * tool and bound to the caller, the confirmation step cannot be skipped by the
 * model deciding to skip it — there is simply no token to present.
 */
export function createConfirmation(args: Omit<PendingDeployment, "token" | "createdAt" | "expiresAt" | "consumed">): PendingDeployment {
  const now = Date.now();
  const entry: PendingDeployment = {
    ...args,
    token: `${randomUUID()}.${randomBytes(16).toString("hex")}`,
    createdAt: now,
    expiresAt: now + config.confirmationTtlSeconds * 1000,
    consumed: false,
  };
  pending.set(entry.token, entry);
  return entry;
}

export type ConsumeResult =
  | { ok: true; deployment: PendingDeployment }
  | { ok: false; reason: string };

export function consumeConfirmation(token: string, caller: Caller): ConsumeResult {
  const entry = findToken(token);
  if (!entry) return { ok: false, reason: "Unknown or already-used confirmation token." };
  if (entry.consumed) return { ok: false, reason: "This confirmation token has already been used." };
  if (Date.now() > entry.expiresAt) {
    pending.delete(entry.token);
    return { ok: false, reason: "Confirmation expired. Re-run the deployment request." };
  }
  if (entry.callerUserId !== caller.userId) {
    return { ok: false, reason: "Confirmation token belongs to a different user." };
  }
  entry.consumed = true;
  pending.delete(entry.token);
  return { ok: true, deployment: entry };
}

/** Constant-time lookup so a token cannot be discovered by timing the compare. */
function findToken(token: string): PendingDeployment | undefined {
  const probe = Buffer.from(token);
  for (const [key, value] of pending) {
    const candidate = Buffer.from(key);
    if (candidate.length === probe.length && timingSafeEqual(candidate, probe)) return value;
  }
  return undefined;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (now > v.expiresAt) pending.delete(k);
}, 60_000).unref();

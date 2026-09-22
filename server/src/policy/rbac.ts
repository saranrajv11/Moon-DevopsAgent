import type { SfEnvironment } from "../config.js";

export type Role = "viewer" | "developer" | "release_manager" | "admin";

export interface Caller {
  /** Salesforce User Id of the human in the chat — never the integration user. */
  userId: string;
  username: string;
  displayName: string;
  roles: Role[];
  sessionId: string;
}

/**
 * Who may deploy where. Read access is universal; write access narrows as the
 * environment gets closer to production. PROD is intentionally absent for
 * everyone — it additionally requires an approval record (see gates.ts), so no
 * role alone can push to production.
 */
const DEPLOY_MATRIX: Record<Role, SfEnvironment[]> = {
  viewer: [],
  developer: ["DEV", "QA"],
  release_manager: ["DEV", "QA", "PROD"],
  admin: ["DEV", "QA", "PROD"],
};

export function canDeployTo(caller: Caller, env: SfEnvironment): boolean {
  return caller.roles.some((r) => DEPLOY_MATRIX[r]?.includes(env));
}

export function canApprove(caller: Caller): boolean {
  return caller.roles.some((r) => r === "release_manager" || r === "admin");
}

export class AccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDenied";
  }
}

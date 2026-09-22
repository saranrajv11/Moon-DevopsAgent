import { createRecord } from "../connectors/salesforce.js";
import type { Caller } from "./rbac.js";
import type { SfEnvironment } from "../config.js";

export type ActionType = "Read" | "Validate" | "Deployment Request" | "Deployment Execute" | "Denied";

export interface AuditEntry {
  caller: Caller;
  action: string;
  actionType: ActionType;
  args: unknown;
  result: "Success" | "Failure" | "Denied";
  detail?: string;
  userStoryId?: string;
  targetEnvironment?: SfEnvironment;
}

/**
 * Every tool invocation lands here. Writes are best-effort: an audit failure
 * must not silently swallow the action's own error, but it must be loud.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await createRecord("DevOps_Audit_Log__c", {
      Actor_User__c: entry.caller.userId,
      Actor_Identifier__c: entry.caller.username,
      Action__c: entry.action,
      Action_Type__c: entry.actionType,
      Tool_Arguments__c: JSON.stringify(entry.args ?? {}).slice(0, 32000),
      Result__c: entry.result,
      Result_Detail__c: entry.detail?.slice(0, 32000) ?? null,
      Session_Id__c: entry.caller.sessionId,
      Occurred_At__c: new Date().toISOString(),
      User_Story__c: entry.userStoryId ?? null,
      Target_Environment__c: entry.targetEnvironment ?? null,
    });
  } catch (e) {
    console.error("[audit] FAILED TO WRITE AUDIT RECORD", { entry, error: e });
  }
}

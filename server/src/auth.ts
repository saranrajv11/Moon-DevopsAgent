import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { sfConnection } from "./connectors/salesforce.js";
import { timingSafeEqual } from "node:crypto";
import type { Caller, Role } from "./policy/rbac.js";

declare global {
  namespace Express {
    interface Request { caller?: Caller }
  }
}

/**
 * Identity comes from the caller's own Salesforce session, not the integration
 * user. RBAC decisions are made against the human; the integration user only
 * supplies the connection.
 *
 * Two supported modes:
 *  - Authorization: Bearer <salesforce access token>  (standalone web app)
 *  - X-SF-Session-Id + X-SF-Instance-Url              (LWC calling out)
 *
 * DEV_IMPERSONATE is a local-only escape hatch and refuses to run in production.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const impersonate = process.env.DEV_IMPERSONATE;
  if (impersonate) {
    if (process.env.NODE_ENV === "production") {
      return res.status(500).json({ error: "DEV_IMPERSONATE must not be set in production" });
    }
    const [userId, username, ...roles] = impersonate.split(":");
    req.caller = {
      userId: userId!, username: username!, displayName: username!,
      roles: (roles.length ? roles : ["developer"]) as Role[],
      sessionId: req.header("x-session-id") ?? "dev-session",
    };
    return next();
  }

  // Apex callout path: the Named Credential presents a shared secret, and the
  // controller passes the running user's identity in headers. The secret is what
  // makes those headers trustworthy — without it anyone could claim any user id.
  const apexSecret = req.header("x-copilot-secret");
  if (apexSecret) {
    const expected = process.env.APEX_SHARED_SECRET ?? "";
    if (!expected || !safeEqual(apexSecret, expected)) {
      return res.status(401).json({ error: "Invalid copilot secret" });
    }
    const userId = req.header("x-sf-user-id");
    const username = req.header("x-sf-username");
    if (!userId || !username) {
      return res.status(400).json({ error: "Missing X-SF-User-Id or X-SF-Username" });
    }
    try {
      req.caller = {
        userId,
        username,
        displayName: username,
        roles: await rolesForUser(userId),
        sessionId: req.header("x-session-id") ?? userId,
      };
      return next();
    } catch (e) {
      return res.status(401).json({ error: `Could not resolve roles: ${e instanceof Error ? e.message : e}` });
    }
  }

  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "")
    ?? req.header("x-sf-session-id");
  if (!token) return res.status(401).json({ error: "Missing Salesforce credentials" });

  try {
    req.caller = await resolveCaller(token, req.header("x-sf-instance-url"), req.header("x-session-id"));
    next();
  } catch (e) {
    res.status(401).json({ error: `Authentication failed: ${e instanceof Error ? e.message : e}` });
  }
}

async function resolveCaller(
  accessToken: string, instanceUrl: string | undefined, sessionId: string | undefined,
): Promise<Caller> {
  const jsforce = (await import("jsforce")).default;
  const conn = new jsforce.Connection({
    accessToken,
    instanceUrl: instanceUrl ?? (await sfConnection()).instanceUrl,
  });

  const identity = await conn.identity();
  const roles = await rolesForUser(identity.user_id);

  return {
    userId: identity.user_id,
    username: identity.username,
    displayName: identity.display_name,
    roles,
    sessionId: sessionId ?? identity.user_id,
  };
}

/**
 * Roles are derived from permission set assignments so that access is managed
 * in Salesforce with everything else — not in a config file here.
 */
async function rolesForUser(userId: string): Promise<Role[]> {
  // Demo mode has no org to query; everyone is a developer, so PROD
  // still refuse them and the RBAC gate stays observable.
  if (config.demoMode) return ["developer"];
  const conn = await sfConnection();
  const { records } = await conn.query<{ PermissionSet: { Name: string } }>(
    `SELECT PermissionSet.Name FROM PermissionSetAssignment
     WHERE AssigneeId = '${userId.replace(/'/g, "")}'`,
  );
  const names = new Set(records.map((r: { PermissionSet: { Name: string } }) => r.PermissionSet?.Name));

  const roles: Role[] = [];
  if (names.has("DevOps_Copilot_Reader")) roles.push("viewer");
  if (names.has("DevOps_Copilot_Developer")) roles.push("developer");
  if (names.has("DevOps_Copilot_Release_Manager")) roles.push("release_manager");
  if (names.has("DevOps_Copilot_Admin")) roles.push("admin");
  return roles.length ? roles : ["viewer"];
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

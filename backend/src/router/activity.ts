// Aktivitätslogs für eingeloggte User – gefiltert nach Workspace.
// (Der globale, ungefilterte Zugriff bleibt im Admin-Panel unter /admin/activity-logs.)

import { Hono } from "hono";
import { authMiddleware } from "../middleware/auth.ts";
import { assertWorkspaceAccess } from "../middleware/workspace-access.ts";
import * as activityLogService from "../service/activity-log.ts";

const activityRouter = new Hono();
activityRouter.use("*", authMiddleware);

// Aktivitätslogs eines Workspace abrufen (für die Log-Leiste im Frontend).
// workspace_id ist Pflicht, damit User nur Logs ihres Kontexts sehen.
activityRouter.get("/", async (c) => {
  const workspace_id = c.req.query("workspace_id");
  if (!workspace_id) {
    return c.json({ error: "workspace_id is required" }, 400);
  }
  await assertWorkspaceAccess(c.get("user"), workspace_id, "read");

  const action = c.req.query("action");
  const status = c.req.query("status");
  const document_id = c.req.query("document_id");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);
  const offset = parseInt(c.req.query("offset") || "0");

  const result = await activityLogService.getLogs({
    action,
    status,
    workspace_id,
    document_id,
    limit,
    offset,
  });
  return c.json(result);
});

export { activityRouter };

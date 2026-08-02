// Aktivitätslogs für eingeloggte User – gefiltert nach Wiki.
// (Der globale, ungefilterte Zugriff bleibt im Admin-Panel unter /admin/activity-logs.)

import { Hono } from "hono";
import { sessionMiddleware } from "../middleware/auth.ts";
import { requireWikiCapability } from "../middleware/access.ts";
import * as activityLogService from "../service/activity-log.ts";

const activityRouter = new Hono();
activityRouter.use("*", sessionMiddleware);

// Aktivitätslogs eines Wiki abrufen (für die Log-Leiste im Frontend).
// wiki_id ist Pflicht, damit User nur Logs ihres Kontexts sehen.
activityRouter.get("/", async (c) => {
  const wiki_id = c.req.query("wiki_id");
  if (!wiki_id) {
    return c.json({ error: "wiki_id is required" }, 400);
  }
  await requireWikiCapability(c.get("principal"), wiki_id, "wiki.read");

  const action = c.req.query("action");
  const status = c.req.query("status");
  const document_id = c.req.query("document_id");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);
  const offset = parseInt(c.req.query("offset") || "0");

  const result = await activityLogService.getLogs({
    action,
    status,
    wiki_id,
    document_id,
    limit,
    offset,
  });
  return c.json(result);
});

export { activityRouter };

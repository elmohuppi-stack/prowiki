import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { authMiddleware } from "../middleware/auth.ts";
import { workspaceParamAccess } from "../middleware/workspace-access.ts";
import * as topicService from "../service/topic.ts";

const topicRouter = new Hono();
topicRouter.use("*", authMiddleware);
// Alle Themen-Routen sind workspace-gebunden – GET = lesen, sonst schreiben.
topicRouter.use("/:workspaceId", workspaceParamAccess());
topicRouter.use("/:workspaceId/*", workspaceParamAccess());

const createSchema = z.object({
  label: z.string().min(1).max(255),
  description: z.string().optional(),
  color: z.string().max(20).optional(),
  sort_order: z.number().optional(),
});

const updateSchema = z.object({
  label: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  color: z.string().max(20).nullable().optional(),
  sort_order: z.number().optional(),
});

const bulkSchema = z.object({
  topics: z.array(
    z.object({
      label: z.string().min(1).max(255),
      description: z.string().optional(),
      color: z.string().max(20).optional(),
    }),
  ),
});

// Themen eines Workspace auflisten (mit doc_count)
topicRouter.get("/:workspaceId", async (c) => {
  const list = await topicService.listTopics(c.req.param("workspaceId"));
  return c.json({ topics: list });
});

// LLM-Vorschläge (nicht persistiert)
topicRouter.post("/:workspaceId/suggest", async (c) => {
  try {
    const suggestions = await topicService.suggestTopics(
      c.req.param("workspaceId"),
    );
    return c.json({ suggestions });
  } catch (e: any) {
    return c.json({ error: e.message || "Vorschläge fehlgeschlagen" }, 500);
  }
});

// Mehrere Themen auf einmal anlegen (Vorschläge übernehmen)
topicRouter.post(
  "/:workspaceId/bulk",
  zValidator("json", bulkSchema),
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const { topics } = c.req.valid("json");
    const created = [];
    for (const t of topics) {
      created.push(await topicService.createTopic(workspaceId, t));
    }
    return c.json({ topics: created }, 201);
  },
);

// Einzelnes Thema anlegen
topicRouter.post(
  "/:workspaceId",
  zValidator("json", createSchema),
  async (c) => {
    const topic = await topicService.createTopic(
      c.req.param("workspaceId"),
      c.req.valid("json"),
    );
    return c.json({ topic }, 201);
  },
);

// Thema bearbeiten
topicRouter.patch(
  "/:workspaceId/:topicId",
  zValidator("json", updateSchema),
  async (c) => {
    const topic = await topicService.updateTopic(
      c.req.param("topicId"),
      c.req.valid("json") as any,
    );
    if (!topic) return c.json({ error: "Topic not found" }, 404);
    return c.json({ topic });
  },
);

// Thema löschen (inkl. Zuordnungen)
topicRouter.delete("/:workspaceId/:topicId", async (c) => {
  await topicService.deleteTopic(c.req.param("topicId"));
  return c.json({ success: true });
});

export { topicRouter };

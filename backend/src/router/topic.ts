import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { sessionMiddleware } from "../middleware/auth.ts";
import { wikiParamAccess } from "../middleware/access.ts";
import * as topicService from "../service/topic.ts";

const topicRouter = new Hono();
topicRouter.use("*", sessionMiddleware);
// Alle Themen-Routen sind wiki-gebunden – GET = lesen, sonst schreiben.
topicRouter.use("/:wikiId", wikiParamAccess());
topicRouter.use("/:wikiId/*", wikiParamAccess());

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

// Themen eines Wiki auflisten (mit doc_count)
topicRouter.get("/:wikiId", async (c) => {
  const list = await topicService.listTopics(c.req.param("wikiId"));
  return c.json({ topics: list });
});

// LLM-Vorschläge (nicht persistiert)
topicRouter.post("/:wikiId/suggest", async (c) => {
  try {
    const suggestions = await topicService.suggestTopics(
      c.req.param("wikiId"),
    );
    return c.json({ suggestions });
  } catch (e: any) {
    return c.json({ error: e.message || "Vorschläge fehlgeschlagen" }, 500);
  }
});

// Mehrere Themen auf einmal anlegen (Vorschläge übernehmen)
topicRouter.post(
  "/:wikiId/bulk",
  zValidator("json", bulkSchema),
  async (c) => {
    const wikiId = c.req.param("wikiId");
    const { topics } = c.req.valid("json");
    const created = [];
    for (const t of topics) {
      created.push(await topicService.createTopic(wikiId, t));
    }
    return c.json({ topics: created }, 201);
  },
);

// Einzelnes Thema anlegen
topicRouter.post(
  "/:wikiId",
  zValidator("json", createSchema),
  async (c) => {
    const topic = await topicService.createTopic(
      c.req.param("wikiId"),
      c.req.valid("json"),
    );
    return c.json({ topic }, 201);
  },
);

// Thema bearbeiten
topicRouter.patch(
  "/:wikiId/:topicId",
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
topicRouter.delete("/:wikiId/:topicId", async (c) => {
  await topicService.deleteTopic(c.req.param("topicId"));
  return c.json({ success: true });
});

export { topicRouter };

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { sessionMiddleware } from "../middleware/auth.ts";
import { requireWikiCapability } from "../middleware/access.ts";
import { hybridSearch } from "../service/search.ts";

const searchRouter = new Hono();
searchRouter.use("*", sessionMiddleware);

const searchSchema = z.object({
  wiki_id: z.string().uuid(),
  query: z.string().min(1),
  top_k: z.number().min(1).max(50).default(10),
});

searchRouter.post("/", zValidator("json", searchSchema), async (c) => {
  const { wiki_id, query, top_k } = c.req.valid("json");
  await requireWikiCapability(c.get("principal"), wiki_id, "wiki.read");

  const results = await hybridSearch(wiki_id, query, top_k);

  return c.json({
    query,
    results,
    total: results.length,
  });
});

export { searchRouter };

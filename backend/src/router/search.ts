import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { authMiddleware } from "../middleware/auth.ts";
import { assertWorkspaceAccess } from "../middleware/workspace-access.ts";
import { hybridSearch } from "../service/search.ts";

const searchRouter = new Hono();
searchRouter.use("*", authMiddleware);

const searchSchema = z.object({
  workspace_id: z.string().uuid(),
  query: z.string().min(1),
  top_k: z.number().min(1).max(50).default(10),
});

searchRouter.post("/", zValidator("json", searchSchema), async (c) => {
  const { workspace_id, query, top_k } = c.req.valid("json");
  await assertWorkspaceAccess(c.get("user"), workspace_id, "read");

  const results = await hybridSearch(workspace_id, query, top_k);

  return c.json({
    query,
    results,
    total: results.length,
  });
});

export { searchRouter };

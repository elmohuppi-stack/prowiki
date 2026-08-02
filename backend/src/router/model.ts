import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { authMiddleware, requireRole } from "../middleware/auth.ts";
import * as modelService from "../service/model.ts";

const modelRouter = new Hono();
modelRouter.use("*", authMiddleware, requireRole("admin"));

const createSchema = z.object({
  name: z.string().min(1).max(255),
  provider_type: z.enum(["chat", "embedding", "both"]),
  api_base_url: z.string().max(512),
  api_key: z.string().min(1),
  default_model: z.string().min(1).max(255),
  is_active: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  provider_type: z.enum(["chat", "embedding", "both"]).optional(),
  api_base_url: z.string().max(512).optional(),
  api_key: z.string().min(1).optional(),
  default_model: z.string().min(1).max(255).optional(),
  is_active: z.boolean().optional(),
});

// Liste aller Provider
modelRouter.get("/", async (c) => {
  const list = await modelService.listProviders();
  return c.json({ providers: list });
});

// Provider erstellen
modelRouter.post("/", zValidator("json", createSchema), async (c) => {
  const data = c.req.valid("json");
  const provider = await modelService.createProvider(data);
  return c.json({ provider }, 201);
});

// Provider aktualisieren
modelRouter.put("/:id", zValidator("json", updateSchema), async (c) => {
  const id = c.req.param("id");
  const data = c.req.valid("json");
  const provider = await modelService.updateProvider(id, data);
  if (!provider) return c.json({ error: "Provider not found" }, 404);
  return c.json({ provider });
});

// Provider löschen
modelRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await modelService.deleteProvider(id);
  return c.json({ success: true });
});

export { modelRouter };

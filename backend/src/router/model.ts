/**
 * Modell-Provider je Organisation.
 *
 * In knora war das eine globale Liste hinter `requireRole("admin")`. Das geht
 * bei einem Mandanten nicht mehr: `model_providers.organization_id` trennt die
 * Schlüssel der Kunden, und ein Kunde soll seinen eigenen LLM-Schlüssel
 * hinterlegen können ("bring your own key", KONZEPT 5.4).
 *
 * Die Organisation steht deshalb im Pfad statt implizit in einer globalen
 * Rolle: /api/v1/orgs/:orgId/models
 */
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireOrgCapability } from "../middleware/access.ts";
import * as modelService from "../service/model.ts";

const modelRouter = new Hono();

const createSchema = z.object({
  name: z.string().min(1).max(255),
  provider_type: z.enum(["chat", "embedding", "both"]),
  api_base_url: z.string().max(512),
  api_key: z.string().min(1),
  default_model: z.string().min(1).max(255),
  is_active: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

modelRouter.get("/:orgId/models", async (c) => {
  const orgId = c.req.param("orgId");
  await requireOrgCapability(c.get("principal"), orgId, "settings.manage");
  return c.json({ providers: await modelService.listProviders(orgId) });
});

modelRouter.post(
  "/:orgId/models",
  zValidator("json", createSchema),
  async (c) => {
    const orgId = c.req.param("orgId");
    await requireOrgCapability(c.get("principal"), orgId, "settings.manage");
    const provider = await modelService.createProvider(orgId, c.req.valid("json"));
    return c.json({ provider }, 201);
  },
);

modelRouter.put(
  "/:orgId/models/:id",
  zValidator("json", updateSchema),
  async (c) => {
    const orgId = c.req.param("orgId");
    await requireOrgCapability(c.get("principal"), orgId, "settings.manage");
    // orgId wird mitgegeben, damit ein fremder Provider nicht über eine
    // erratene ID geändert werden kann — die Capability allein sagt nur, dass
    // der Aufrufer *in dieser* Organisation Einstellungen verwalten darf.
    const provider = await modelService.updateProvider(
      orgId,
      c.req.param("id"),
      c.req.valid("json"),
    );
    if (!provider) return c.json({ error: "Provider nicht gefunden" }, 404);
    return c.json({ provider });
  },
);

modelRouter.delete("/:orgId/models/:id", async (c) => {
  const orgId = c.req.param("orgId");
  await requireOrgCapability(c.get("principal"), orgId, "settings.manage");
  const deleted = await modelService.deleteProvider(orgId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Provider nicht gefunden" }, 404);
  return c.json({ success: true });
});

export { modelRouter };

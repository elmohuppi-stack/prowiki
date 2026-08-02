import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { authMiddleware } from "../middleware/auth.ts";
import {
  assertWorkspaceAccess,
  assertCanCreateWorkspace,
} from "../middleware/workspace-access.ts";
import * as workspaceService from "../service/workspace.ts";

const workspaceRouter = new Hono();
workspaceRouter.use("*", authMiddleware);

const createSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  chunk_size: z.number().min(128).max(4096).optional(),
  chunk_overlap: z.number().min(0).max(512).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  chunk_size: z.number().min(128).max(4096).optional(),
  chunk_overlap: z.number().min(0).max(512).optional(),
  // Wiki-Tiefe pro Workspace: steuert Kosten/Detailtiefe der Wiki-Generierung.
  wiki_depth: z.enum(["full", "capped", "summary", "off"]).optional(),
});

const memberSchema = z.object({
  user_id: z.number(),
  role: z.enum(["owner", "editor", "viewer"]).default("viewer"),
});

const ownerSchema = z.object({
  user_id: z.number(),
});

// Liste aller Workspaces für den aktuellen User
workspaceRouter.get("/", async (c) => {
  const user = c.get("user");
  const list = await workspaceService.listWorkspaces(user);
  return c.json({ workspaces: list });
});

// Workspace per Slug finden
workspaceRouter.get("/by-slug/:slug", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const ws = await workspaceService.getWorkspaceBySlug(slug);
  if (!ws) return c.json({ error: "Workspace not found" }, 404);
  await assertWorkspaceAccess(user, ws.id, "read");
  return c.json({ workspace: ws });
});

// Einzelnen Workspace abrufen
workspaceRouter.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await assertWorkspaceAccess(user, id, "read");
  const ws = await workspaceService.getWorkspace(id);
  if (!ws) return c.json({ error: "Workspace not found" }, 404);
  return c.json({ workspace: ws });
});

// Workspace erstellen
workspaceRouter.post("/", zValidator("json", createSchema), async (c) => {
  const user = c.get("user");
  assertCanCreateWorkspace(user);
  const data = c.req.valid("json");
  const ws = await workspaceService.createWorkspace({
    ...data,
    created_by: user.id,
  });
  return c.json({ workspace: ws }, 201);
});

// Workspace aktualisieren
workspaceRouter.put("/:id", zValidator("json", updateSchema), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await assertWorkspaceAccess(user, id, "write");
  const data = c.req.valid("json");
  const ws = await workspaceService.updateWorkspace(id, data);
  if (!ws) return c.json({ error: "Workspace not found" }, 404);
  return c.json({ workspace: ws });
});

// Besitzer wechseln – nur globale Admins. Der bisherige Besitzer bleibt als
// editor-Mitglied erhalten (siehe transferOwnership).
workspaceRouter.put(
  "/:id/owner",
  zValidator("json", ownerSchema),
  async (c) => {
    const user = c.get("user");
    if (user.role !== "admin") {
      return c.json({ error: "Nur Admins dürfen den Besitzer wechseln" }, 403);
    }
    const id = c.req.param("id");
    const { user_id } = c.req.valid("json");
    const ws = await workspaceService.transferOwnership(id, user_id);
    if (!ws) return c.json({ error: "Workspace not found" }, 404);
    return c.json({ workspace: ws });
  },
);

// Workspace löschen – nur Besitzer (oder globaler Admin)
workspaceRouter.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const role = await assertWorkspaceAccess(user, id, "write");
  if (role !== "owner") {
    return c.json(
      { error: "Nur der Besitzer kann den Workspace löschen" },
      403,
    );
  }
  try {
    await workspaceService.deleteWorkspace(id);
    return c.json({ success: true });
  } catch (e: any) {
    console.error("[workspace] Löschen fehlgeschlagen:", e);
    return c.json(
      { error: "Workspace konnte nicht gelöscht werden", detail: e.message },
      500,
    );
  }
});

// Mitglieder auflisten
workspaceRouter.get("/:id/members", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await assertWorkspaceAccess(user, id, "read");
  const members = await workspaceService.listMembers(id);
  return c.json({ members });
});

// Mitglied hinzufügen – nur der Besitzer (oder globaler Admin)
workspaceRouter.post(
  "/:id/members",
  zValidator("json", memberSchema),
  async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const role = await assertWorkspaceAccess(user, id, "write");
    if (role !== "owner") {
      return c.json(
        { error: "Nur der Besitzer kann Mitglieder verwalten" },
        403,
      );
    }
    const { user_id, role: memberRole } = c.req.valid("json");
    const member = await workspaceService.addMember(id, user_id, memberRole);
    return c.json({ member }, 201);
  },
);

// Mitglied entfernen – nur der Besitzer (oder globaler Admin)
workspaceRouter.delete("/:id/members/:userId", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const role = await assertWorkspaceAccess(user, id, "write");
  if (role !== "owner") {
    return c.json({ error: "Nur der Besitzer kann Mitglieder verwalten" }, 403);
  }
  const userId = parseInt(c.req.param("userId"));
  try {
    await workspaceService.removeMember(id, userId);
    return c.json({ success: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

export { workspaceRouter };

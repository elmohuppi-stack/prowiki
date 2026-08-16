/**
 * Wikis: anlegen, ändern, löschen, Mitglieder-Overrides.
 *
 * Gegenüber knora fällt hier jede Rollenabfrage im Router weg. Dort standen
 * Zeilen wie `if (user.role !== "admin")` und `if (role !== "owner")` verstreut
 * in den Handlern — jede eine eigene, leicht abweichende Rechteentscheidung.
 * Hier prüft jeder Handler genau eine Capability, aufgelöst in
 * middleware/access.ts.
 */
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireUser } from "../middleware/auth.ts";
import {
  requireWikiCapability,
  requireOrgCapability,
} from "../middleware/access.ts";
import { ROLE_NAMES, type RoleName } from "../auth/permissions.ts";
import { WIKI_VISIBILITIES } from "../db/schema.ts";
import * as wikiService from "../service/wikis.ts";

const wikisRouter = new Hono();

const createSchema = z.object({
  organization_id: z.string().min(1),
  name: z.string().min(1).max(255),
  slug: z.string().max(255).optional(),
  description: z.string().optional(),
  chunk_size: z.number().min(128).max(4096).optional(),
  chunk_overlap: z.number().min(0).max(512).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  visibility: z.enum(WIKI_VISIBILITIES).optional(),
  anonymous_chat_enabled: z.boolean().optional(),
  custom_domain: z.string().max(255).nullable().optional(),
  chunk_size: z.number().min(128).max(4096).optional(),
  chunk_overlap: z.number().min(0).max(512).optional(),
  wiki_depth: z.enum(["full", "capped", "summary", "off"]).optional(),
});

const memberSchema = z.object({
  // String statt Zahl: Better Auth vergibt Text-IDs.
  user_id: z.string().min(1),
  role: z.enum(ROLE_NAMES as [RoleName, ...RoleName[]]).default("viewer"),
});

/** Eigene Wikis. Ohne Anmeldung leer statt 401 — die Liste ist kein Geheimnis. */
wikisRouter.get("/", async (c) => {
  const list = await wikiService.listWikis(c.get("principal"));
  return c.json({ wikis: list });
});

/**
 * Auflösung eines Wiki-Slugs. Die Oberfläche adressiert Wikis lesbar
 * (`/wikis/politik`) und braucht daraus die UUID für alle weiteren Aufrufe.
 *
 * Slugs sind nur *je Organisation* eindeutig (`wikis_org_slug_unique`) — ohne
 * Org im Pfad ist die Auflösung deshalb an den Nutzer gebunden: gesucht wird
 * unter den Wikis, die er ohnehin sehen darf. Ist der Slug dort mehrfach
 * vergeben (zwei Organisationen, beide mit "archiv"), ist die Anfrage
 * mehrdeutig und wird als solche beantwortet, statt eine Organisation zu raten.
 *
 * Öffentliche Wikis Fremder sind hierüber nicht erreichbar; die bekommen mit
 * der Lese-Seite in Stufe 2 den Adressraum /<org>/<wiki>.
 *
 * Muss vor "/:id" stehen? Nein — zwei Pfadsegmente kollidieren nicht mit einem.
 */
wikisRouter.get("/by-slug/:slug", async (c) => {
  const slug = c.req.param("slug");
  const principal = c.get("principal");

  // Bewusst über listWikis statt über eine eigene Abfrage: die Sichtbarkeits-
  // und Rollenauflösung soll an genau einer Stelle stehen.
  const treffer = (await wikiService.listWikis(principal)).filter(
    (w) => w.slug === slug,
  );

  if (treffer.length === 0) {
    return c.json({ error: "Wiki nicht gefunden" }, 404);
  }
  if (treffer.length > 1) {
    return c.json(
      {
        error: `Slug "${slug}" ist in mehreren Organisationen vergeben`,
        candidates: treffer.map((w) => ({
          id: w.id,
          organization_id: w.organization_id,
        })),
      },
      409,
    );
  }

  return c.json({ wiki: treffer[0] });
});

wikisRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  // Die Capability-Prüfung deckt auch anonymen Zugriff auf öffentliche Wikis ab
  // und wirft 404, wenn nichts sichtbar ist.
  await requireWikiCapability(c.get("principal"), id, "wiki.read");
  const wiki = await wikiService.getWiki(id);
  if (!wiki) return c.json({ error: "Wiki nicht gefunden" }, 404);
  return c.json({ wiki });
});

wikisRouter.post(
  "/",
  requireUser,
  zValidator("json", createSchema),
  async (c) => {
    const principal = c.get("principal");
    const { organization_id, ...data } = c.req.valid("json");
    // Ein Wiki entsteht *in* einer Organisation — geprüft wird deshalb dort.
    await requireOrgCapability(principal, organization_id, "wiki.create");
    const wiki = await wikiService.createWiki({
      organizationId: organization_id,
      createdBy: principal.userId!,
      ...data,
    });
    return c.json({ wiki }, 201);
  },
);

wikisRouter.put(
  "/:id",
  requireUser,
  zValidator("json", updateSchema),
  async (c) => {
    const id = c.req.param("id");
    const data = c.req.valid("json");
    const principal = c.get("principal");

    await requireWikiCapability(principal, id, "wiki.write");

    // Sichtbarkeit, anonymer Chat und Kundendomäne sind keine gewöhnlichen
    // Einstellungen: das eine stellt Inhalte ins offene Netz, das andere
    // verursacht Kosten pro Frage, das dritte bindet eine fremde Domain an.
    // Alle drei verlangen zusätzlich settings.manage in der Organisation.
    if (
      data.visibility !== undefined ||
      data.custom_domain !== undefined ||
      data.anonymous_chat_enabled !== undefined
    ) {
      const existing = await wikiService.getWiki(id);
      if (!existing) return c.json({ error: "Wiki nicht gefunden" }, 404);
      await requireOrgCapability(
        principal,
        existing.organization_id,
        "settings.manage",
      );
    }

    const wiki = await wikiService.updateWiki(id, data);
    if (!wiki) return c.json({ error: "Wiki nicht gefunden" }, 404);
    return c.json({ wiki });
  },
);

wikisRouter.delete("/:id", requireUser, async (c) => {
  const id = c.req.param("id");
  await requireWikiCapability(c.get("principal"), id, "wiki.delete");
  await wikiService.deleteWiki(id);
  return c.json({ success: true });
});

// --- Wiki-Overrides ---------------------------------------------------------
//
// Nicht zu verwechseln mit der Organisationsmitgliedschaft: die verwaltet
// Better Auth über Einladungen (/api/auth/organization/*). Hier wird nur die
// Rolle für ein *einzelnes* Wiki abweichend gesetzt.

wikisRouter.get("/:id/members", async (c) => {
  const id = c.req.param("id");
  await requireWikiCapability(c.get("principal"), id, "wiki.read");
  return c.json({ members: await wikiService.listMembers(id) });
});

wikisRouter.put(
  "/:id/members",
  requireUser,
  zValidator("json", memberSchema),
  async (c) => {
    const id = c.req.param("id");
    const principal = c.get("principal");
    const wiki = await wikiService.getWiki(id);
    if (!wiki) return c.json({ error: "Wiki nicht gefunden" }, 404);
    await requireOrgCapability(principal, wiki.organization_id, "member.update");

    const { user_id, role } = c.req.valid("json");
    const row = await wikiService.setMemberRole(id, user_id, role);
    return c.json({ member: row }, 201);
  },
);

wikisRouter.delete("/:id/members/:userId", requireUser, async (c) => {
  const id = c.req.param("id");
  const principal = c.get("principal");
  const wiki = await wikiService.getWiki(id);
  if (!wiki) return c.json({ error: "Wiki nicht gefunden" }, 404);
  await requireOrgCapability(principal, wiki.organization_id, "member.update");

  await wikiService.removeMember(id, c.req.param("userId"));
  return c.json({ success: true });
});

export { wikisRouter };

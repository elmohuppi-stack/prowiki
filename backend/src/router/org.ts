/**
 * Organisationen des Aufrufers — **mit Rolle**.
 *
 * Warum ein eigener Endpunkt, wo Better Auth `organization.list()` mitbringt:
 * dessen Antwort enthält nur die Organisation selbst (id, name, slug, logo,
 * metadata), nicht die Mitgliedsrolle. Die Oberfläche braucht sie aber, weil
 * sich daraus die Capabilities ergeben — ohne Rolle fällt der Store auf
 * `viewer` zurück und blendet Bedienelemente aus, die dem Nutzer zustehen.
 *
 * Die Rolle kommt hier aus derselben `member`-Tabelle, aus der auch die
 * Middleware sie liest — nicht aus einer zweiten Quelle, die auseinanderlaufen
 * könnte.
 */
import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { organization, member } from "../db/schema.ts";

const orgRouter = new Hono();

/** Ohne Anmeldung eine leere Liste statt 401 — die Oberfläche fragt beim Start. */
orgRouter.get("/", async (c) => {
  const principal = c.get("principal");
  if (!principal?.userId) return c.json({ organizations: [] });

  const list = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, principal.userId))
    .orderBy(asc(organization.name));

  return c.json({ organizations: list });
});

export { orgRouter };

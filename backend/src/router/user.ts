/**
 * Mitglieder einer Organisation — schlanke Liste für Auswahlfelder
 * (Wiki-Override zuweisen, Autor auswählen).
 *
 * knora hatte hier `select id, name, email from users` **ohne jede
 * Einschränkung**: jeder angemeldete Nutzer bekam alle Konten des Systems samt
 * E-Mail-Adressen. Bei einem persönlichen Werkzeug mit einer Handvoll Nutzern
 * war das folgenlos; sobald mehrere Kunden dieselbe Instanz teilen, ist es ein
 * Datenleck — Kunde A kann die Belegschaft von Kunde B auslesen.
 *
 * Deshalb: Organisation im Pfad, Mitgliedschaft vorausgesetzt, und nur
 * Mitglieder *dieser* Organisation im Ergebnis.
 */
import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { user, member } from "../db/schema.ts";
import { resolveOrgAccess } from "../middleware/access.ts";

const userRouter = new Hono();

userRouter.get("/:orgId/users", async (c) => {
  const orgId = c.req.param("orgId");
  // Keine eigene Capability: wer in der Organisation ist, darf wissen, wer
  // sonst noch dort ist. Wer nicht drin ist, bekommt 404.
  await resolveOrgAccess(c.get("principal"), orgId);

  const list = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: member.role,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, orgId))
    .orderBy(asc(user.name));

  return c.json({ users: list });
});

export { userRouter };

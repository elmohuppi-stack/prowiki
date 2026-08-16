/**
 * Wikis — die Container unter einer Organisation. In knora hiessen sie
 * Workspaces und gehörten einer Person (`created_by`).
 *
 * Drei Unterschiede:
 *
 *   1. Jedes Wiki gehört einer Organisation. Wer es sehen darf, ergibt sich aus
 *      der Mitgliedschaft dort (plus optionalem Wiki-Override), nicht aus
 *      `created_by`.
 *   2. `slug` ist eine echte Spalte mit UNIQUE über (organization_id, slug).
 *      knora rechnete den Slug bei jedem Zugriff aus dem Namen aus — was
 *      `getWorkspaceBySlug()` zwang, **alle** Workspaces zu laden und in
 *      JavaScript zu vergleichen, und was bei einer Umbenennung stillschweigend
 *      alle Links brach.
 *   3. Löschen ist ein einzelnes DELETE. Das Schema hat durchgehend
 *      ON DELETE CASCADE; knoras FKs hatten das nicht, weshalb dort neun
 *      Kindtabellen in FK-sicherer Reihenfolge von Hand abgeräumt werden mussten.
 */
import { db } from "../db/index.ts";
import { user, wikis, wikiMembers, wikiVisits, member } from "../db/schema.ts";
import { eq, and, desc, sql } from "drizzle-orm";
import { normalizeRole } from "../auth/roles.ts";
import type { Principal } from "../middleware/access.ts";
import type { RoleName } from "../auth/permissions.ts";

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

export type WikiWithRole = typeof wikis.$inferSelect & {
  my_role: RoleName;
  organization_slug: string | null;
  /** Wann *dieser* Nutzer das Wiki zuletzt geöffnet hat; null = noch nie. */
  last_opened_at: Date | null;
};

/** Sortierschlüssel der Wiki-Übersicht. `recent` ist die Vorgabe. */
export const WIKI_SORTS = ["recent", "name", "created", "updated"] as const;
export type WikiSort = (typeof WIKI_SORTS)[number];

/**
 * Sortiert die Wiki-Liste. Läuft in JavaScript statt in SQL, weil listWikis die
 * beiden Rechtequellen ohnehin erst im Speicher zusammenführt — eine
 * ORDER-BY-Klausel würde nur eine der beiden Abfragen ordnen.
 *
 * `recent` stellt nie geöffnete Wikis nicht ans Ende, sondern sortiert sie
 * untereinander nach Erstelldatum: ein frisch angelegtes Wiki wäre sonst genau
 * dort unsichtbar, wo man es sucht.
 */
export function sortWikis(list: WikiWithRole[], sort: WikiSort): WikiWithRole[] {
  const byName = (a: WikiWithRole, b: WikiWithRole) =>
    a.name.localeCompare(b.name, "de");
  const zeit = (d: Date | null | undefined) => (d ? new Date(d).getTime() : 0);

  const sorted = [...list];
  switch (sort) {
    case "name":
      return sorted.sort(byName);
    case "created":
      return sorted.sort((a, b) => zeit(b.created_at) - zeit(a.created_at));
    case "updated":
      return sorted.sort((a, b) => zeit(b.updated_at) - zeit(a.updated_at));
    case "recent":
    default:
      return sorted.sort(
        (a, b) =>
          zeit(b.last_opened_at) - zeit(a.last_opened_at) ||
          zeit(b.created_at) - zeit(a.created_at),
      );
  }
}

/**
 * Alle Wikis, die `principal` sehen darf, mit der jeweils geltenden Rolle.
 *
 * Auflösung wie in middleware/access.ts: der Wiki-Override gewinnt gegen die
 * Organisationsrolle, damit Rechte pro Wiki auch *eingeschränkt* werden können.
 */
export async function listWikis(
  principal: Principal,
  sort: WikiSort = "recent",
): Promise<WikiWithRole[]> {
  if (!principal.userId) return [];

  const viaOrg = await db
    .select({ wiki: wikis, role: member.role })
    .from(member)
    .innerJoin(wikis, eq(wikis.organization_id, member.organizationId))
    .where(eq(member.userId, principal.userId))
    .orderBy(desc(wikis.created_at));

  const overrides = await db
    .select({ wiki: wikis, role: wikiMembers.role })
    .from(wikiMembers)
    .innerJoin(wikis, eq(wikis.id, wikiMembers.wiki_id))
    .where(eq(wikiMembers.user_id, principal.userId));

  // Eine Abfrage für alle Besuche des Nutzers statt einer je Wiki.
  const visits = await db
    .select({
      wiki_id: wikiVisits.wiki_id,
      last_opened_at: wikiVisits.last_opened_at,
    })
    .from(wikiVisits)
    .where(eq(wikiVisits.user_id, principal.userId));
  const visitByWiki = new Map(visits.map((v) => [v.wiki_id, v.last_opened_at]));

  const byId = new Map<string, WikiWithRole>();
  for (const row of viaOrg) {
    byId.set(row.wiki.id, {
      ...row.wiki,
      my_role: normalizeRole(row.role),
      organization_slug: null,
      last_opened_at: visitByWiki.get(row.wiki.id) ?? null,
    });
  }
  // Nach der Organisationsrolle eingespielt: der Override gewinnt.
  for (const row of overrides) {
    byId.set(row.wiki.id, {
      ...row.wiki,
      my_role: normalizeRole(row.role),
      organization_slug: null,
      last_opened_at: visitByWiki.get(row.wiki.id) ?? null,
    });
  }

  return sortWikis([...byId.values()], sort);
}

/**
 * Vermerkt, dass `userId` das Wiki gerade geöffnet hat.
 *
 * Upsert statt Insert: eine Zeile je Paar, sonst wüchse die Tabelle mit jedem
 * Seitenaufruf. Fehler werden geschluckt — ein misslungener Besuchsvermerk darf
 * das Öffnen eines Wikis nicht scheitern lassen.
 */
export async function touchWiki(
  userId: string,
  wikiId: string,
): Promise<void> {
  try {
    await db
      .insert(wikiVisits)
      .values({ user_id: userId, wiki_id: wikiId })
      .onConflictDoUpdate({
        target: [wikiVisits.user_id, wikiVisits.wiki_id],
        set: {
          last_opened_at: new Date(),
          visit_count: sql`${wikiVisits.visit_count} + 1`,
        },
      });
  } catch (e: any) {
    console.warn(`[wikis] Besuch nicht vermerkt (${wikiId}):`, e.message);
  }
}

export async function getWiki(id: string) {
  const [wiki] = await db.select().from(wikis).where(eq(wikis.id, id)).limit(1);
  return wiki ?? null;
}

/** Adressraum /<org-slug>/<wiki-slug>. Ein Index-Treffer statt eines Full-Scans. */
export async function getWikiBySlug(organizationId: string, slug: string) {
  const [wiki] = await db
    .select()
    .from(wikis)
    .where(and(eq(wikis.organization_id, organizationId), eq(wikis.slug, slug)))
    .limit(1);
  return wiki ?? null;
}

export async function createWiki(data: {
  organizationId: string;
  name: string;
  slug?: string;
  description?: string;
  visibility?: string;
  chunk_size?: number;
  chunk_overlap?: number;
  createdBy: string;
}) {
  const [wiki] = await db
    .insert(wikis)
    .values({
      id: crypto.randomUUID(),
      organization_id: data.organizationId,
      name: data.name,
      slug: data.slug?.trim() || slugify(data.name),
      description: data.description ?? null,
      // Neue Wikis sind privat. Öffentlich wird bewusst geschaltet, nie geerbt.
      visibility: data.visibility ?? "private",
      chunk_size: data.chunk_size ?? 512,
      chunk_overlap: data.chunk_overlap ?? 50,
      created_by: data.createdBy,
    })
    .returning();
  return wiki;
}

export async function updateWiki(
  id: string,
  data: {
    name?: string;
    slug?: string;
    description?: string;
    visibility?: string;
    anonymous_chat_enabled?: boolean;
    custom_domain?: string | null;
    chunk_size?: number;
    chunk_overlap?: number;
    wiki_depth?: string;
  },
) {
  const { wiki_depth, ...rest } = data;
  const setClause: Record<string, unknown> = { ...rest, updated_at: new Date() };
  // wiki_depth in das bestehende JSONB mergen, damit die übrigen Schlüssel
  // erhalten bleiben.
  if (wiki_depth !== undefined) {
    setClause.wiki_config = sql`coalesce(${wikis.wiki_config}, '{}'::jsonb) || ${JSON.stringify(
      { wiki_depth },
    )}::jsonb`;
  }
  const [wiki] = await db
    .update(wikis)
    .set(setClause)
    .where(eq(wikis.id, id))
    .returning();
  return wiki ?? null;
}

/** Ein DELETE — den Rest erledigt ON DELETE CASCADE (siehe Modulkommentar). */
export async function deleteWiki(id: string) {
  await db.delete(wikis).where(eq(wikis.id, id));
}

export async function listMembers(wikiId: string) {
  return await db
    .select({
      id: wikiMembers.id,
      wiki_id: wikiMembers.wiki_id,
      user_id: wikiMembers.user_id,
      role: wikiMembers.role,
      created_at: wikiMembers.created_at,
      name: user.name,
      email: user.email,
    })
    .from(wikiMembers)
    .innerJoin(user, eq(wikiMembers.user_id, user.id))
    .where(eq(wikiMembers.wiki_id, wikiId));
}

/**
 * Setzt einen Wiki-Override. Upsert statt Insert: ein erneutes Zuweisen soll
 * die Rolle ändern und nicht am Unique-Index scheitern.
 */
export async function setMemberRole(
  wikiId: string,
  userId: string,
  role: RoleName,
) {
  await db
    .insert(wikiMembers)
    .values({ id: crypto.randomUUID(), wiki_id: wikiId, user_id: userId, role })
    .onConflictDoUpdate({
      target: [wikiMembers.wiki_id, wikiMembers.user_id],
      set: { role },
    });

  const [row] = await db
    .select()
    .from(wikiMembers)
    .where(
      and(eq(wikiMembers.wiki_id, wikiId), eq(wikiMembers.user_id, userId)),
    )
    .limit(1);
  return row;
}

/**
 * Entfernt den Override. Der Zugriff fällt damit auf die Organisationsrolle
 * zurück — er verschwindet nicht zwangsläufig. Wer jemanden ganz aussperren
 * will, entfernt ihn aus der Organisation.
 */
export async function removeMember(wikiId: string, userId: string) {
  await db
    .delete(wikiMembers)
    .where(
      and(eq(wikiMembers.wiki_id, wikiId), eq(wikiMembers.user_id, userId)),
    );
}

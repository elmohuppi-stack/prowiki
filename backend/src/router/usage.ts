/**
 * Kostenübersicht: liest `usage_events` (service/usage.ts schreibt sie).
 *
 * Zählen ohne Ansehen nützt nichts — ohne diese Routen läge die Zählung in der
 * Datenbank und der einzige Weg zu ihr wäre `psql`. Genau das war der Zustand
 * bei knora, wo `activity_logs` zwar `duration_ms` hatte, aber niemand je
 * hineinsah.
 *
 * Der Zugang hängt an der **Wiki-Fähigkeit**, nicht an einer eigenen Rolle:
 * wer ein Wiki lesen darf, darf sehen, was es kostet. Die organisationsweite
 * Summe verlangt mehr, siehe unten.
 */
import { Hono } from "hono";
import { sessionMiddleware } from "../middleware/auth.ts";
import { requireWikiCapability } from "../middleware/access.ts";
import { db } from "../db/index.ts";
import { usageEvents, wikis } from "../db/schema.ts";
import { and, eq, gte, sql } from "drizzle-orm";

const usageRouter = new Hono();
usageRouter.use("*", sessionMiddleware);

/**
 * Zeitraum aus `?days=`.
 *
 * Gedeckelt auf 365: die Tabelle wächst mit jedem Chunk, und eine offene
 * Abfrage über alles wäre auf `pg-shared` ein Vollscan, den fünf fremde Apps
 * mitbezahlen.
 */
function seit(c: any): Date {
  const tage = Math.min(Math.max(parseInt(c.req.query("days") || "30"), 1), 365);
  return new Date(Date.now() - tage * 24 * 60 * 60 * 1000);
}

/**
 * Kosten eines Wiki, aufgeschlüsselt nach Art.
 *
 * `cost_micros` ist eine Schätzung aus einer Preistabelle im Code, `tokens_*`
 * sind gemessen — die Antwort liefert deshalb beides und benennt es so, dass in
 * der Oberfläche keine Genauigkeit vorgetäuscht wird, die es nicht gibt.
 */
usageRouter.get("/wiki/:wikiId", async (c) => {
  const wikiId = c.req.param("wikiId");
  await requireWikiCapability(c.get("principal"), wikiId, "wiki.read");

  const rows = await db
    .select({
      kind: usageEvents.kind,
      model: usageEvents.model,
      events: sql<number>`count(*)::int`,
      tokens_in: sql<number>`coalesce(sum(${usageEvents.tokens_in}), 0)::bigint`,
      tokens_out: sql<number>`coalesce(sum(${usageEvents.tokens_out}), 0)::bigint`,
      cost_micros: sql<number>`coalesce(sum(${usageEvents.cost_micros}), 0)::bigint`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.wiki_id, wikiId), gte(usageEvents.created_at, seit(c))))
    .groupBy(usageEvents.kind, usageEvents.model)
    .orderBy(sql`6 desc`);

  const summeMicros = rows.reduce((s, r) => s + Number(r.cost_micros), 0);
  return c.json({
    von: seit(c).toISOString(),
    posten: rows,
    summe_micros: summeMicros,
    summe_euro: summeMicros / 1_000_000,
    hinweis:
      "tokens_in/out sind gemessen, die Kosten aus einer Preistabelle geschätzt (service/usage.ts) – für die Abrechnung gilt die Rechnung des Anbieters.",
  });
});

/**
 * Kosten einer Organisation über alle ihre Wikis.
 *
 * Absichtlich nicht über eine Organisationsrolle abgesichert, sondern über die
 * Wikis: geprüft wird, ob der Anfragende **mindestens ein** Wiki dieser
 * Organisation lesen darf — und geliefert wird dann auch nur die Summe über
 * die Wikis, die er lesen darf. Ein Mitglied mit Zugang zu einem von zehn
 * Wikis bekommt so keine Zahl, aus der sich die anderen neun ableiten lassen.
 */
usageRouter.get("/org/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  const principal = c.get("principal");

  const alle = await db
    .select({ id: wikis.id, name: wikis.name })
    .from(wikis)
    .where(eq(wikis.organization_id, orgId));

  const erlaubt: { id: string; name: string }[] = [];
  for (const w of alle) {
    try {
      await requireWikiCapability(principal, w.id, "wiki.read");
      erlaubt.push(w);
    } catch {
      // Kein Zugang zu diesem Wiki – es bleibt aus der Summe heraus.
    }
  }
  if (erlaubt.length === 0) {
    return c.json({ error: "Kein Zugang zu Wikis dieser Organisation" }, 403);
  }

  const rows = await db
    .select({
      wiki_id: usageEvents.wiki_id,
      kind: usageEvents.kind,
      events: sql<number>`count(*)::int`,
      cost_micros: sql<number>`coalesce(sum(${usageEvents.cost_micros}), 0)::bigint`,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.organization_id, orgId),
        gte(usageEvents.created_at, seit(c)),
        sql`${usageEvents.wiki_id} = any(${erlaubt.map((w) => w.id)})`,
      ),
    )
    .groupBy(usageEvents.wiki_id, usageEvents.kind);

  const namen = new Map(erlaubt.map((w) => [w.id, w.name]));
  const summeMicros = rows.reduce((s, r) => s + Number(r.cost_micros), 0);

  return c.json({
    von: seit(c).toISOString(),
    wikis_gezählt: erlaubt.length,
    wikis_insgesamt: alle.length,
    posten: rows.map((r) => ({
      ...r,
      wiki_name: r.wiki_id ? namen.get(r.wiki_id) ?? null : null,
    })),
    summe_micros: summeMicros,
    summe_euro: summeMicros / 1_000_000,
  });
});

export { usageRouter };

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
import {
  requireWikiCapability,
  requireDocumentCapability,
} from "../middleware/access.ts";
import { db } from "../db/index.ts";
import { usageEvents, wikis, documents, wikiPages } from "../db/schema.ts";
import { and, eq, gte, inArray, sql, desc } from "drizzle-orm";
import { istBepreist, PREIS_VERSION } from "../service/usage.ts";

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
 * Derselbe Vorbehalt an jeder Antwort.
 *
 * Er steht in der Nutzlast und nicht nur in der Oberfläche, damit er auch dem
 * erhalten bleibt, der die Route unmittelbar abfragt: Tokens sind gemessen,
 * Euro sind geschätzt. Eine Kostenseite, die das nicht sagt, wird nach der
 * ersten Abweichung von der Anbieterrechnung im Ganzen misstraut.
 */
const HINWEIS =
  "tokens_in/out/cached sind gemessen, die Kosten aus einer Preistabelle geschätzt " +
  "(service/usage.ts) – für die Abrechnung gilt die Rechnung des Anbieters.";

/**
 * `sum(...)::bigint` kommt aus dem Treiber als Zeichenkette zurück — bigint
 * passt nicht sicher in eine JS-Zahl, also gibt node-postgres es lieber als
 * Text heraus. In JSON wären das dann `"1234"` statt `1234`, und jede Rechnung
 * in der Oberfläche würde still zur Zeichenverkettung. Deshalb hier einmal
 * zentral in Zahlen wandeln.
 */
function zahlen<T extends Record<string, any>>(zeilen: T[]): T[] {
  const felder = [
    "events",
    "tokens_in",
    "tokens_out",
    "tokens_cached",
    "cost_micros",
    "anzahl",
  ];
  return zeilen.map((z) => {
    const kopie: any = { ...z };
    for (const f of felder) if (f in kopie) kopie[f] = Number(kopie[f]);
    return kopie as T;
  });
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
      tokens_cached: sql<number>`coalesce(sum(${usageEvents.tokens_cached}), 0)::bigint`,
      cost_micros: sql<number>`coalesce(sum(${usageEvents.cost_micros}), 0)::bigint`,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.wiki_id, wikiId), gte(usageEvents.created_at, seit(c))))
    .groupBy(usageEvents.kind, usageEvents.model)
    .orderBy(sql`6 desc`);

  const summeMicros = rows.reduce((s, r) => s + Number(r.cost_micros), 0);
  return c.json({
    von: seit(c).toISOString(),
    posten: zahlen(rows),
    summe_micros: summeMicros,
    summe_euro: summeMicros / 1_000_000,
    hinweis: HINWEIS,
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
        // `inArray` statt eines `= any(...)` in einem sql-Template: ein
        // JS-Array in ein sql-Template zu geben ist genau der Fehler, der in
        // deletePage drei Generierungsläufe gekostet hat.
        inArray(
          usageEvents.wiki_id,
          erlaubt.map((w) => w.id),
        ),
      ),
    )
    .groupBy(usageEvents.wiki_id, usageEvents.kind);

  const namen = new Map(erlaubt.map((w) => [w.id, w.name]));
  const summeMicros = rows.reduce((s, r) => s + Number(r.cost_micros), 0);

  return c.json({
    von: seit(c).toISOString(),
    wikis_gezählt: erlaubt.length,
    wikis_insgesamt: alle.length,
    posten: zahlen(rows).map((r) => ({
      ...r,
      wiki_name: r.wiki_id ? namen.get(r.wiki_id) ?? null : null,
    })),
    summe_micros: summeMicros,
    summe_euro: summeMicros / 1_000_000,
  });
});

/**
 * Alles, was die Kostenübersicht eines Wiki braucht — in **einer** Antwort.
 *
 * Fünf Abfragen, ein Aufruf. Die Alternative wären fünf Endpunkte gewesen, die
 * die Oberfläche einzeln zieht; bei einer Seite, die sie ohnehin immer alle
 * zusammen anzeigt, sind das nur fünf Gelegenheiten für einen halb geladenen
 * Zustand. Die Abfragen laufen parallel und gehen alle über
 * `(wiki_id, created_at)` bzw. `ref_id` — die beiden Indizes aus Migration 0003.
 */
usageRouter.get("/wiki/:wikiId/uebersicht", async (c) => {
  const wikiId = c.req.param("wikiId");
  await requireWikiCapability(c.get("principal"), wikiId, "wiki.read");
  const von = seit(c);
  const imZeitraum = and(
    eq(usageEvents.wiki_id, wikiId),
    gte(usageEvents.created_at, von),
  );

  const [nachArt, nachModell, tage, dokumentPosten, artikel] = await Promise.all([
    db
      .select({
        kind: usageEvents.kind,
        events: sql<number>`count(*)::int`,
        tokens_in: sql<number>`coalesce(sum(${usageEvents.tokens_in}), 0)::bigint`,
        tokens_out: sql<number>`coalesce(sum(${usageEvents.tokens_out}), 0)::bigint`,
        tokens_cached: sql<number>`coalesce(sum(${usageEvents.tokens_cached}), 0)::bigint`,
        cost_micros: sql<number>`coalesce(sum(${usageEvents.cost_micros}), 0)::bigint`,
      })
      .from(usageEvents)
      .where(imZeitraum)
      .groupBy(usageEvents.kind),

    db
      .select({
        model: usageEvents.model,
        events: sql<number>`count(*)::int`,
        tokens_in: sql<number>`coalesce(sum(${usageEvents.tokens_in}), 0)::bigint`,
        tokens_out: sql<number>`coalesce(sum(${usageEvents.tokens_out}), 0)::bigint`,
        tokens_cached: sql<number>`coalesce(sum(${usageEvents.tokens_cached}), 0)::bigint`,
        cost_micros: sql<number>`coalesce(sum(${usageEvents.cost_micros}), 0)::bigint`,
      })
      .from(usageEvents)
      .where(imZeitraum)
      .groupBy(usageEvents.model),

    // Tagesreihe, aufgeschlüsselt nach Art — die Oberfläche stapelt daraus die
    // Balken. Datum als Text, damit die Zeitzone des Browsers einen Tag nicht
    // verschieben kann.
    db
      .select({
        tag: sql<string>`to_char(date_trunc('day', ${usageEvents.created_at}), 'YYYY-MM-DD')`,
        kind: usageEvents.kind,
        cost_micros: sql<number>`coalesce(sum(${usageEvents.cost_micros}), 0)::bigint`,
      })
      .from(usageEvents)
      .where(imZeitraum)
      .groupBy(sql`1`, usageEvents.kind)
      .orderBy(sql`1`),

    // Kosten je Eingangsdokument. Der Join geht über ref_id: dort steht seit
    // Stufe 0 die Dokument-ID der Generierungsläufe und seit Migration 0003
    // auch die der Transkript- und Embedding-Posten.
    db
      .select({
        document_id: documents.id,
        title: documents.title,
        type: documents.type,
        events: sql<number>`count(*)::int`,
        tokens_in: sql<number>`coalesce(sum(${usageEvents.tokens_in}), 0)::bigint`,
        tokens_out: sql<number>`coalesce(sum(${usageEvents.tokens_out}), 0)::bigint`,
        tokens_cached: sql<number>`coalesce(sum(${usageEvents.tokens_cached}), 0)::bigint`,
        cost_micros: sql<number>`coalesce(sum(${usageEvents.cost_micros}), 0)::bigint`,
      })
      .from(usageEvents)
      .innerJoin(documents, eq(documents.id, usageEvents.ref_id))
      .where(imZeitraum)
      .groupBy(documents.id, documents.title, documents.type)
      .orderBy(desc(sql`sum(${usageEvents.cost_micros})`))
      .limit(50),

    // Artikel je Quelldokument — der Ertrag, gegen den die Kosten stehen.
    // Bewusst **ohne** Zeitfilter: ein Artikel aus einem Lauf von letzter Woche
    // existiert heute noch, und die Frage lautet „was ist aus dem Dokument
    // geworden", nicht „was entstand in diesen 30 Tagen".
    db
      .select({
        document_id: wikiPages.source_document_id,
        anzahl: sql<number>`count(*)::int`,
      })
      .from(wikiPages)
      .where(eq(wikiPages.wiki_id, wikiId))
      .groupBy(wikiPages.source_document_id),
  ]);

  const artikelJeDoc = new Map(
    artikel
      .filter((a) => a.document_id)
      .map((a) => [a.document_id as string, Number(a.anzahl)]),
  );
  const artikelGesamt = artikel.reduce((s, a) => s + Number(a.anzahl), 0);

  const summeMicros = nachArt.reduce((s, r) => s + Number(r.cost_micros), 0);
  const tokensIn = nachArt.reduce((s, r) => s + Number(r.tokens_in), 0);
  const tokensOut = nachArt.reduce((s, r) => s + Number(r.tokens_out), 0);
  const tokensCached = nachArt.reduce((s, r) => s + Number(r.tokens_cached), 0);
  const events = nachArt.reduce((s, r) => s + Number(r.events), 0);

  return c.json({
    von: von.toISOString(),
    kpi: {
      cost_micros: summeMicros,
      euro: summeMicros / 1_000_000,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_cached: tokensCached,
      // Anteil der Eingabetokens, die aus dem Prompt-Cache kamen. Die Zahl, an
      // der man ablesen kann, ob ein zweiter Generierungslauf teuer war.
      cache_quote: tokensIn > 0 ? tokensCached / tokensIn : 0,
      events,
      artikel_gesamt: artikelGesamt,
      kosten_je_artikel_micros:
        artikelGesamt > 0 ? Math.round(summeMicros / artikelGesamt) : null,
    },
    nach_art: zahlen(nachArt),
    nach_modell: zahlen(nachModell),
    tage: tage.map((t) => ({ ...t, cost_micros: Number(t.cost_micros) })),
    dokumente: zahlen(dokumentPosten).map((d: any) => {
      const anzahl = artikelJeDoc.get(d.document_id) ?? 0;
      return {
        ...d,
        artikel: anzahl,
        kosten_je_artikel_micros:
          anzahl > 0 ? Math.round(d.cost_micros / anzahl) : null,
      };
    }),
    // Nur token-basierte Posten können an einer fehlenden Preiszeile scheitern.
    // Ein Transkriptabruf steht mit `model: "apify"` und null Tokens in der
    // Tabelle — seine Festgebühr ist gezählt, und ihn hier als „ohne Preis" zu
    // melden würde eine Lücke behaupten, die es nicht gibt.
    unbepreiste_modelle: nachModell
      .filter(
        (m) =>
          !!m.model &&
          !istBepreist(m.model) &&
          Number(m.tokens_in) + Number(m.tokens_out) > 0,
      )
      .map((m) => m.model as string),
    preis_version: PREIS_VERSION,
    hinweis: HINWEIS,
  });
});

/**
 * Was ein einzelnes Eingangsdokument gekostet und was es erbracht hat.
 *
 * Die Zahl, die auf der Dokumentseite fehlte: bisher stand dort, wie viele
 * Chunks entstanden sind — also der Aufwand des Systems, nicht der des Geldes.
 *
 * Zwei Vorbehalte stehen ausdrücklich in der Antwort statt nur in diesem
 * Kommentar, weil sie sonst in der Oberfläche verschwiegen würden:
 * `vollstaendig_ab` nennt den Tag, ab dem Transkript und Embeddings überhaupt
 * einem Dokument zugeordnet werden — ältere Dokumente zeigen nur ihre
 * LLM-Kosten und sind damit zu günstig.
 */
usageRouter.get("/document/:docId", async (c) => {
  const docId = c.req.param("docId");
  const { wikiId } = await requireDocumentCapability(
    c.get("principal"),
    docId,
    "wiki.read",
  );

  const [posten, artikel] = await Promise.all([
    db
      .select({
        kind: usageEvents.kind,
        model: usageEvents.model,
        events: sql<number>`count(*)::int`,
        tokens_in: sql<number>`coalesce(sum(${usageEvents.tokens_in}), 0)::bigint`,
        tokens_out: sql<number>`coalesce(sum(${usageEvents.tokens_out}), 0)::bigint`,
        tokens_cached: sql<number>`coalesce(sum(${usageEvents.tokens_cached}), 0)::bigint`,
        cost_micros: sql<number>`coalesce(sum(${usageEvents.cost_micros}), 0)::bigint`,
      })
      .from(usageEvents)
      // Kein Zeitfilter: gefragt ist, was dieses Dokument insgesamt gekostet
      // hat, nicht was es in den letzten dreißig Tagen gekostet hat.
      .where(eq(usageEvents.ref_id, docId))
      .groupBy(usageEvents.kind, usageEvents.model)
      .orderBy(desc(sql`sum(${usageEvents.cost_micros})`)),

    db
      .select({
        page_type: wikiPages.page_type,
        anzahl: sql<number>`count(*)::int`,
      })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.wiki_id, wikiId),
          eq(wikiPages.source_document_id, docId),
        ),
      )
      .groupBy(wikiPages.page_type),
  ]);

  const summeMicros = posten.reduce((s, r) => s + Number(r.cost_micros), 0);
  const artikelGesamt = artikel.reduce((s, a) => s + Number(a.anzahl), 0);

  return c.json({
    document_id: docId,
    posten: zahlen(posten),
    summe_micros: summeMicros,
    summe_euro: summeMicros / 1_000_000,
    artikel_gesamt: artikelGesamt,
    artikel_nach_typ: artikel.map((a) => ({ ...a, anzahl: Number(a.anzahl) })),
    kosten_je_artikel_micros:
      artikelGesamt > 0 ? Math.round(summeMicros / artikelGesamt) : null,
    // Siehe /uebersicht: Posten mit Festgebühr haben keine Tokens und sind
    // deshalb auch nicht „ohne Preis".
    unbepreiste_modelle: [
      ...new Set(
        posten
          .filter(
            (p) =>
              !!p.model &&
              !istBepreist(p.model) &&
              Number(p.tokens_in) + Number(p.tokens_out) > 0,
          )
          .map((p) => p.model as string),
      ),
    ],
    // Vor diesem Tag trugen Transkriptabruf und Embeddings keine Dokument-ID;
    // ihre Kosten fehlen bei älteren Dokumenten und lassen sich nicht
    // nachtragen. Die Oberfläche sagt das dazu, statt eine zu kleine Zahl als
    // vollständig auszugeben.
    vollstaendig_ab: "2026-08-23",
    hinweis: HINWEIS,
  });
});

export { usageRouter };

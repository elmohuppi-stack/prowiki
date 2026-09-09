import { db } from "../db/index.ts";
import {
  documents,
  chunks,
  wikiPages,
  wikiPageRevisions,
  activityLogs,
  documentTopics,
  transcriptSegments,
} from "../db/schema.ts";
import { eq, desc, asc, and, sql, ilike, gte, lte, inArray } from "drizzle-orm";
import { textArray } from "../db/sql-array.ts";

export type DocumentSort =
  | "created_desc"
  | "created_asc"
  | "published_desc"
  | "published_asc"
  | "title_asc"
  | "title_desc";

export interface ListDocumentsOptions {
  type?: string;
  channel?: string;
  query?: string;
  dateFrom?: Date;
  dateTo?: Date;
  topicIds?: string[];
  sort?: DocumentSort;
}

export async function listDocuments(
  wikiId: string,
  opts: ListDocumentsOptions = {},
) {
  const conditions = [eq(documents.wiki_id, wikiId)];
  if (opts.type) conditions.push(eq(documents.type, opts.type));
  if (opts.channel) conditions.push(eq(documents.channel, opts.channel));
  if (opts.query) conditions.push(ilike(documents.title, `%${opts.query}%`));
  // Datumsbereich filtert auf das Sitzungs-/Veröffentlichungsdatum, mit Rückfall
  // auf das Import-Datum. Vorher lief der Filter allein gegen created_at – bei
  // einem Massenimport teilen hunderte Dokumente dieselbe Import-Minute, der
  // Filter war damit alles-oder-nichts und als Navigation unbrauchbar.
  if (opts.dateFrom) {
    conditions.push(
      sql`coalesce(${documents.published_at}, ${documents.created_at}) >= ${opts.dateFrom}`,
    );
  }
  if (opts.dateTo) {
    conditions.push(
      sql`coalesce(${documents.published_at}, ${documents.created_at}) <= ${opts.dateTo}`,
    );
  }
  // Themen-Filter (Ebene 1): Dokumente mit einem der Themen (Subquery auf Junction).
  if (opts.topicIds && opts.topicIds.length > 0) {
    conditions.push(
      inArray(
        documents.id,
        db
          .select({ id: documentTopics.document_id })
          .from(documentTopics)
          .where(inArray(documentTopics.topic_id, opts.topicIds)),
      ),
    );
  }

  const orderBy = (() => {
    switch (opts.sort) {
      case "created_asc":
        return asc(documents.created_at);
      // published_at kann null sein (nicht-YouTube / Altbestand) → NULLS LAST,
      // damit Videos mit Datum vorne stehen.
      case "published_desc":
        return sql`${documents.published_at} desc nulls last`;
      case "published_asc":
        return sql`${documents.published_at} asc nulls last`;
      case "title_asc":
        return asc(documents.title);
      case "title_desc":
        return desc(documents.title);
      case "created_desc":
      default:
        return desc(documents.created_at);
    }
  })();

  return await db
    .select()
    .from(documents)
    .where(and(...conditions))
    .orderBy(orderBy);
}

/** Distinct-Kanäle eines Wiki (für das Kanal-Filter-Dropdown). */
export async function listChannels(wikiId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ channel: documents.channel })
    .from(documents)
    .where(
      and(
        eq(documents.wiki_id, wikiId),
        sql`${documents.channel} is not null and ${documents.channel} <> ''`,
      ),
    );
  return rows
    .map((r) => r.channel as string)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "de"));
}

export async function getDocument(id: string) {
  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, id))
    .limit(1);
  return doc || null;
}

export async function createDocument(data: {
  id: string;
  wiki_id: string;
  title: string;
  type: string;
  source: string;
  source_url?: string;
  content?: string;
  file_path?: string;
  file_size?: number;
  file_hash?: string;
  channel?: string | null;
  published_at?: Date | null;
  duration?: number | null;
  source_metadata?: Record<string, unknown>;
  // null bei systemseitig erzeugten Dokumenten (Chat-Transkript, Kanal-Sync).
  created_by: string | null;
}) {
  const [doc] = await db.insert(documents).values(data).returning();
  return doc;
}

/** Aktualisiert die Herkunfts-Metadaten (Ebene 2, z.B. YouTube-Refresh). */
export async function updateDocumentMetadata(
  id: string,
  data: {
    channel?: string | null;
    published_at?: Date | null;
    duration?: number | null;
    source_metadata?: Record<string, unknown>;
  },
) {
  const [doc] = await db
    .update(documents)
    .set({ ...data, updated_at: new Date() })
    .where(eq(documents.id, id))
    .returning();
  return doc || null;
}

export async function updateDocumentStatus(
  id: string,
  status: string,
  error?: string,
  chunkCount?: number,
) {
  const updateData: Record<string, any> = {
    parse_status: status,
    updated_at: new Date(),
  };
  if (status === "processing") {
    updateData.processed_at = null;
  }
  if (status === "completed") {
    updateData.processed_at = new Date();
  }
  if (chunkCount !== undefined) {
    updateData.chunk_count = chunkCount;
  }
  if (error) {
    updateData.parse_error = error;
  }
  const [doc] = await db
    .update(documents)
    .set(updateData)
    .where(eq(documents.id, id))
    .returning();
  return doc || null;
}

export async function updateDocumentContent(id: string, content: string) {
  const [doc] = await db
    .update(documents)
    .set({ content, updated_at: new Date() })
    .where(eq(documents.id, id))
    .returning();
  return doc || null;
}

/**
 * Chunks eines Dokuments verwerfen — Vorstufe eines erneuten Chunkings, etwa
 * wenn ein Transkript neu geholt wurde und jetzt Zeitmarken trägt.
 *
 * Die Wiki-Chunks (`wiki--<uuid>`) bleiben unberührt: sie hängen an Artikeln,
 * nicht am Dokument.
 */
export async function deleteChunks(documentId: string) {
  const geloescht = await db
    .delete(chunks)
    .where(eq(chunks.document_id, documentId))
    .returning({ id: chunks.id });
  return geloescht.length;
}

/** Die beiden jsonb-Linkspalten von wiki_pages. */
export const LINKSPALTEN = ["in_links", "out_links"] as const;

/**
 * Entfernt aus einer Linkspalte alle Verweise auf verschwindende Slugs.
 *
 * Eigene Funktion, damit sich das erzeugte SQL ohne Datenbank prüfen lässt —
 * und das ist hier nötig gewesen: die Slug-Liste war als JS-Array direkt im
 * `sql`-Template gestanden und wurde dadurch zur Parameterliste `($1, $2)`.
 * `ALL(($1, $2))` lehnt Postgres ab, das Löschen jedes Dokuments mit eigenen
 * Artikeln schlug mit HTTP 500 fehl (Dokumente ohne Artikel nicht, weil dieser
 * Zweig bei ihnen gar nicht lief). Siehe db/sql-array.ts.
 */
export function entferneSlugVerweise(
  column: (typeof LINKSPALTEN)[number],
  wikiId: string,
  slugs: string[],
) {
  const liste = textArray(slugs);

  return sql`
    UPDATE wiki_pages
    SET ${sql.raw(column)} = COALESCE((
          SELECT jsonb_agg(e)
          FROM jsonb_array_elements_text(${sql.raw(column)}) AS e
          WHERE e <> ALL(${liste})
        ), '[]'::jsonb),
        updated_at = now()
    WHERE wiki_id = ${wikiId}
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(${sql.raw(column)}) AS e
        WHERE e = ANY(${liste})
      )
  `;
}

export async function deleteDocument(id: string) {
  await db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ wiki_id: documents.wiki_id })
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    if (!doc) return;

    // Kapitel-/Übersichtsartikel gehören exklusiv zu diesem Dokument und werden
    // mitgelöscht – sonst blieben ihre Inhalte (und deren Chunks) als Quelle im
    // Chat auffindbar, obwohl das Dokument weg ist. Ausgenommen sind manuell
    // bearbeitete Seiten: dort steckt Arbeit drin, die nicht still verschwinden
    // darf. Entity-/Concept-Seiten sind dokumentübergreifend und werden nur
    // entkoppelt.
    const ownPages = await tx
      .select({ id: wikiPages.id, slug: wikiPages.slug })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.source_document_id, id),
          inArray(wikiPages.page_type, ["summary", "article"]),
          eq(wikiPages.manually_edited, false),
        ),
      );

    if (ownPages.length > 0) {
      const pageIds = ownPages.map((p) => p.id);
      const slugs = ownPages.map((p) => p.slug);

      // Verweise anderer Seiten auf die verschwindenden Slugs entfernen
      // (in_links/out_links sind jsonb-Arrays).
      for (const column of LINKSPALTEN) {
        await tx.execute(entferneSlugVerweise(column, doc.wiki_id, slugs));
      }

      await tx
        .delete(wikiPageRevisions)
        .where(inArray(wikiPageRevisions.page_id, pageIds));
      await tx.delete(wikiPages).where(inArray(wikiPages.id, pageIds));
      // Chunks der Wiki-Seiten tragen das Präfix "wiki--<page-id>".
      await tx.delete(chunks).where(
        inArray(
          chunks.document_id,
          pageIds.map((pid) => `wiki--${pid}`),
        ),
      );
    }

    // Verbleibende Seiten (Entity/Concept, manuell bearbeitete) entkoppeln.
    await tx
      .update(wikiPages)
      .set({ source_document_id: null })
      .where(eq(wikiPages.source_document_id, id));

    // Activity-Logs entkoppeln (FK ohne Cascade → sonst Constraint-Fehler beim Löschen).
    // Log-Historie bleibt erhalten, nur die Dokument-Referenz wird entfernt.
    await tx
      .update(activityLogs)
      .set({ document_id: null })
      .where(eq(activityLogs.document_id, id));
    // Themen-Zuordnungen entfernen (FK ohne Cascade).
    await tx.delete(documentTopics).where(eq(documentTopics.document_id, id));
    await tx.delete(chunks).where(eq(chunks.document_id, id));
    await tx.delete(documents).where(eq(documents.id, id));
  });
}

export async function saveChunks(
  documentId: string,
  wikiId: string,
  chunkData: {
    content: string;
    chunk_index: number;
    token_count: number;
    start_ms?: number | null;
    end_ms?: number | null;
  }[],
) {
  if (chunkData.length === 0) return [];

  // Bulk-Insert: ein einziger Round-Trip statt N Einzel-Inserts. Verhindert,
  // dass ein langes Transkript den DB-Pool über viele serielle Queries blockiert.
  const values = chunkData.map((c) => ({
    id: crypto.randomUUID(),
    document_id: documentId,
    wiki_id: wikiId,
    content: c.content,
    chunk_index: c.chunk_index,
    token_count: c.token_count,
    start_ms: c.start_ms ?? null,
    end_ms: c.end_ms ?? null,
  }));

  return await db.insert(chunks).values(values).returning();
}

/**
 * Transkriptsegmente eines Dokuments ersetzen.
 *
 * Erst löschen, dann einfügen: beim erneuten Holen eines Transkripts (etwa über
 * den Wiederhol-Endpunkt) könnte ein anderer Actor eine andere Segmentzahl
 * liefern, und ein reiner Upsert ließe die überzähligen Zeilen stehen.
 */
export async function replaceTranscriptSegments(
  documentId: string,
  wikiId: string,
  segmente: {
    start_ms: number;
    end_ms: number | null;
    text: string;
    speaker?: string | null;
  }[],
) {
  await db
    .delete(transcriptSegments)
    .where(eq(transcriptSegments.document_id, documentId));

  if (segmente.length === 0) return 0;

  // In Blöcken einfügen: ein einzelnes INSERT mit zehntausenden Zeilen
  // überschreitet bei langen Videos das Parameterlimit von Postgres.
  const BLOCK = 500;
  for (let i = 0; i < segmente.length; i += BLOCK) {
    await db.insert(transcriptSegments).values(
      segmente.slice(i, i + BLOCK).map((s, j) => ({
        document_id: documentId,
        wiki_id: wikiId,
        segment_index: i + j,
        start_ms: s.start_ms,
        end_ms: s.end_ms,
        text: s.text,
        speaker: s.speaker ?? null,
      })),
    );
  }

  return segmente.length;
}

/** Segmente eines Dokuments in Videoreihenfolge. */
export async function listTranscriptSegments(documentId: string) {
  return await db
    .select()
    .from(transcriptSegments)
    .where(eq(transcriptSegments.document_id, documentId))
    .orderBy(transcriptSegments.segment_index);
}

// Hilfsfunktion: Text in Chunks teilen
export function splitIntoChunks(
  text: string,
  chunkSize: number = 512,
  overlap: number = 50,
) {
  if (!text || text.length === 0) return [];

  // char_start/char_end wandern mit: nur darüber lässt sich einem Chunk später
  // das Zeitfenster im Video zuordnen (siehe youtube.ts, zeitfensterFür).
  const chunks: {
    content: string;
    chunk_index: number;
    token_count: number;
    char_start: number;
    char_end: number;
  }[] = [];
  let start = 0;
  let index = 0;

  // Sicherstellen, dass der Fortschritt pro Iteration positiv ist. Sonst
  // (z.B. overlap >= chunkSize, oder am Textende wenn end nicht mehr wächst)
  // würde start nicht vorankommen → Endlosschleife.
  const step = Math.max(1, chunkSize - overlap);

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const content = text.slice(start, end);

    chunks.push({
      content,
      chunk_index: index,
      token_count: content.split(/\s+/).length,
      char_start: start,
      char_end: end,
    });

    index++;

    // Letzter Chunk erreicht das Textende → fertig.
    if (end >= text.length) break;

    start += step;
  }

  return chunks;
}

import { db } from "../db/index.ts";
import {
  wikiPages,
  wikiPageRevisions,
  documents,
  chunks,
  workspaces,
  modelProviders,
  documentTopics,
} from "../db/schema.ts";
import {
  eq,
  ne,
  and,
  like,
  or,
  ilike,
  desc,
  asc,
  gte,
  lte,
  sql,
  inArray,
  getTableColumns,
} from "drizzle-orm";
import { splitIntoChunks, saveChunks } from "./document.ts";

/**
 * Obergrenze für page_size. Vorher unbegrenzt – ein page_size=100000 hätte den
 * gesamten Wiki-Inhalt inklusive aller content-Spalten in eine Antwort geladen.
 */
const MAX_PAGE_SIZE = 200;

// --- Wiki-Chunk-Sync (für Chat-Suche) ---

/**
 * Synct den Inhalt einer Wiki-Seite in die chunks-Tabelle,
 * damit sie über RAG / Chat-Suche auffindbar ist.
 * Wiki-Chunks bekommen document_id = "wiki--<page-id>".
 */
export async function syncWikiPageToChunks(
  workspaceId: string,
  pageId: string,
  content: string,
) {
  if (!content || content.trim().length === 0) return;

  // 1. Vorhandene Chunks für diese Wiki-Seite löschen
  await db
    .delete(chunks)
    .where(
      and(
        eq(chunks.document_id, `wiki--${pageId}`),
        eq(chunks.workspace_id, workspaceId),
      ),
    );

  // 2. Workspace für Chunk-Größe laden
  const [ws] = await db
    .select({
      chunk_size: workspaces.chunk_size,
      chunk_overlap: workspaces.chunk_overlap,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const chunkSize = ws?.chunk_size || 512;
  const chunkOverlap = ws?.chunk_overlap || 50;

  // 3. Content chucken und speichern
  const chunkList = splitIntoChunks(content, chunkSize, chunkOverlap);
  if (chunkList.length > 0) {
    await saveChunks(`wiki--${pageId}`, workspaceId, chunkList);
  }
}

/**
 * Löscht alle Chunks einer Wiki-Seite.
 */
export async function deleteWikiPageChunks(
  workspaceId: string,
  pageId: string,
) {
  await db
    .delete(chunks)
    .where(
      and(
        eq(chunks.document_id, `wiki--${pageId}`),
        eq(chunks.workspace_id, workspaceId),
      ),
    );
}

// --- CRUD ---

export type WikiSort =
  | "updated_desc"
  | "updated_asc"
  | "title_asc"
  | "title_desc"
  | "published_desc"
  | "published_asc"
  | "connections_desc";

export async function listPages(
  workspaceId: string,
  options?: {
    page_type?: string;
    status?: string;
    query?: string;
    source_document_id?: string;
    // Herkunfts-Filter/Sortierung über das Quell-Dokument (Ebene 2).
    // Betreffen nur Seiten mit source_document_id (v.a. Summaries).
    channel?: string;
    dateFrom?: Date;
    dateTo?: Date;
    topicIds?: string[];
    // Ebene 3: nur Seiten, deren out_links diesen Slug enthalten (Backlink-Filter).
    references?: string;
    // Ebene 4: Auffälligkeiten aus page_metadata.flags (OR-Semantik).
    flags?: string[];
    sort?: WikiSort;
    page?: number;
    page_size?: number;
  },
) {
  const page = Math.max(1, options?.page || 1);
  // Obergrenze: page_size war unbegrenzt, ein page_size=100000 hätte den
  // gesamten Wiki-Inhalt inkl. content in eine Antwort geladen.
  const pageSize = Math.min(Math.max(1, options?.page_size || 50), MAX_PAGE_SIZE);

  let conditions = eq(wikiPages.workspace_id, workspaceId);

  if (options?.page_type) {
    conditions = and(conditions, eq(wikiPages.page_type, options.page_type))!;
  }
  // Status-Filter: der normale Wiki-Browser übergibt "published" und blendet so
  // unveröffentlichte Entwürfe (Chat-Verbund) aus.
  if (options?.status) {
    conditions = and(conditions, eq(wikiPages.status, options.status))!;
  }
  if (options?.query) {
    // Deutsche Volltextsuche statt LIKE: `like` ist case-sensitive (die Suche
    // nach "masken" fand "Masken" nicht), ohne Wortstamm-Erkennung und ohne
    // Index. to_tsvector('german', …) findet auch Beugungen und nutzt den
    // GIN-Index aus Migration 0007.
    //
    // Der LIKE-Zweig bleibt als ODER daneben: websearch_to_tsquery findet keine
    // Teilwörter, und Kürzel wie "FG36" oder Slug-Fragmente sucht man genau so.
    const q = options.query.trim();
    conditions = and(
      conditions,
      or(
        sql`to_tsvector('german', coalesce(${wikiPages.title}, '') || ' ' || coalesce(${wikiPages.content}, '')) @@ websearch_to_tsquery('german', ${q})`,
        ilike(wikiPages.title, `%${q}%`),
      ),
    )!;
  }
  if (options?.source_document_id) {
    conditions = and(
      conditions,
      eq(wikiPages.source_document_id, options.source_document_id),
    )!;
  }
  if (options?.channel) {
    conditions = and(conditions, eq(documents.channel, options.channel))!;
  }
  // Zeitraum: auf das Sitzungs-/Veröffentlichungsdatum, nicht auf den Import.
  // Vorher lief der Filter gegen created_at – bei einem Massenimport teilen
  // hunderte Dokumente dieselbe Import-Minute, der Filter war damit
  // alles-oder-nichts und als Navigation über einen Zeitraum unbrauchbar.
  // coalesce() hält Altbestand ohne published_at weiterhin filterbar.
  if (options?.dateFrom) {
    conditions = and(
      conditions,
      sql`coalesce(${documents.published_at}, ${documents.created_at}) >= ${options.dateFrom}`,
    )!;
  }
  if (options?.dateTo) {
    conditions = and(
      conditions,
      sql`coalesce(${documents.published_at}, ${documents.created_at}) <= ${options.dateTo}`,
    )!;
  }
  // Ebene 4: Auffälligkeiten – Seiten, deren page_metadata.flags einen der
  // gesuchten Marker enthält (OR-Semantik). Bewusst ein @>-Vergleich je Marker
  // statt ?| mit zusammengebautem Array: so ist jeder Wert ein echter
  // Query-Parameter und nicht in SQL hineininterpoliert.
  //
  // Der Vergleich läuft gegen die GANZE Spalte (`page_metadata @> '{"flags":…}'`)
  // und nicht gegen die Extraktion (`page_metadata -> 'flags' @> …`): der Index
  // wiki_pages_metadata_gin_idx liegt auf der Spalte mit jsonb_path_ops, und zu
  // einer ->-Extraktion links vom Operator passt er nicht. Gemessen auf
  // Produktivdaten: 11,7 ms Seq Scan über 5.703 Zeilen gegenüber 0,4 ms per
  // Bitmap Index Scan. Semantisch sind beide Formen gleich für "enthält Marker X".
  if (options?.flags && options.flags.length > 0) {
    const flagConds = options.flags.map(
      (f) =>
        sql`${wikiPages.page_metadata} @> ${JSON.stringify({ flags: [f] })}::jsonb`,
    );
    conditions = and(conditions, or(...flagConds))!;
  }
  // Backlink-Filter (Ebene 3): Seiten, deren out_links den Slug enthalten.
  if (options?.references) {
    conditions = and(
      conditions,
      sql`${wikiPages.out_links} @> ${JSON.stringify([options.references])}::jsonb`,
    )!;
  }
  // Themen-Filter (Ebene 1): Seiten, deren Quell-Dokument eines der Themen hat.
  if (options?.topicIds && options.topicIds.length > 0) {
    conditions = and(
      conditions,
      inArray(
        wikiPages.source_document_id,
        db
          .select({ id: documentTopics.document_id })
          .from(documentTopics)
          .where(inArray(documentTopics.topic_id, options.topicIds)),
      ),
    )!;
  }

  const orderBy = (() => {
    switch (options?.sort) {
      case "updated_asc":
        return asc(wikiPages.updated_at);
      case "title_asc":
        return asc(wikiPages.title);
      case "title_desc":
        return desc(wikiPages.title);
      case "published_desc":
        return sql`${documents.published_at} desc nulls last`;
      case "published_asc":
        return sql`${documents.published_at} asc nulls last`;
      case "connections_desc":
        // Vernetzung = Summe ein-/ausgehender Links.
        return sql`(jsonb_array_length(${wikiPages.out_links}) + jsonb_array_length(${wikiPages.in_links})) desc`;
      case "updated_desc":
      default:
        return desc(wikiPages.updated_at);
    }
  })();

  // LEFT JOIN auf documents, damit Kanal/Datum/published-Sort funktionieren.
  // getTableColumns hält die Rückgabe auf die flache wikiPages-Form; zusätzlich
  // Titel/Typ des Quell-Dokuments, damit die UI zusammengehörige Artikel unter
  // ihrem Dokument gruppieren kann, ohne Dokumente separat nachzuladen.
  const rows = await db
    .select({
      ...getTableColumns(wikiPages),
      document_title: documents.title,
      document_type: documents.type,
      // Sitzungs-/Veröffentlichungsdatum und Kanal mitliefern: die Karten
      // zeigten bisher updated_at der Wiki-Seite, also den Zeitpunkt der
      // Generierung. Bei einem Bestand aus datierten Dokumenten ist das die
      // unwichtigste aller Datumsangaben.
      document_published_at: documents.published_at,
      document_channel: documents.channel,
    })
    .from(wikiPages)
    .leftJoin(documents, eq(wikiPages.source_document_id, documents.id))
    .where(conditions)
    .orderBy(orderBy)
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(wikiPages)
    .leftJoin(documents, eq(wikiPages.source_document_id, documents.id))
    .where(conditions);

  return {
    pages: rows,
    total: Number(countResult?.count || 0),
    page,
    page_size: pageSize,
  };
}

/** Meistverlinkte Konzepte (Ebene 3) – Einstiegspunkte für den Backlink-Filter. */
export async function topConcepts(workspaceId: string, limit = 20) {
  const rows = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      summary: wikiPages.summary,
      page_type: wikiPages.page_type,
      connections: sql<number>`jsonb_array_length(${wikiPages.in_links})`,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.workspace_id, workspaceId),
        eq(wikiPages.page_type, "concept"),
        // Entwürfe (z.B. Chat-Verbund vor Veröffentlichung) ausblenden.
        ne(wikiPages.status, "draft"),
      ),
    )
    .orderBy(desc(sql`jsonb_array_length(${wikiPages.in_links})`))
    .limit(limit);
  return rows.map((r) => ({ ...r, connections: Number(r.connections || 0) }));
}

/**
 * Graph-Daten (Graph-Tab). „Erst fokussieren, dann zeichnen": ohne Fokus werden
 * nur die meistverlinkten Konzepte als Einstiegs-Wolke geliefert; mit Fokus der
 * 1-Hop-Subgraph (Fokus + direkte Nachbarn) inkl. Kanten – klein & lesbar statt
 * 2600er-Hairball.
 */
export async function getGraph(
  workspaceId: string,
  opts: { focus?: string; types?: string[]; limit?: number },
) {
  const limit = opts.limit || 150;
  const toNode = (p: any) => ({
    slug: p.slug,
    title: p.title,
    type: p.page_type,
    summary: (p.summary || "").slice(0, 200),
    connections:
      ((p.out_links as string[]) || []).length +
      ((p.in_links as string[]) || []).length,
  });

  // Ohne Fokus: Einstiegs-Wolke aus Top-Konzepten (keine Kanten).
  if (!opts.focus) {
    const concepts = await topConcepts(workspaceId, Math.min(limit, 40));
    return {
      focus: null,
      nodes: concepts
        .filter((c) => c.connections > 0)
        .map((c) => ({
          slug: c.slug,
          title: c.title,
          type: c.page_type,
          summary: (c.summary || "").slice(0, 200),
          connections: c.connections,
        })),
      edges: [] as { source: string; target: string }[],
    };
  }

  const focus = await getPage(workspaceId, opts.focus);
  if (!focus) return { focus: opts.focus, nodes: [], edges: [] };

  // 1-Hop-Nachbarn = ein-/ausgehende Links.
  const neighborSlugs = Array.from(
    new Set([
      ...((focus.out_links as string[]) || []),
      ...((focus.in_links as string[]) || []),
    ]),
  ).slice(0, limit);

  const allSlugs = Array.from(new Set([focus.slug, ...neighborSlugs]));
  let rows =
    allSlugs.length > 0
      ? await db
          .select()
          .from(wikiPages)
          .where(
            and(
              eq(wikiPages.workspace_id, workspaceId),
              inArray(wikiPages.slug, allSlugs),
              ne(wikiPages.status, "draft"),
            ),
          )
      : [];

  // Optionaler Typ-Filter (Fokus bleibt immer enthalten).
  if (opts.types && opts.types.length > 0) {
    rows = rows.filter(
      (r) => r.slug === focus.slug || opts.types!.includes(r.page_type),
    );
  }

  const slugSet = new Set(rows.map((r) => r.slug));
  const edges: { source: string; target: string }[] = [];
  for (const r of rows) {
    for (const tgt of (r.out_links as string[]) || []) {
      if (slugSet.has(tgt)) edges.push({ source: r.slug, target: tgt });
    }
  }

  return { focus: focus.slug, nodes: rows.map(toNode), edges };
}

/**
 * Treffer je Monat über das Sitzungs-/Veröffentlichungsdatum des Quell-Dokuments.
 *
 * Grundlage der Zeitleisten-Facette: aus einer flachen Liste von mehreren
 * hundert Artikeln werden damit ~40 navigierbare Bündel. coalesce() hält
 * Altbestand ohne published_at sichtbar (dann zählt das Import-Datum).
 */
export async function monthFacets(
  workspaceId: string,
  opts?: { page_type?: string; channel?: string },
): Promise<{ month: string; count: number }[]> {
  const conds = [
    sql`${wikiPages.workspace_id} = ${workspaceId}`,
    sql`${wikiPages.status} <> 'draft'`,
    sql`${wikiPages.source_document_id} is not null`,
  ];
  if (opts?.page_type) {
    conds.push(sql`${wikiPages.page_type} = ${opts.page_type}`);
  }
  if (opts?.channel) {
    conds.push(sql`${documents.channel} = ${opts.channel}`);
  }

  const rows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', coalesce(${documents.published_at}, ${documents.created_at})), 'YYYY-MM')`,
      count: sql<number>`count(*)::int`,
    })
    .from(wikiPages)
    .innerJoin(documents, eq(wikiPages.source_document_id, documents.id))
    .where(and(...conds))
    .groupBy(
      sql`date_trunc('month', coalesce(${documents.published_at}, ${documents.created_at}))`,
    )
    .orderBy(
      sql`date_trunc('month', coalesce(${documents.published_at}, ${documents.created_at})) asc`,
    );

  return rows.filter((r) => r.month);
}

/**
 * Treffer je Auffälligkeits-Marker aus page_metadata.flags.
 * jsonb_array_elements_text entfaltet das Array, damit gezählt werden kann.
 */
export async function flagFacets(
  workspaceId: string,
): Promise<{ flag: string; count: number }[]> {
  const rows = await db.execute(sql`
    select f.flag, count(*)::int as count
    from ${wikiPages} w
    cross join lateral jsonb_array_elements_text(w.page_metadata -> 'flags') as f(flag)
    where w.workspace_id = ${workspaceId}
      and w.status <> 'draft'
      and jsonb_typeof(w.page_metadata -> 'flags') = 'array'
    group by f.flag
    order by count(*) desc, f.flag asc
  `);
  return (rows.rows ?? rows ?? []).map((r: any) => ({
    flag: String(r.flag),
    count: Number(r.count),
  }));
}

export async function getPage(workspaceId: string, slug: string) {
  const [page] = await db
    .select()
    .from(wikiPages)
    .where(
      and(eq(wikiPages.workspace_id, workspaceId), eq(wikiPages.slug, slug)),
    )
    .limit(1);
  return page || null;
}

export async function getPageById(id: string) {
  const [page] = await db
    .select()
    .from(wikiPages)
    .where(eq(wikiPages.id, id))
    .limit(1);
  return page || null;
}

export async function createPage(data: {
  workspace_id: string;
  slug: string;
  title: string;
  content?: string;
  summary?: string;
  page_type?: string;
  status?: string;
  source_document_id?: string;
  parent_slug?: string | null;
  sort_order?: number;
  created_by?: number;
  page_metadata?: Record<string, unknown>;
}) {
  const id = crypto.randomUUID();
  const [page] = await db
    .insert(wikiPages)
    .values({
      id,
      workspace_id: data.workspace_id,
      slug: data.slug,
      title: data.title,
      content: data.content || "",
      summary: data.summary || "",
      page_type: data.page_type || "article",
      status: data.status || "published",
      source_document_id: data.source_document_id || null,
      parent_slug: data.parent_slug || null,
      sort_order: data.sort_order || 0,
      created_by: data.created_by || null,
      page_metadata: data.page_metadata || {},
    })
    .returning();

  // Wiki-Content in Chunks syncen (für Chat-Suche)
  if (page.content) {
    await syncWikiPageToChunks(data.workspace_id, page.id, page.content);
  }

  return page;
}

export async function updatePage(
  workspaceId: string,
  slug: string,
  data: {
    title?: string;
    content?: string;
    summary?: string;
    page_type?: string;
    status?: string;
    out_links?: string[];
  },
  // Ebene 4: manual=true → Nutzer-Edit (Snapshot + Lock setzen). Ohne opts =
  // Auto-Update aus der Ingestion-Pipeline.
  opts?: { manual?: boolean; editedBy?: number },
) {
  const existing = await getPage(workspaceId, slug);
  if (!existing) return null;

  // Lock: Auto-Updates (Pipeline) überschreiben keine manuell editierten Seiten.
  if (!opts?.manual && (existing as any).manually_edited) {
    return existing;
  }

  // Versionshistorie: vor manueller Content-Änderung die alte Fassung sichern.
  if (opts?.manual && data.content !== undefined) {
    await db.insert(wikiPageRevisions).values({
      page_id: existing.id,
      workspace_id: workspaceId,
      version: existing.version,
      title: existing.title,
      summary: existing.summary,
      content: existing.content,
      edited_by: opts.editedBy ?? null,
    });
  }

  const updateData: Record<string, any> = { updated_at: new Date() };
  if (data.title !== undefined) updateData.title = data.title;
  if (data.content !== undefined) updateData.content = data.content;
  if (data.summary !== undefined) updateData.summary = data.summary;
  if (data.page_type !== undefined) updateData.page_type = data.page_type;
  if (data.status !== undefined) updateData.status = data.status;
  if (data.out_links !== undefined) updateData.out_links = data.out_links;
  if (data.content !== undefined) updateData.version = sql`version + 1`;
  if (opts?.manual) {
    updateData.manually_edited = true;
    if (opts.editedBy) updateData.updated_by = opts.editedBy;
  }

  const [page] = await db
    .update(wikiPages)
    .set(updateData)
    .where(
      and(eq(wikiPages.workspace_id, workspaceId), eq(wikiPages.slug, slug)),
    )
    .returning();

  // Bei Content-Änderung: Chunks neu syncen
  if (page && data.content !== undefined) {
    await syncWikiPageToChunks(workspaceId, page.id, page.content);
  }

  return page || null;
}

/**
 * Setzt die Struktur-Felder (Eltern-Slug + Kapitelnummer) einer Seite.
 * Bewusst getrennt von `updatePage`: Hierarchie ist Struktur, kein Inhalt – sie
 * wird deshalb auch bei manuell editierten (gelockten) Seiten geschrieben und
 * erzeugt keine neue Version und keinen Revisions-Snapshot.
 */
export async function setPageHierarchy(
  workspaceId: string,
  slug: string,
  data: { parent_slug: string | null; sort_order: number },
) {
  const [page] = await db
    .update(wikiPages)
    .set({ parent_slug: data.parent_slug, sort_order: data.sort_order })
    .where(
      and(eq(wikiPages.workspace_id, workspaceId), eq(wikiPages.slug, slug)),
    )
    .returning();
  return page || null;
}

// Ebene 4: Versionshistorie ----

export async function listRevisions(workspaceId: string, slug: string) {
  const page = await getPage(workspaceId, slug);
  if (!page) return [];
  return await db
    .select()
    .from(wikiPageRevisions)
    .where(eq(wikiPageRevisions.page_id, page.id))
    .orderBy(desc(wikiPageRevisions.created_at));
}

/** Stellt eine frühere Fassung wieder her (die aktuelle wird zuvor als Revision gesichert). */
export async function restoreRevision(
  workspaceId: string,
  slug: string,
  revisionId: number,
  editedBy?: number,
) {
  const [rev] = await db
    .select()
    .from(wikiPageRevisions)
    .where(eq(wikiPageRevisions.id, revisionId))
    .limit(1);
  if (!rev) return null;
  // updatePage(manual) sichert die aktuelle Fassung und setzt die alte ein.
  return await updatePage(
    workspaceId,
    slug,
    { title: rev.title, summary: rev.summary, content: rev.content },
    { manual: true, editedBy },
  );
}

export async function deletePage(workspaceId: string, slug: string) {
  // Erst die Seite laden (für Chunk-Löschung)
  const [page] = await db
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(
      and(eq(wikiPages.workspace_id, workspaceId), eq(wikiPages.slug, slug)),
    )
    .limit(1);

  // Auch eingehende Links bei anderen Seiten entfernen
  await db
    .update(wikiPages)
    .set({
      in_links: sql`array_remove(in_links, ${slug})`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(wikiPages.workspace_id, workspaceId),
        sql`${slug} = ANY(in_links)`,
      ),
    );

  // Revisionen entfernen (FK ohne Cascade), sonst Constraint-Fehler beim Löschen.
  if (page?.id) {
    await db
      .delete(wikiPageRevisions)
      .where(eq(wikiPageRevisions.page_id, page.id));
  }

  await db
    .delete(wikiPages)
    .where(
      and(eq(wikiPages.workspace_id, workspaceId), eq(wikiPages.slug, slug)),
    );

  // Wiki-Chunks aufräumen
  if (page?.id) {
    await deleteWikiPageChunks(workspaceId, page.id);
  }
}

// --- Chat-Verbund (Draft-Cluster) ---

/** Alle Seiten eines Chat-Verbunds (Cluster), Hauptseite zuerst. */
export async function listClusterDrafts(workspaceId: string, clusterId: string) {
  const rows = await db
    .select(getTableColumns(wikiPages))
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.workspace_id, workspaceId),
        sql`${wikiPages.page_metadata}->>'cluster_id' = ${clusterId}`,
      ),
    )
    .orderBy(desc(sql`${wikiPages.page_metadata}->>'is_main'`), asc(wikiPages.title));
  return rows;
}

/** Offene Entwurfs-Verbünde eines Workspace (gruppiert nach cluster_id) –
 * damit der Wiki-Browser auf noch nicht veröffentlichte Chat-Verbünde hinweisen
 * und zurück ins Review verlinken kann. */
export async function listDraftClusters(workspaceId: string) {
  const rows = await db
    .select({
      title: wikiPages.title,
      created_at: wikiPages.created_at,
      page_metadata: wikiPages.page_metadata,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.workspace_id, workspaceId),
        eq(wikiPages.status, "draft"),
      ),
    );

  const map = new Map<
    string,
    { cluster_id: string; title: string; count: number; created_at: Date }
  >();
  for (const r of rows) {
    const meta = (r.page_metadata as any) || {};
    const cid = meta.cluster_id;
    if (!cid) continue;
    let entry = map.get(cid);
    if (!entry) {
      entry = { cluster_id: cid, title: r.title, count: 0, created_at: r.created_at };
      map.set(cid, entry);
    }
    entry.count++;
    if (meta.is_main) entry.title = r.title;
    if (r.created_at < entry.created_at) entry.created_at = r.created_at;
  }
  return Array.from(map.values()).sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );
}

/** Alle (noch nicht veröffentlichten, nicht handeditierten) Draft-Seiten einer
 * Chat-Session löschen – für "Regenerieren = ersetzen". */
export async function deleteSessionDrafts(
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  const rows = await db
    .select({ slug: wikiPages.slug })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.workspace_id, workspaceId),
        eq(wikiPages.status, "draft"),
        eq(wikiPages.manually_edited, false),
        sql`${wikiPages.page_metadata}->>'chat_session_id' = ${sessionId}`,
      ),
    );
  for (const r of rows) {
    await deletePage(workspaceId, r.slug);
  }
  return rows.length;
}

/** Einen Chat-Verbund veröffentlichen: alle Draft-Seiten auf published setzen. */
export async function publishCluster(
  workspaceId: string,
  clusterId: string,
): Promise<number> {
  const res = await db
    .update(wikiPages)
    .set({ status: "published", updated_at: new Date() })
    .where(
      and(
        eq(wikiPages.workspace_id, workspaceId),
        eq(wikiPages.status, "draft"),
        sql`${wikiPages.page_metadata}->>'cluster_id' = ${clusterId}`,
      ),
    )
    .returning({ slug: wikiPages.slug });
  return res.length;
}

// --- Wiki-Link Resolution ---

export async function resolveLinks(
  workspaceId: string,
  content: string,
): Promise<{ out_links: string[]; content: string }> {
  const linkRegex = /\[\[([^\]]+)\]\]/g;
  const slugs: string[] = [];
  let match;

  while ((match = linkRegex.exec(content)) !== null) {
    const parts = match[1].split("|");
    const slug = parts[0].trim();
    if (!slugs.includes(slug)) slugs.push(slug);
  }

  // Nur existierende Slugs als out_links speichern
  if (slugs.length === 0) return { out_links: [], content };
  const existing = await db
    .select({ slug: wikiPages.slug })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.workspace_id, workspaceId),
        inArray(wikiPages.slug, slugs),
      ),
    );

  const existingSlugs = existing.map((r) => r.slug);

  return { out_links: existingSlugs, content };
}

export async function updateIncomingLinks(
  workspaceId: string,
  slug: string,
  outLinks: string[],
) {
  // Für jede verlinkte Seite: in_links aktualisieren
  for (const targetSlug of outLinks) {
    const targetPage = await getPage(workspaceId, targetSlug);
    if (targetPage) {
      const currentInLinks: string[] = Array.isArray(targetPage.in_links)
        ? targetPage.in_links
        : [];
      if (!currentInLinks.includes(slug)) {
        await db
          .update(wikiPages)
          .set({
            in_links: [...currentInLinks, slug],
            updated_at: new Date(),
          })
          .where(
            and(
              eq(wikiPages.workspace_id, workspaceId),
              eq(wikiPages.slug, targetSlug),
            ),
          );
      }
    }
  }
}

// --- Wiki Stats ---

export async function getStats(workspaceId: string) {
  // Entwürfe (unveröffentlichte Chat-Verbünde) zählen nicht mit – sonst weicht
  // die Statistik von der (published-gefilterten) Wiki-Liste ab.
  const published = and(
    eq(wikiPages.workspace_id, workspaceId),
    ne(wikiPages.status, "draft"),
  );

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(wikiPages)
    .where(published);

  const typeResult = await db
    .select({ type: wikiPages.page_type, count: sql<number>`count(*)` })
    .from(wikiPages)
    .where(published)
    .groupBy(wikiPages.page_type);

  const recent = await db
    .select()
    .from(wikiPages)
    .where(published)
    .orderBy(desc(wikiPages.updated_at))
    .limit(5);

  const pagesByType: Record<string, number> = {};
  for (const r of typeResult) {
    pagesByType[r.type] = Number(r.count);
  }

  return {
    total_pages: Number(countResult?.count || 0),
    pages_by_type: pagesByType,
    total_links: 0, // TODO: berechnen
    recent_updates: recent,
  };
}

// --- WeKnora Import ---

export interface WeKnoraPage {
  id?: string;
  knowledge_base_id?: string;
  slug: string;
  title: string;
  summary?: string;
  content?: string;
  page_type?: string;
  status?: string;
  out_links?: string[];
  in_links?: string[];
  aliases?: string[];
  source_refs?: string[];
  page_metadata?: Record<string, any>;
  version?: number;
  created_at?: string;
  updated_at?: string;
}

const PAGE_TYPE_MAP: Record<string, string> = {
  entity: "entity",
  concept: "concept",
  article: "article",
  index: "index",
  log: "log",
  synthesis: "synthesis",
  comparison: "comparison",
  youtube_transcript: "youtube_transcript",
};

function mapPageType(type: string | undefined): string {
  if (!type) return "article";
  const lower = type.toLowerCase();
  return PAGE_TYPE_MAP[lower] || "article";
}

export async function importWeKnoraPages(
  workspaceId: string,
  pages: WeKnoraPage[],
  createdBy: number,
): Promise<{
  imported: number;
  skipped: number;
  errors: string[];
  pages: any[];
}> {
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];
  const importedPages: any[] = [];

  // Bestehende Slugs abrufen
  const existing = await listPages(workspaceId, { page_size: 500 });
  const existingSlugs = new Set(existing.pages.map((p) => p.slug));

  for (const wp of pages) {
    try {
      // Slug generieren – falls schon vorhanden, counter anhängen
      let slug = wp.slug?.trim();
      if (!slug) {
        slug = wp.title
          .toLowerCase()
          .replace(/[^a-z0-9äöüß]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 200);
      }
      if (!slug) {
        errors.push(`Page "${wp.title}" has no valid slug – skipped`);
        skipped++;
        continue;
      }

      // Prüfen ob bereits importiert
      if (existingSlugs.has(slug)) {
        // Slug mit Suffix
        let counter = 1;
        while (existingSlugs.has(`${slug}-${counter}`)) counter++;
        slug = `${slug}-${counter}`;
      }

      existingSlugs.add(slug);

      const page = await createPage({
        workspace_id: workspaceId,
        slug,
        title: wp.title || slug,
        content: wp.content || "",
        summary: wp.summary || "",
        page_type: mapPageType(wp.page_type),
        source_document_id: null,
        created_by: createdBy,
      });

      // Aliases, source_refs, page_metadata setzen
      if (
        (wp.aliases && wp.aliases.length > 0) ||
        (wp.source_refs && wp.source_refs.length > 0) ||
        (wp.page_metadata && Object.keys(wp.page_metadata).length > 0)
      ) {
        await db
          .update(wikiPages)
          .set({
            aliases: wp.aliases || [],
            source_refs: wp.source_refs || [],
            page_metadata: wp.page_metadata || {},
            updated_at: new Date(),
          })
          .where(
            and(
              eq(wikiPages.workspace_id, workspaceId),
              eq(wikiPages.slug, slug),
            ),
          );
      }

      // out_links aus Content extrahieren
      const { out_links } = await resolveLinks(workspaceId, page.content);
      const combinedLinks = [
        ...new Set([...out_links, ...(wp.out_links || [])]),
      ];

      if (combinedLinks.length > 0) {
        await updatePage(workspaceId, slug, { out_links: combinedLinks });
        await updateIncomingLinks(workspaceId, slug, combinedLinks);
      }

      importedPages.push({ ...page, slug });
      imported++;
    } catch (e: any) {
      errors.push(`Error importing "${wp.title || wp.slug}": ${e.message}`);
      skipped++;
    }
  }

  return { imported, skipped, errors, pages: importedPages };
}

// --- Wiki Generation via LLM ---

export async function generateWikiPage(
  workspaceId: string,
  documentId: string,
  existingSlugs: string[],
): Promise<Array<{
  slug: string;
  title: string;
  summary: string;
  content: string;
  page_type: string;
}> | null> {
  const t0 = Date.now();
  console.log(`[wiki] ========== generateWikiPage START ==========`);
  console.log(`[wiki] Document ID: ${documentId}`);
  console.log(`[wiki] Workspace ID: ${workspaceId}`);
  console.log(`[wiki] Existing slugs: ${existingSlugs.length}`);

  // Dokument laden
  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!doc || !doc.content) {
    console.log(`[wiki] ❌ Dokument nicht gefunden oder leer (${documentId})`);
    return null;
  }
  console.log(
    `[wiki] Dokument geladen: "${doc.title}" (${doc.content.length} Zeichen)`,
  );

  // Aktiven Chat-Provider laden
  const providers = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.is_active, true),
        eq(modelProviders.provider_type, "chat"),
      ),
    )
    .limit(1);

  let provider = providers[0];
  if (!provider) {
    const both = await db
      .select()
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.is_active, true),
          eq(modelProviders.provider_type, "both"),
        ),
      )
      .limit(1);
    provider = both[0];
  }

  if (!provider) {
    console.warn(
      "[wiki] ❌ Kein Chat-Provider für Wiki-Generierung konfiguriert",
    );
    return null;
  }

  console.log(
    `[wiki] LLM-Provider: ${provider.provider_name || provider.provider_type} (${provider.default_model})`,
  );
  console.log(`[wiki] API-Base: ${provider.api_base_url}`);

  // Wiki-Seiten als Kontext für Verlinkungen (nur aus diesem Dokument)
  const existingPages =
    existingSlugs.length > 0
      ? await db
          .select({ slug: wikiPages.slug, title: wikiPages.title })
          .from(wikiPages)
          .where(
            and(
              eq(wikiPages.workspace_id, workspaceId),
              eq(wikiPages.source_document_id, documentId),
              inArray(wikiPages.slug, existingSlugs),
            ),
          )
      : [];

  const pagesContext = existingPages
    .map((p) => `  - [[${p.slug}|${p.title}]]`)
    .join("\n");

  // Ungefähre Videolänge aus dem Titel/Inhalt schätzen
  // Fallback: 1000 Zeichen ≈ 10 Minuten Transkript
  const estimatedHours = Math.max(0.1, doc.content.length / 60000);

  const systemPrompt = `Du bist ein Wiki-Autor. Erstelle aus dem folgenden YouTube-Transkript **zwei** separate Wiki-Artikel auf Deutsch.

## WICHTIGE PRIORISIERUNG
Die YouTube-Metadaten (Titel, Kanal, Beschreibung) haben die HÖCHSTE Priorität für:
- Korrekte Schreibweise von Namen, Begriffen und Gesprächspartnern
- Kontext und Einordnung des Gesprächs
Diese Metadaten stehen ganz oben im Quelldokument und sind massgeblich.

## ARTIKEL 1 – Vollständiger Inhalt (Tag: VOLLSTAENDIG)
- Erfasst das GESAMTE Gespräch mit ALLEN Argumenten, Thesen, Details und Inhalten
- Vollständig, keine Kürzung, kein Weglassen von Argumenten
- Geschätzte Videolänge: ~${estimatedHours.toFixed(1)}h → angemessene Länge wählen
- Struktur mit ## Überschriften, die den Gesprächsverlauf abbilden

## ARTIKEL 2 – Zusammenfassung (Tag: ZUSAMMENFASSUNG)
- Konzentriert sich auf die 5-10 wichtigsten Thesen und Kernaussagen
- Maximal 1000-1500 Wörter, unabhängig von der Videolänge
- Struktur: ## Wichtigste Thesen als Bullet-Points mit kurzer Erklärung

## FORMAT (genau einhalten – jede Abweichung macht den Artikel unbrauchbar)

=== ARTIKEL 1: VOLLSTAENDIG ===
SUMMARY: {Ein Satz, 15-40 Wörter}
# {Titel des vollständigen Artikels}
{Inhalt als Markdown}

=== ARTIKEL 2: ZUSAMMENFASSUNG ===
SUMMARY: {Ein Satz, 15-40 Wörter}
# {Titel der Zusammenfassung}
{Inhalt als Markdown}

## REGELN FÜR BEIDE ARTIKEL
- Sprache: Deutsch
- Verlinke zu existierenden Seiten mit [[slug|Titel]]
- Maximal 6000 Tokens pro Artikel
- KEINE einleitenden Erklärungen oder Meta-Kommentare – nur die beiden Artikel im angegebenen Format

VORHANDENE SEITEN (für Verlinkungen):
${pagesContext || "Keine vorhanden."}

## QUELLDOKUMENT
YouTube-Metadaten + vollständiges Transkript:
${doc.content}`;

  try {
    console.log(
      `[wiki] Sende Prompt an LLM (${provider.default_model}, max_tokens=4096, timeout=60s)...`,
    );
    const llmT0 = Date.now();
    const response = await fetch(`${provider.api_base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.api_key_encrypted}`,
      },
      body: JSON.stringify({
        model: provider.default_model,
        messages: [{ role: "user", content: systemPrompt }],
        max_tokens: 8192,
      }),
      signal: AbortSignal.timeout(60000),
    });

    const llmElapsed = Date.now() - llmT0;
    console.log(
      `[wiki] LLM antwortete nach ${llmElapsed}ms (Status: ${response.status})`,
    );

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.warn(
        `[wiki] ❌ LLM error: ${response.status} – ${errBody.slice(0, 200)}`,
      );
      return null;
    }

    const data = await response.json();
    const fullText = data?.choices?.[0]?.message?.content || "";
    console.log(`[wiki] LLM-Antwort: ${fullText.length} Zeichen`);
    // Ersten 500 Zeichen für Debugging loggen
    console.log(
      `[wiki] LLM-Antwort-Preview: ${fullText.slice(0, 500).replace(/\n/g, "\\n")}`,
    );

    if (!fullText) {
      console.warn(`[wiki] ❌ Leere LLM-Antwort`);
      return null;
    }

    // Zwei Artikel parsen (getrennt durch === ARTIKEL 2 oder === ZUSAMMENFASSUNG)
    // Akzeptiere verschiedene Schreibweisen:
    // === ARTIKEL 2 ===, === ARTIKEL 2: ZUSAMMENFASSUNG ===, === ZUSAMMENFASSUNG ===
    const articleSplitter =
      /===?\s*(?:ARTIKEL\s*2|ZUSAMMENFASSUNG)\s*:?\s*(?:ZUSAMMENFASSUNG)?\s*===?/i;
    const parts = fullText.split(articleSplitter);
    const rawArticle1 = parts[0] || "";
    const rawArticle2 = parts[1] || "";

    console.log(`[wiki] Artikel 1 Rohdaten: ${rawArticle1.length} Zeichen`);
    console.log(`[wiki] Artikel 2 Rohdaten: ${rawArticle2.length} Zeichen`);

    function parseArticle(
      raw: string,
      fallbackTitle: string,
      index: number,
    ): { summary: string; title: string; content: string } | null {
      const summaryMatch = raw.match(/SUMMARY:\s*(.+)/im);
      const summary = summaryMatch ? summaryMatch[1].trim() : "";

      // SUMMARY-Zeile aus Content entfernen
      let content = raw.replace(/SUMMARY:\s*.+(\r?\n|$)/i, "").trim();

      // Marker entfernen (=== ARTIKEL 1: VOLLSTAENDIG ===, etc.)
      content = content
        .replace(
          /===?\s*ARTIKEL\s*\d\s*:?\s*(VOLLSTAENDIG|ZUSAMMENFASSUNG)?\s*===?/gi,
          "",
        )
        .replace(/===?\s*(VOLLSTAENDIG|ZUSAMMENFASSUNG)\s*===?/gi, "")
        .trim();

      if (!content) {
        console.warn(`[wiki] Artikel ${index}: kein Inhalt gefunden`);
        return null;
      }

      const titleMatch = content.match(/^#\s+(.+)/m);
      const title = titleMatch
        ? titleMatch[1].trim()
        : `${fallbackTitle} (Teil ${index})`;

      console.log(
        `[wiki] Artikel ${index} geparst: "${title}" (${content.length} Zeichen, summary=${summary.slice(0, 60)})`,
      );
      return { summary, title, content };
    }

    const results: Array<{
      slug: string;
      title: string;
      summary: string;
      content: string;
      page_type: string;
    }> = [];

    const article1 = parseArticle(rawArticle1, doc.title, 1);
    const article2 = parseArticle(rawArticle2, doc.title, 2);

    // Hilfsfunktion: Slug aus Titel mit Prefix, vermeidet Doppelung
    function makeSlug(title: string, prefix: string): string {
      let t = title.toLowerCase().trim();
      // Prefix aus dem Titel entfernen falls vorhanden
      t = t.replace(new RegExp(`^${prefix}[\\s:-]+`, "i"), "");
      t = t.replace(/^vollstaendig[\s:-]+/i, "");
      t = t.replace(/^zusammenfassung[\s:-]+/i, "");
      return (
        prefix +
        "-" +
        t
          .replace(/[^a-z0-9äöüß\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .slice(0, 80)
      );
    }

    if (article1) {
      const slug = makeSlug(article1.title, "vollstaendig");

      // Cross-Link zwischen den Artikeln einfügen
      let content = article1.content;
      if (article2?.title) {
        const summarySlug = makeSlug(article2.title, "zusammenfassung");
        if (!content.includes(`[[${summarySlug}]]`)) {
          content += `\n\n---\n📄 **Zusammenfassung**: [[${summarySlug}|Zusammenfassung dieses Artikels]]`;
        }
      }

      console.log(
        `[wiki] ✅ Artikel 1 (vollstaendig): "${article1.title}" (${content.length} Zeichen)`,
      );
      results.push({
        slug,
        title: article1.title,
        summary: article1.summary,
        content,
        page_type: "vollstaendig",
      });
    }

    if (article2) {
      const slug = makeSlug(article2.title, "zusammenfassung");

      // Cross-Link zum vollständigen Artikel
      let content = article2.content;
      if (results.length > 0) {
        const fullSlug = results[0].slug;
        if (!content.includes(`[[${fullSlug}]]`)) {
          content = `📄 **Vollständiger Artikel**: [[${fullSlug}|Vollständiger Inhalt]]\n\n${content}`;
        }
      }

      console.log(
        `[wiki] ✅ Artikel 2 (zusammenfassung): "${article2.title}" (${content.length} Zeichen)`,
      );
      results.push({
        slug,
        title: article2.title,
        summary: article2.summary,
        content,
        page_type: "zusammenfassung",
      });
    }

    console.log(
      `[wiki] ========== generateWikiPage ENDE (${Date.now() - t0}ms, ${results.length} Artikel) ==========`,
    );
    return results.length > 0 ? results : null;
  } catch (e: any) {
    console.error(`[wiki] ❌ Generation error:`, e.message);
    console.log(
      `[wiki] ========== generateWikiPage FEHLER (${Date.now() - t0}ms) ==========`,
    );
    return null;
  }
}

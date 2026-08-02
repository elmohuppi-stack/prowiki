// Verschieben eines Dokuments samt der daraus generierten Wiki-Artikel in einen
// anderen Workspace.
//
// Was mitwandert:
//   documents, chunks (Dokument-Chunks + die "wiki--<page-id>"-Chunks der
//   mitwandernden Seiten), wiki_pages (page_type summary/article mit
//   source_document_id = doc), wiki_page_revisions, activity_logs,
//   document_topics (auf gleichnamige Topics im Ziel gemappt).
//
// Was NICHT mitwandert: Entity- und Concept-Seiten. Die entstehen beim
// Wiki-Generieren dokumentübergreifend – existiert ein Slug bereits, wird die
// Seite gemerged statt neu angelegt, und ihre chunk_refs sammeln sich über
// mehrere Dokumente an (siehe wiki-generate.ts, upsertPage). source_document_id
// zeigt dabei nur auf das ERSTE Dokument und taugt nicht als Besitznachweis.
// Sie bleiben deshalb im Quell-Workspace; Links der verschobenen Seiten auf sie
// werden zu Klartext aufgelöst (stripDeadLinks).
//
// Embeddings müssen nicht neu berechnet werden: der Embedding-Provider wird
// global gewählt (service/embedding.ts) und das Dokument-Chunking ignoriert die
// workspace-eigene chunk_size (router/document.ts, scheduleChunking). Sobald
// eines von beidem workspace-spezifisch wird, muss hier neu embedded werden.

import { db } from "../db/index.ts";
import {
  documents,
  documentTopics,
  topics,
  chunks,
  wikiPages,
  wikiPageRevisions,
  activityLogs,
  workspaces,
} from "../db/schema.ts";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { stripDeadLinks } from "./wiki-generate.ts";

/** Seitentypen, die eindeutig zu genau einem Dokument gehören. */
const MOVABLE_PAGE_TYPES = ["summary", "article"];

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface MovePreview {
  document: { id: string; title: string };
  source_workspace: { id: string; name: string };
  target_workspace: { id: string; name: string };
  chunk_count: number;
  wiki_chunk_count: number;
  moving_pages: { slug: string; title: string; page_type: string }[];
  staying_pages: { slug: string; title: string; page_type: string }[];
  slug_conflicts: string[];
  dead_links: string[];
  topics: { slug: string; label: string; exists_in_target: boolean }[];
}

/** Alle Seiten, die mit dem Dokument umziehen. */
async function loadMovingPages(runner: Tx | typeof db, documentId: string) {
  return await runner
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      page_type: wikiPages.page_type,
      content: wikiPages.content,
      parent_slug: wikiPages.parent_slug,
      out_links: wikiPages.out_links,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.source_document_id, documentId),
        inArray(wikiPages.page_type, MOVABLE_PAGE_TYPES),
      ),
    );
}

/** Seiten, die auf das Dokument zeigen, aber im Quell-Workspace bleiben. */
async function loadStayingPages(runner: Tx | typeof db, documentId: string) {
  return await runner
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      page_type: wikiPages.page_type,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.source_document_id, documentId),
        notInArray(wikiPages.page_type, MOVABLE_PAGE_TYPES),
      ),
    );
}

function extractLinkedSlugs(content: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content || "")) !== null) {
    const slug = m[1].trim();
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * Zeigt, was ein Verschieben bewirken würde – ohne etwas zu ändern.
 */
export async function previewMove(
  documentId: string,
  targetWorkspaceId: string,
): Promise<MovePreview | { error: string }> {
  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!doc) return { error: "Document not found" };
  if (doc.workspace_id === targetWorkspaceId) {
    return { error: "Dokument liegt bereits in diesem Workspace" };
  }

  const [source] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, doc.workspace_id))
    .limit(1);
  const [target] = await db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, targetWorkspaceId))
    .limit(1);
  if (!target) return { error: "Ziel-Workspace nicht gefunden" };

  const movingPages = await loadMovingPages(db, documentId);
  const stayingPages = await loadStayingPages(db, documentId);
  const movingSlugs = movingPages.map((p) => p.slug);
  const movingPageIds = movingPages.map((p) => p.id);

  const [{ count: chunkCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chunks)
    .where(eq(chunks.document_id, documentId));

  let wikiChunkCount = 0;
  if (movingPageIds.length > 0) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(chunks)
      .where(
        inArray(
          chunks.document_id,
          movingPageIds.map((id) => `wiki--${id}`),
        ),
      );
    wikiChunkCount = row?.count ?? 0;
  }

  // Slug-Konflikte im Ziel (bei summary-<doc-uuid> praktisch ausgeschlossen,
  // bei manuell angelegten Artikeln aber möglich).
  let slugConflicts: string[] = [];
  if (movingSlugs.length > 0) {
    const existing = await db
      .select({ slug: wikiPages.slug })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.workspace_id, targetWorkspaceId),
          inArray(wikiPages.slug, movingSlugs),
        ),
      );
    slugConflicts = existing.map((r) => r.slug);
  }

  // Links der wandernden Seiten, die im Ziel ins Leere zeigen würden.
  const linked = new Set<string>();
  for (const p of movingPages) {
    for (const s of extractLinkedSlugs(p.content || "")) linked.add(s);
  }
  const linkedSlugs = [...linked].filter((s) => !movingSlugs.includes(s));
  let deadLinks: string[] = linkedSlugs;
  if (linkedSlugs.length > 0) {
    const alive = await db
      .select({ slug: wikiPages.slug })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.workspace_id, targetWorkspaceId),
          inArray(wikiPages.slug, linkedSlugs),
        ),
      );
    const aliveSet = new Set(alive.map((r) => r.slug));
    deadLinks = linkedSlugs.filter((s) => !aliveSet.has(s));
  }

  // Themen und ob es sie im Ziel schon gibt
  const docTopics = await db
    .select({ slug: topics.slug, label: topics.label })
    .from(documentTopics)
    .innerJoin(topics, eq(documentTopics.topic_id, topics.id))
    .where(eq(documentTopics.document_id, documentId));

  const topicSlugs = docTopics.map((t) => t.slug);
  let existingTargetTopics = new Set<string>();
  if (topicSlugs.length > 0) {
    const rows = await db
      .select({ slug: topics.slug })
      .from(topics)
      .where(
        and(
          eq(topics.workspace_id, targetWorkspaceId),
          inArray(topics.slug, topicSlugs),
        ),
      );
    existingTargetTopics = new Set(rows.map((r) => r.slug));
  }

  return {
    document: { id: doc.id, title: doc.title },
    source_workspace: {
      id: source?.id ?? doc.workspace_id,
      name: source?.name ?? "",
    },
    target_workspace: { id: target.id, name: target.name },
    chunk_count: chunkCount ?? 0,
    wiki_chunk_count: wikiChunkCount,
    moving_pages: movingPages.map((p) => ({
      slug: p.slug,
      title: p.title,
      page_type: p.page_type,
    })),
    staying_pages: stayingPages,
    slug_conflicts: slugConflicts,
    dead_links: deadLinks,
    topics: docTopics.map((t) => ({
      slug: t.slug,
      label: t.label,
      exists_in_target: existingTargetTopics.has(t.slug),
    })),
  };
}

/**
 * Verschiebt das Dokument samt zugehöriger Wiki-Artikel in einer Transaktion.
 */
export async function moveDocument(
  documentId: string,
  targetWorkspaceId: string,
) {
  return await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!doc) throw new Error("Document not found");

    const sourceWorkspaceId = doc.workspace_id;
    if (sourceWorkspaceId === targetWorkspaceId) {
      throw new Error("Dokument liegt bereits in diesem Workspace");
    }

    const movingPages = await loadMovingPages(tx, documentId);
    const movingPageIds = movingPages.map((p) => p.id);
    const originalSlugs = movingPages.map((p) => p.slug);

    // --- 1. Slug-Konflikte im Ziel auflösen ---------------------------------
    const renameMap = new Map<string, string>();
    if (originalSlugs.length > 0) {
      const taken = new Set(
        (
          await tx
            .select({ slug: wikiPages.slug })
            .from(wikiPages)
            .where(eq(wikiPages.workspace_id, targetWorkspaceId))
        ).map((r) => r.slug),
      );
      for (const slug of originalSlugs) {
        if (!taken.has(slug)) {
          taken.add(slug);
          continue;
        }
        let n = 2;
        let candidate = `${slug}-${n}`;
        while (taken.has(candidate)) {
          n += 1;
          candidate = `${slug}-${n}`;
        }
        taken.add(candidate);
        renameMap.set(slug, candidate);
      }
    }
    const finalSlug = (slug: string) => renameMap.get(slug) ?? slug;
    const movedSlugSet = new Set(originalSlugs.map(finalSlug));

    // --- 2. Gültige Ziel-Slugs für die Dead-Link-Bereinigung ----------------
    const targetSlugs = new Set(
      (
        await tx
          .select({ slug: wikiPages.slug })
          .from(wikiPages)
          .where(eq(wikiPages.workspace_id, targetWorkspaceId))
      ).map((r) => r.slug),
    );
    for (const s of movedSlugSet) targetSlugs.add(s);

    // --- 3. Wiki-Seiten umziehen -------------------------------------------
    for (const page of movingPages) {
      // Inhalt: Umbenennungen innerhalb des Umzugsguts nachziehen, danach alles
      // entfernen, was im Ziel nicht existiert.
      let content = page.content || "";
      for (const [from, to] of renameMap) {
        content = content.replaceAll(`[[${from}]]`, `[[${to}]]`);
        content = content.replaceAll(`[[${from}|`, `[[${to}|`);
      }
      content = stripDeadLinks(content, targetSlugs);

      const outLinks = extractLinkedSlugs(content).filter((s) =>
        targetSlugs.has(s),
      );

      // parent_slug zeigt per Slug auf die Übersichtsseite. Zeigt er auf eine
      // Seite, die nicht mitwandert, verliert das Kapitel seine Hierarchie.
      const parent = page.parent_slug ? finalSlug(page.parent_slug) : null;
      const parentSlug = parent && movedSlugSet.has(parent) ? parent : null;

      await tx
        .update(wikiPages)
        .set({
          workspace_id: targetWorkspaceId,
          slug: finalSlug(page.slug),
          content,
          out_links: outLinks,
          in_links: [],
          parent_slug: parentSlug,
          updated_at: new Date(),
        })
        .where(eq(wikiPages.id, page.id));
    }

    if (movingPageIds.length > 0) {
      await tx
        .update(wikiPageRevisions)
        .set({ workspace_id: targetWorkspaceId })
        .where(inArray(wikiPageRevisions.page_id, movingPageIds));
    }

    // --- 4. Quell-Workspace aufräumen: Verweise auf die weggezogenen Slugs --
    // in_links/out_links sind jsonb-Arrays; die verwaisten Einträge werden
    // herausgefiltert. Der Fließtext der zurückbleibenden Seiten wird bewusst
    // nicht angefasst.
    if (originalSlugs.length > 0) {
      for (const column of ["in_links", "out_links"] as const) {
        // Nur Seiten anfassen, die tatsächlich einen der Slugs führen – sonst
        // bekäme der ganze Workspace ein neues updated_at und die Sortierung
        // nach "zuletzt geändert" wäre entwertet.
        await tx.execute(sql`
          UPDATE wiki_pages
          SET ${sql.raw(column)} = COALESCE((
                SELECT jsonb_agg(e)
                FROM jsonb_array_elements_text(${sql.raw(column)}) AS e
                WHERE e <> ALL(${originalSlugs})
              ), '[]'::jsonb),
              updated_at = now()
          WHERE workspace_id = ${sourceWorkspaceId}
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(${sql.raw(column)}) AS e
              WHERE e = ANY(${originalSlugs})
            )
        `);
      }
    }

    // --- 5. Eingehende Links im Ziel neu aufbauen ---------------------------
    for (const page of movingPages) {
      const slug = finalSlug(page.slug);
      const [current] = await tx
        .select({ out_links: wikiPages.out_links })
        .from(wikiPages)
        .where(eq(wikiPages.id, page.id))
        .limit(1);
      const outLinks: string[] = Array.isArray(current?.out_links)
        ? (current!.out_links as string[])
        : [];
      if (outLinks.length === 0) continue;

      await tx.execute(sql`
        UPDATE wiki_pages
        SET in_links = CASE
              WHEN in_links @> ${JSON.stringify([slug])}::jsonb THEN in_links
              ELSE COALESCE(in_links, '[]'::jsonb) || ${JSON.stringify([slug])}::jsonb
            END,
            updated_at = now()
        WHERE workspace_id = ${targetWorkspaceId}
          AND slug = ANY(${outLinks})
      `);
    }

    // --- 6. Chunks umziehen (Dokument + Wiki-Seiten) ------------------------
    await tx
      .update(chunks)
      .set({ workspace_id: targetWorkspaceId })
      .where(eq(chunks.document_id, documentId));

    if (movingPageIds.length > 0) {
      await tx
        .update(chunks)
        .set({ workspace_id: targetWorkspaceId })
        .where(
          inArray(
            chunks.document_id,
            movingPageIds.map((id) => `wiki--${id}`),
          ),
        );
    }

    // --- 7. Themen auf den Ziel-Workspace mappen ----------------------------
    const docTopics = await tx
      .select({
        assignment_id: documentTopics.id,
        slug: topics.slug,
        label: topics.label,
        description: topics.description,
        color: topics.color,
        sort_order: topics.sort_order,
      })
      .from(documentTopics)
      .innerJoin(topics, eq(documentTopics.topic_id, topics.id))
      .where(eq(documentTopics.document_id, documentId));

    for (const t of docTopics) {
      const [existing] = await tx
        .select({ id: topics.id })
        .from(topics)
        .where(
          and(
            eq(topics.workspace_id, targetWorkspaceId),
            eq(topics.slug, t.slug),
          ),
        )
        .limit(1);

      let targetTopicId = existing?.id;
      if (!targetTopicId) {
        const [created] = await tx
          .insert(topics)
          .values({
            id: crypto.randomUUID(),
            workspace_id: targetWorkspaceId,
            slug: t.slug,
            label: t.label,
            description: t.description,
            color: t.color,
            sort_order: t.sort_order,
          })
          .returning({ id: topics.id });
        targetTopicId = created.id;
      }

      await tx
        .update(documentTopics)
        .set({ topic_id: targetTopicId })
        .where(eq(documentTopics.id, t.assignment_id));
    }

    // --- 8. Dokument und Logs umziehen --------------------------------------
    await tx
      .update(activityLogs)
      .set({ workspace_id: targetWorkspaceId })
      .where(eq(activityLogs.document_id, documentId));

    const [updated] = await tx
      .update(documents)
      .set({ workspace_id: targetWorkspaceId, updated_at: new Date() })
      .where(eq(documents.id, documentId))
      .returning();

    return {
      document: updated,
      moved_pages: movingPages.length,
      renamed_slugs: [...renameMap.entries()].map(([from, to]) => ({
        from,
        to,
      })),
    };
  });
}

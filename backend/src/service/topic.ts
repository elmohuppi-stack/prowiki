import { db } from "../db/index.ts";
import { topics, documentTopics, wikiPages } from "../db/schema.ts";
import { eq, and, inArray, sql, asc, desc } from "drizzle-orm";
import { getActiveProvider, callLLMJson } from "./llm.ts";

/** Slug aus einem Label erzeugen (kleinschreibung, Umlaute, nur a-z0-9-). */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "thema";
}

/** Themen eines Workspace inkl. doc_count, sortiert. */
export async function listTopics(workspaceId: string) {
  const rows = await db
    .select({
      id: topics.id,
      workspace_id: topics.workspace_id,
      slug: topics.slug,
      label: topics.label,
      description: topics.description,
      color: topics.color,
      sort_order: topics.sort_order,
      created_at: topics.created_at,
      doc_count: sql<number>`count(${documentTopics.document_id})`,
    })
    .from(topics)
    .leftJoin(documentTopics, eq(documentTopics.topic_id, topics.id))
    .where(eq(topics.workspace_id, workspaceId))
    .groupBy(topics.id)
    .orderBy(asc(topics.sort_order), asc(topics.label));
  return rows.map((r) => ({ ...r, doc_count: Number(r.doc_count || 0) }));
}

async function uniqueSlug(
  workspaceId: string,
  base: string,
  excludeId?: string,
): Promise<string> {
  let slug = base;
  let n = 1;
  // Kollisionen im Workspace vermeiden (unique index (workspace_id, slug)).
  while (true) {
    const [existing] = await db
      .select({ id: topics.id })
      .from(topics)
      .where(and(eq(topics.workspace_id, workspaceId), eq(topics.slug, slug)))
      .limit(1);
    if (!existing || existing.id === excludeId) return slug;
    slug = `${base}-${++n}`;
  }
}

export async function createTopic(
  workspaceId: string,
  data: { label: string; slug?: string; description?: string; color?: string; sort_order?: number },
) {
  const base = slugify(data.slug || data.label);
  const slug = await uniqueSlug(workspaceId, base);
  const [topic] = await db
    .insert(topics)
    .values({
      id: crypto.randomUUID(),
      workspace_id: workspaceId,
      slug,
      label: data.label,
      description: data.description ?? null,
      color: data.color ?? null,
      sort_order: data.sort_order ?? 0,
    })
    .returning();
  return topic;
}

export async function updateTopic(
  id: string,
  data: { label?: string; description?: string; color?: string; sort_order?: number },
) {
  const set: Record<string, unknown> = {};
  if (data.label !== undefined) set.label = data.label;
  if (data.description !== undefined) set.description = data.description;
  if (data.color !== undefined) set.color = data.color;
  if (data.sort_order !== undefined) set.sort_order = data.sort_order;
  if (Object.keys(set).length === 0) {
    const [t] = await db.select().from(topics).where(eq(topics.id, id)).limit(1);
    return t || null;
  }
  const [topic] = await db
    .update(topics)
    .set(set)
    .where(eq(topics.id, id))
    .returning();
  return topic || null;
}

export async function deleteTopic(id: string) {
  // Zuordnungen zuerst entfernen (FK ohne Cascade).
  await db.delete(documentTopics).where(eq(documentTopics.topic_id, id));
  await db.delete(topics).where(eq(topics.id, id));
}

/** Themen-Slugs, die einem Dokument zugeordnet sind. */
export async function getDocumentTopicIds(documentId: string): Promise<string[]> {
  const rows = await db
    .select({ topic_id: documentTopics.topic_id })
    .from(documentTopics)
    .where(eq(documentTopics.document_id, documentId));
  return rows.map((r) => r.topic_id);
}

/**
 * Setzt die Themen eines Dokuments komplett neu (manuelle Korrektur).
 * Ersetzt alle bisherigen Zuordnungen durch die angegebenen (source="manual").
 */
export async function setDocumentTopics(documentId: string, topicIds: string[]) {
  await db.delete(documentTopics).where(eq(documentTopics.document_id, documentId));
  if (topicIds.length === 0) return;
  await db
    .insert(documentTopics)
    .values(
      topicIds.map((topic_id) => ({
        document_id: documentId,
        topic_id,
        source: "manual",
      })),
    )
    .onConflictDoNothing();
}

/**
 * Weist Themen automatisch zu (LLM-Klassifikation beim Ingest).
 * Nur wenn das Dokument noch keine Zuordnungen hat (überschreibt keine Handedits).
 */
export async function assignAutoTopics(documentId: string, topicIds: string[]) {
  if (topicIds.length === 0) return;
  const existing = await getDocumentTopicIds(documentId);
  if (existing.length > 0) return;
  await db
    .insert(documentTopics)
    .values(
      topicIds.map((topic_id) => ({ document_id: documentId, topic_id, source: "auto" })),
    )
    .onConflictDoNothing();
}

/** Löscht alle Themen-Zuordnungen eines Dokuments (beim Dokument-Löschen). */
export async function deleteDocumentTopics(documentId: string) {
  await db.delete(documentTopics).where(eq(documentTopics.document_id, documentId));
}

// ---- LLM: Themen-Vorschläge & Klassifikation ----

export interface TopicSuggestion {
  label: string;
  slug: string;
  description?: string;
}

/**
 * Schlägt ~12–18 Ober-Themen vor, indem die vorhandenen Concept-/Entity-Titel
 * des Workspace von der LLM geclustert werden. Persistiert NICHTS – der User
 * übernimmt/ändert die Vorschläge im UI.
 */
export async function suggestTopics(
  workspaceId: string,
): Promise<TopicSuggestion[]> {
  // Concepts sind das stärkste Themen-Signal; Entities ergänzen.
  const conceptRows = await db
    .select({ title: wikiPages.title })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.workspace_id, workspaceId),
        eq(wikiPages.page_type, "concept"),
      ),
    )
    .orderBy(desc(wikiPages.updated_at))
    .limit(400);
  const labels = conceptRows.map((r) => r.title).filter(Boolean);
  if (labels.length === 0) return [];

  const provider = await getActiveProvider();
  if (!provider) throw new Error("Kein aktiver LLM-Provider konfiguriert");

  const prompt = `Du bist ein Bibliothekar. Unten stehen Konzept-Begriffe aus einer Wissensdatenbank.
Fasse sie zu 12–18 übergeordneten, klar unterscheidbaren THEMEN zusammen, mit denen man die Dokumente gut filtern kann.
Themen sollen prägnant sein (1–3 Wörter), sich nicht überlappen, und die inhaltliche Bandbreite abdecken.

Antworte NUR mit JSON in diesem Format:
{"topics":[{"label":"Klima & Energie","description":"Kurzbeschreibung des Themas"}]}

Konzepte:
${labels.slice(0, 400).join(", ")}`;

  const result = await callLLMJson<{ topics: { label: string; description?: string }[] }>(
    provider,
    prompt,
  );
  if (!result?.topics) return [];
  return result.topics
    .filter((t) => t.label?.trim())
    .map((t) => ({
      label: t.label.trim(),
      slug: slugify(t.label),
      description: t.description?.trim(),
    }));
}

/**
 * Klassifiziert einen Text (z.B. Dokument-Summary) gegen die aktuellen
 * Workspace-Themen und gibt die passenden topic_ids zurück (0–3).
 * Gibt [] zurück, wenn keine Themen definiert sind.
 */
export async function classifyText(
  workspaceId: string,
  text: string,
): Promise<string[]> {
  if (!text?.trim()) return [];
  const available = await listTopics(workspaceId);
  if (available.length === 0) return [];

  const provider = await getActiveProvider();
  if (!provider) return [];

  const topicList = available
    .map((t) => `- ${t.slug}: ${t.label}${t.description ? ` (${t.description})` : ""}`)
    .join("\n");

  const prompt = `Ordne den folgenden Text 1 bis 3 der vorgegebenen THEMEN zu (die am besten passen).
Verwende AUSSCHLIESSLICH die vorgegebenen Slugs. Wenn nichts wirklich passt, gib eine leere Liste zurück.

Verfügbare Themen (slug: Label):
${topicList}

Antworte NUR mit JSON: {"slugs":["slug1","slug2"]}

Text:
${text.slice(0, 4000)}`;

  const result = await callLLMJson<{ slugs: string[] }>(provider, prompt);
  const chosen = new Set((result?.slugs || []).map((s) => s.trim()));
  return available.filter((t) => chosen.has(t.slug)).map((t) => t.id).slice(0, 3);
}

/** Dokument-IDs, die eines der angegebenen Themen haben (für Filter). */
export async function documentIdsForTopics(
  workspaceId: string,
  topicIds: string[],
): Promise<string[]> {
  if (topicIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ document_id: documentTopics.document_id })
    .from(documentTopics)
    .innerJoin(topics, eq(documentTopics.topic_id, topics.id))
    .where(
      and(
        eq(topics.workspace_id, workspaceId),
        inArray(documentTopics.topic_id, topicIds),
      ),
    );
  return rows.map((r) => r.document_id);
}

import { db } from "../db/index.ts";
import { chunks, documents, modelProviders } from "../db/schema.ts";
import { eq, and, sql } from "drizzle-orm";

export interface SearchResult {
  chunk_id: string;
  document_id: string;
  document_title: string;
  content: string;
  score: number;
  search_type: "vector" | "keyword" | "hybrid";
}

// Hybrid Search: Vektor + Keyword kombinieren
export async function hybridSearch(
  workspaceId: string,
  query: string,
  topK: number = 10,
): Promise<SearchResult[]> {
  const vectorResults = await vectorSearch(workspaceId, query, topK);
  const keywordResults = await keywordSearch(workspaceId, query, topK);

  // Ergebnisse mischen (hybrid score = max beider Scores)
  const merged = new Map<string, SearchResult>();

  for (const r of vectorResults) {
    merged.set(r.chunk_id, r);
  }
  for (const r of keywordResults) {
    const existing = merged.get(r.chunk_id);
    if (existing) {
      existing.score = Math.max(existing.score, r.score);
      existing.search_type = "hybrid";
    } else {
      merged.set(r.chunk_id, r);
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// Vektor-Suche (pgvector cosine similarity)
async function vectorSearch(
  workspaceId: string,
  query: string,
  topK: number,
): Promise<SearchResult[]> {
  try {
    // Zuerst Embedding für Query generieren
    const vector = await generateQueryEmbedding(query);
    if (!vector) return [];

    // pgvector cosine similarity Abfrage.
    // sql-Template statt Positions-Parametern ($1, $2), das der
    // node-postgres-Treiber hier nicht bindet ("there is no parameter $1").
    const vectorStr = `[${vector.join(",")}]`;
    const result = await db.execute(sql`
      SELECT
        c.id as chunk_id,
        c.document_id,
        COALESCE(d.title, w.title, 'Wiki') as document_title,
        c.content,
        1 - (c.embedding <=> ${vectorStr}::vector) as score
      FROM chunks c
      LEFT JOIN documents d ON c.document_id = d.id
      LEFT JOIN wiki_pages w ON c.document_id = 'wiki--' || w.id
      WHERE c.workspace_id = ${workspaceId}
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${vectorStr}::vector
      LIMIT ${topK}`);
    const rows = ((result as any).rows ?? result) as any[];

    return rows.map((r: any) => ({
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      document_title: r.document_title,
      content: r.content,
      score: r.score || 0,
      search_type: "vector" as const,
    }));
  } catch (e: any) {
    console.warn("[search] Vector search error:", e.message);
    return [];
  }
}

// Keyword-Suche (PostgreSQL tsvector)
async function keywordSearch(
  workspaceId: string,
  query: string,
  topK: number,
): Promise<SearchResult[]> {
  try {
    // OR-Verknüpfung (|) statt AND (&): eine natürliche Frage hat selten ALLE
    // Wörter im selben Chunk – ts_rank sortiert die besten Treffer nach oben.
    const searchTerms = query
      .replace(/[^\wäöüßÄÖÜ\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
      .join(" | ");

    if (!searchTerms) return [];

    const result = await db.execute(sql`
      SELECT
        c.id as chunk_id,
        c.document_id,
        COALESCE(d.title, w.title, 'Wiki') as document_title,
        c.content,
        ts_rank(to_tsvector('german', c.content), to_tsquery('german', ${searchTerms})) as score
      FROM chunks c
      LEFT JOIN documents d ON c.document_id = d.id
      LEFT JOIN wiki_pages w ON c.document_id = 'wiki--' || w.id
      WHERE c.workspace_id = ${workspaceId}
        AND to_tsvector('german', c.content) @@ to_tsquery('german', ${searchTerms})
      ORDER BY score DESC
      LIMIT ${topK}`);
    const rows = ((result as any).rows ?? result) as any[];

    return rows.map((r: any) => ({
      chunk_id: r.chunk_id,
      document_id: r.document_id,
      document_title: r.document_title,
      content: r.content,
      score: r.score || 0,
      search_type: "keyword" as const,
    }));
  } catch (e: any) {
    console.warn("[search] Keyword search error:", e.message);
    return [];
  }
}

// Embedding für Query generieren (gleicher Provider wie für Chunks)
async function generateQueryEmbedding(text: string): Promise<number[] | null> {
  const providers = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.is_active, true),
        eq(modelProviders.provider_type, "embedding"),
      ),
    )
    .limit(1);

  const provider = providers[0];
  if (!provider) return null;

  try {
    const response = await fetch(`${provider.api_base_url}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.api_key_encrypted}`,
      },
      body: JSON.stringify({
        model: provider.default_model,
        input: text,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return data?.data?.[0]?.embedding || null;
  } catch {
    return null;
  }
}

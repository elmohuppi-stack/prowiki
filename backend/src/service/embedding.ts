import { db } from "../db/index.ts";
import { chunks, modelProviders, documents } from "../db/schema.ts";
import { eq, isNull, and, sql, notInArray } from "drizzle-orm";

// Aktiven Embedding-Provider aus DB laden (einmal auflösen, dann wiederverwenden –
// spart bei großen Dokumenten tausende identische DB-Abfragen).
async function getActiveEmbeddingProvider(): Promise<
  typeof modelProviders.$inferSelect | null
> {
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

  if (providers.length > 0) return providers[0];

  // Fallback: Chat-Provider mit Embedding-Fähigkeit
  const chatProviders = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.is_active, true),
        eq(modelProviders.provider_type, "both"),
      ),
    )
    .limit(1);

  return chatProviders[0] ?? null;
}

// OpenAI-kompatible Embedding-API aufrufen (Einzeltext)
async function generateEmbedding(text: string): Promise<number[] | null> {
  const provider = await getActiveEmbeddingProvider();
  if (!provider) {
    console.warn("[embed] No active embedding provider configured");
    return null;
  }
  return await callEmbeddingAPI(provider, text);
}

async function callEmbeddingAPI(
  provider: typeof modelProviders.$inferSelect,
  text: string,
): Promise<number[] | null> {
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
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      console.warn(
        `[embed] API error: ${response.status} ${await response.text()}`,
      );
      return null;
    }

    const data = await response.json();
    const vector = data?.data?.[0]?.embedding;
    if (!vector || !Array.isArray(vector)) {
      console.warn("[embed] Unexpected API response format");
      return null;
    }
    return vector;
  } catch (e: any) {
    console.warn(`[embed] API call failed:`, e.message);
    return null;
  }
}

// OpenAI-kompatible Embedding-API mit mehreren Texten pro Request. Die API akzeptiert
// `input` als Array und liefert `data` mit `index`-Feld zur Zuordnung. Ergebnis ist ein
// Array in Eingabereihenfolge; bei Fehler/Timeout des ganzen Requests: alle null.
async function callEmbeddingAPIBatch(
  provider: typeof modelProviders.$inferSelect,
  texts: string[],
): Promise<(number[] | null)[]> {
  try {
    const response = await fetch(`${provider.api_base_url}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.api_key_encrypted}`,
      },
      body: JSON.stringify({
        model: provider.default_model,
        input: texts,
      }),
      // Batch braucht mehr Zeit als ein Einzeltext (15 s) – 60 s pro Batch.
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      console.warn(
        `[embed] Batch API error: ${response.status} ${await response.text()}`,
      );
      return texts.map(() => null);
    }

    const data = await response.json();
    const items = data?.data;
    if (!Array.isArray(items)) {
      console.warn("[embed] Unexpected batch API response format");
      return texts.map(() => null);
    }

    // Nach `index` einsortieren, falls die API die Reihenfolge nicht garantiert.
    const result: (number[] | null)[] = texts.map(() => null);
    for (const item of items) {
      const idx = typeof item?.index === "number" ? item.index : -1;
      const vec = item?.embedding;
      if (idx >= 0 && idx < result.length && Array.isArray(vec)) {
        result[idx] = vec;
      }
    }
    return result;
  } catch (e: any) {
    console.warn(`[embed] Batch API call failed:`, e.message);
    return texts.map(() => null);
  }
}

// Fertigen Embedding-Vektor für einen Chunk in der DB speichern.
async function saveChunkEmbedding(chunkId: string, vector: number[]) {
  try {
    // pgvector erwartet einen String im PostgreSQL-Format "[1,2,3]".
    // sql-Template statt db.execute mit Positions-Parametern, das der
    // node-postgres-Treiber hier nicht korrekt bindet ("no parameter $2").
    const vectorLiteral = `[${vector.join(",")}]`;
    await db
      .update(chunks)
      .set({ embedding: sql`${vectorLiteral}::vector` })
      .where(eq(chunks.id, chunkId));
    return true;
  } catch (e: any) {
    console.error(
      `[embed] Failed to save embedding for chunk ${chunkId}:`,
      e.message,
    );
    return false;
  }
}

// Embedding für einen einzelnen Chunk generieren und speichern
export async function embedChunk(chunkId: string, content: string) {
  const vector = await generateEmbedding(content);
  if (!vector) return false;
  return await saveChunkEmbedding(chunkId, vector);
}

// Wie viele Texte pro Embedding-API-Request gebündelt werden. Batching senkt die
// Laufzeit großer Dokumente drastisch (statt zehntausende Einzel-Requests mit je
// 200 ms Sleep). Über EMBED_BATCH_SIZE konfigurierbar.
const EMBED_BATCH_SIZE = parseInt(process.env.EMBED_BATCH_SIZE || "32");

// Alle unembedded Chunks eines Workspace verarbeiten – ohne oberes Limit, damit auch
// sehr große Dokumente (>5000 Chunks) vollständig embedded werden. Früher deckelte eine
// feste Batch-Zahl bei 5000 Chunks, wodurch der Rest still ohne Embedding blieb und nie
// in der Vektorsuche auftauchte.
//
// Endlosschleifen-Schutz: Chunks, deren Embedding dauerhaft fehlschlägt, bleiben `null`
// und würden vom isNull-Filter sonst ewig erneut geladen. Sie werden in `failed` gemerkt
// und aus der Abfrage ausgeschlossen.
export async function embedWorkspaceChunks(workspaceId: string) {
  const provider = await getActiveEmbeddingProvider();
  if (!provider) {
    console.warn("[embed] No active embedding provider configured");
    return { processed: 0, total: 0 };
  }

  let processed = 0;
  let total = 0;
  const failed = new Set<string>();

  while (true) {
    const conditions = [
      eq(chunks.workspace_id, workspaceId),
      isNull(chunks.embedding),
    ];
    if (failed.size > 0) {
      conditions.push(notInArray(chunks.id, [...failed]));
    }

    const unembedded = await db
      .select({ id: chunks.id, content: chunks.content })
      .from(chunks)
      .where(and(...conditions))
      .limit(EMBED_BATCH_SIZE);

    if (unembedded.length === 0) break;

    const vectors = await callEmbeddingAPIBatch(
      provider,
      unembedded.map((c) => c.content),
    );

    for (let i = 0; i < unembedded.length; i++) {
      const chunk = unembedded[i];
      total++;
      const vector = vectors[i];
      if (vector && (await saveChunkEmbedding(chunk.id, vector))) {
        processed++;
      } else {
        failed.add(chunk.id);
      }
    }

    // Kleine Verzögerung zwischen Batches, um Rate-Limits zu vermeiden.
    await new Promise((r) => setTimeout(r, 200));
  }

  if (total > 0) {
    console.log(
      `[embed] Embedded ${processed}/${total} chunks in workspace ${workspaceId}` +
        (failed.size > 0 ? ` (${failed.size} fehlgeschlagen)` : ""),
    );
  }
  return { processed, total, failed: failed.size };
}

// Chunk-Content kürzen auf max Token
function truncateText(text: string, maxChars: number = 8000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

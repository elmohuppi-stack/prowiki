#!/usr/bin/env bun
/**
 * Schneller Batch-Embedding-Backfill.
 *
 * Embeddet alle chunks mit embedding IS NULL – nutzt den OpenAI-kompatiblen
 * Array-Input (viele Chunks pro Request) statt einzeln, daher ~100x schneller
 * als embedWorkspaceChunks. Für den Wiki-Chunk-Backfill nach dem Import.
 *
 * Usage:
 *   bun run src/scripts/embed-backfill.ts [workspace-id] [--batch=128]
 *   (ohne workspace-id: alle Workspaces)
 */

import { db } from "../db/index.ts";
import { chunks, modelProviders } from "../db/schema.ts";
import { eq, and, isNull, sql } from "drizzle-orm";

const args = process.argv.slice(2);
const wsFilter = args.find((a) => !a.startsWith("--")) || null;
const batchSize = Number(
  (args.find((a) => a.startsWith("--batch=")) || "").split("=")[1] || 128,
);
const MAX_CHARS = 8000; // pro Input kürzen (Token-Limit-Sicherheit)

async function getProvider() {
  const [p] = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.is_active, true),
        eq(modelProviders.provider_type, "embedding"),
      ),
    )
    .limit(1);
  if (!p) throw new Error("Kein aktiver Embedding-Provider konfiguriert");
  return p;
}

async function embedBatch(
  provider: typeof modelProviders.$inferSelect,
  inputs: string[],
): Promise<(number[] | null)[]> {
  const resp = await fetch(`${provider.api_base_url}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.api_key_encrypted}`,
    },
    body: JSON.stringify({ model: provider.default_model, input: inputs }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) {
    throw new Error(`API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  // data.data ist nach index sortiert (OpenAI garantiert das), zur Sicherheit sortieren
  const arr: any[] = data?.data || [];
  arr.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return arr.map((d) => (Array.isArray(d.embedding) ? d.embedding : null));
}

async function main() {
  const provider = await getProvider();
  console.log(`🔌 Provider: ${provider.default_model} @ ${provider.api_base_url}`);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(chunks)
    .where(
      wsFilter
        ? and(isNull(chunks.embedding), eq(chunks.workspace_id, wsFilter))
        : isNull(chunks.embedding),
    );
  console.log(`📊 ${total} Chunks ohne Embedding${wsFilter ? ` (workspace ${wsFilter})` : ""}`);
  if (Number(total) === 0) {
    console.log("✨ Nichts zu tun.");
    process.exit(0);
  }

  let done = 0;
  let failed = 0;
  const t0 = Date.now();

  while (true) {
    const rows = await db
      .select({ id: chunks.id, content: chunks.content })
      .from(chunks)
      .where(
        wsFilter
          ? and(isNull(chunks.embedding), eq(chunks.workspace_id, wsFilter))
          : isNull(chunks.embedding),
      )
      .limit(batchSize);

    if (rows.length === 0) break;

    const inputs = rows.map((r) => (r.content || "").slice(0, MAX_CHARS) || " ");
    let vectors: (number[] | null)[] | null = null;
    // Retry mit Backoff – v.a. für OpenAI 429 (Tokens/Min-Limit). Da wir die
    // Chunks bei Fehler NICHT markieren, würde ein hartes break sie NULL lassen;
    // stattdessen warten + denselben Batch erneut versuchen.
    for (let attempt = 0; attempt < 6 && vectors === null; attempt++) {
      try {
        vectors = await embedBatch(provider, inputs);
      } catch (e: any) {
        const is429 = /429|rate limit|tokens per min|TPM/i.test(e.message);
        const wait = is429 ? 20000 : 3000 * (attempt + 1);
        console.warn(
          `\n⚠️ Batch-Fehler (${e.message.slice(0, 80)}) – warte ${wait / 1000}s, retry ${attempt + 1}/6`,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    if (vectors === null) {
      console.error(`\n❌ Batch endgültig fehlgeschlagen – überspringe (bleibt NULL, später erneut versuchen)`);
      failed += rows.length;
      // Endlosschleife vermeiden: eine dieser Zeilen mit Leer-Vektor blocken
      // ist nicht sinnvoll → wir brechen ab, Rest via erneutem Lauf.
      break;
    }

    // Updates ausführen (parallel, aber begrenzt)
    await Promise.all(
      rows.map(async (r, i) => {
        const v = vectors[i];
        if (!v) {
          failed++;
          return;
        }
        const lit = `[${v.join(",")}]`;
        await db
          .update(chunks)
          .set({ embedding: sql`${lit}::vector` })
          .where(eq(chunks.id, r.id));
        done++;
      }),
    );

    const rate = done / ((Date.now() - t0) / 1000);
    process.stdout.write(
      `\r   ✅ ${done} embedded, ${failed} failed (${rate.toFixed(0)}/s)   `,
    );
  }

  console.log(
    `\n✨ Fertig: ${done} embedded, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Fehler:", err);
  process.exit(1);
});

#!/usr/bin/env bun
/**
 * Schneller Batch-Embedding-Backfill.
 *
 * Embeddet alle chunks mit embedding IS NULL – nutzt den OpenAI-kompatiblen
 * Array-Input (viele Chunks pro Request) statt einzeln, daher ~100x schneller
 * als embedWikiChunks. Für den Wiki-Chunk-Backfill nach dem Import.
 *
 * Usage:
 *   bun run src/scripts/embed-backfill.ts [wiki-id] [--batch=128]
 *   (ohne wiki-id: alle Wikis mit offenen Chunks, jedes mit seinem eigenen
 *    Embedding-Provider — siehe verarbeiteWiki)
 */

import { db } from "../db/index.ts";
import { chunks } from "../db/schema.ts";
import { eq, and, isNull, sql } from "drizzle-orm";
import { holeProvider, type AufgelösterProvider } from "../service/provider.ts";

const args = process.argv.slice(2);
const wikiFilter = args.find((a) => !a.startsWith("--")) || null;
const batchSize = Number(
  (args.find((a) => a.startsWith("--batch=")) || "").split("=")[1] || 128,
);
const MAX_CHARS = 8000; // pro Input kürzen (Token-Limit-Sicherheit)

/**
 * Provider des Wiki, gegen das dieses Skript läuft.
 *
 * Auch hier vorher „erste aktive Zeile" — in einem Wartungsskript besonders
 * heikel, weil es über zehntausende Chunks läuft und ein falscher Anbieter
 * bedeutet: alle Vektoren aus einem fremden Modell, unbrauchbar für die Suche
 * dieses Wiki, und bezahlt hat es jemand anderes.
 */
async function getProvider(wikiId: string) {
  const p = await holeProvider("embedding", { wikiId });
  if (!p) throw new Error("Kein aktiver Embedding-Provider für dieses Wiki");
  return p;
}

async function embedBatch(
  provider: AufgelösterProvider,
  inputs: string[],
): Promise<(number[] | null)[]> {
  const resp = await fetch(`${provider.api_base_url}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.api_key}`,
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

/**
 * Ein Wiki abarbeiten — mit **seinem** Provider.
 *
 * Die Aufteilung je Wiki ist keine Kosmetik: seit die Provider je Organisation
 * getrennt sind (service/provider.ts), gibt es keinen einen Anbieter mehr, mit
 * dem man „alle Chunks" einbetten könnte. Zwei Wikis verschiedener
 * Organisationen können verschiedene Modelle benutzen, und Vektoren aus zwei
 * Modellen im selben Index sind wertlos — sie spannen verschiedene Räume auf.
 */
async function verarbeiteWiki(wikiId: string): Promise<{ done: number; failed: number }> {
  const provider = await getProvider(wikiId);
  console.log(
    `\n🔌 Wiki ${wikiId}: ${provider.default_model} @ ${provider.api_base_url} (${provider.herkunft})`,
  );

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(chunks)
    .where(and(isNull(chunks.embedding), eq(chunks.wiki_id, wikiId)));
  console.log(`📊 ${total} Chunks ohne Embedding`);
  if (Number(total) === 0) return { done: 0, failed: 0 };

  let done = 0;
  let failed = 0;
  const t0 = Date.now();

  while (true) {
    const rows = await db
      .select({ id: chunks.id, content: chunks.content })
      .from(chunks)
      .where(and(isNull(chunks.embedding), eq(chunks.wiki_id, wikiId)))
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
      console.error(
        `\n❌ Batch endgültig fehlgeschlagen – überspringe (bleibt NULL, später erneut versuchen)`,
      );
      failed += rows.length;
      break;
    }

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

  return { done, failed };
}

async function main() {
  const t0 = Date.now();

  // Ohne Wiki-Angabe: alle Wikis, die offene Chunks haben — jedes mit seinem
  // eigenen Provider. Ein Wiki, dessen Organisation keinen aktiven Provider
  // hat, lässt den Lauf nicht scheitern: es wird gemeldet und übersprungen,
  // sonst blockiert ein einzelner fehlender Schlüssel den ganzen Bestand.
  const wikiIds = wikiFilter
    ? [wikiFilter]
    : (
        await db
          .selectDistinct({ wiki_id: chunks.wiki_id })
          .from(chunks)
          .where(isNull(chunks.embedding))
      ).map((r) => r.wiki_id);

  if (wikiIds.length === 0) {
    console.log("✨ Nichts zu tun.");
    process.exit(0);
  }
  console.log(`📚 ${wikiIds.length} Wiki(s) mit offenen Chunks`);

  let done = 0;
  let failed = 0;
  const übersprungen: string[] = [];

  for (const wikiId of wikiIds) {
    try {
      const r = await verarbeiteWiki(wikiId);
      done += r.done;
      failed += r.failed;
    } catch (e: any) {
      console.warn(`\n⚠️ Wiki ${wikiId} übersprungen: ${e.message}`);
      übersprungen.push(wikiId);
    }
  }

  console.log(
    `\n✨ Fertig: ${done} embedded, ${failed} failed` +
      (übersprungen.length > 0 ? `, ${übersprungen.length} Wiki(s) ohne Provider` : "") +
      ` in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Fehler:", err);
  process.exit(1);
});

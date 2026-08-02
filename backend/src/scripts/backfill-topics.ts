#!/usr/bin/env bun
/**
 * Themen-Backfill (Ebene 1)
 *
 * Klassifiziert bestehende Dokumente eines Wikis per LLM gegen den bereits
 * definierten Themenkatalog und legt Auto-Zuordnungen an (überschreibt keine
 * Handedits). Läuft SEQUENZIELL (ein Dokument nach dem anderen) – schont den
 * kleinen Prod-Host (3,7 GB RAM).
 *
 * Voraussetzung: Das Wiki hat bereits Themen (sonst nichts zu tun).
 *
 * Usage:
 *   bun run src/scripts/backfill-topics.ts --wiki <id> [--dry-run]
 */

import { db } from "../db/index.ts";
import { documents, wikiPages } from "../db/schema.ts";
import { and, eq, inArray } from "drizzle-orm";
import { listTopics, classifyText, assignAutoTopics, getDocumentTopicIds } from "../service/topic.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const wikiIdx = args.indexOf("--wiki");
const wikiId = wikiIdx >= 0 ? args[wikiIdx + 1] : undefined;

async function main() {
  if (!wikiId) {
    console.error("Bitte --wiki <id> angeben.");
    process.exit(1);
  }
  const topics = await listTopics(wikiId);
  if (topics.length === 0) {
    console.error(
      "Das Wiki hat noch keine Themen. Erst Themen anlegen (UI: Vorschläge generieren), dann Backfill.",
    );
    process.exit(1);
  }
  console.log(
    `[backfill-topics] ${topics.length} Themen im Wiki${dryRun ? " (DRY-RUN)" : ""}`,
  );

  const docs = await db
    .select()
    .from(documents)
    .where(eq(documents.wiki_id, wikiId));
  console.log(`[backfill-topics] ${docs.length} Dokumente`);

  const byId = new Map(topics.map((t) => [t.id, t.label]));
  let classified = 0;
  let skipped = 0;

  for (const doc of docs) {
    // Nur Dokumente ohne bestehende Zuordnung.
    const existing = await getDocumentTopicIds(doc.id);
    if (existing.length > 0) {
      skipped++;
      continue;
    }
    // Text: Summary-/Artikel-Wiki-Seite des Dokuments, sonst Dokument-Titel.
    const [sumPage] = await db
      .select({ summary: wikiPages.summary, content: wikiPages.content })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.source_document_id, doc.id),
          inArray(wikiPages.page_type, ["summary", "article"]),
        ),
      )
      .limit(1);
    const text = sumPage?.summary || sumPage?.content || doc.title;

    const topicIds = await classifyText(wikiId, text);
    const labels = topicIds.map((id) => byId.get(id)).filter(Boolean);
    console.log(
      `  • ${doc.title.slice(0, 55)} → ${labels.length ? labels.join(", ") : "(keine)"}`,
    );
    if (!dryRun && topicIds.length) {
      await assignAutoTopics(doc.id, topicIds);
    }
    classified++;
  }

  console.log(
    `[backfill-topics] Fertig: ${classified} klassifiziert, ${skipped} übersprungen (hatten schon Themen)${dryRun ? " (DRY-RUN)" : ""}`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfill-topics] Fehler:", e);
  process.exit(1);
});

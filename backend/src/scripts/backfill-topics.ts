#!/usr/bin/env bun
/**
 * Themen-Backfill (Ebene 1)
 *
 * Klassifiziert bestehende Dokumente eines Workspace per LLM gegen den bereits
 * definierten Themenkatalog und legt Auto-Zuordnungen an (überschreibt keine
 * Handedits). Läuft SEQUENZIELL (ein Dokument nach dem anderen) – schont den
 * kleinen Prod-Host (3,7 GB RAM).
 *
 * Voraussetzung: Der Workspace hat bereits Themen (sonst nichts zu tun).
 *
 * Usage:
 *   bun run src/scripts/backfill-topics.ts --workspace <id> [--dry-run]
 */

import { db } from "../db/index.ts";
import { documents, wikiPages } from "../db/schema.ts";
import { and, eq, inArray } from "drizzle-orm";
import { listTopics, classifyText, assignAutoTopics, getDocumentTopicIds } from "../service/topic.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const wsIdx = args.indexOf("--workspace");
const workspaceId = wsIdx >= 0 ? args[wsIdx + 1] : undefined;

async function main() {
  if (!workspaceId) {
    console.error("Bitte --workspace <id> angeben.");
    process.exit(1);
  }
  const topics = await listTopics(workspaceId);
  if (topics.length === 0) {
    console.error(
      "Der Workspace hat noch keine Themen. Erst Themen anlegen (UI: Vorschläge generieren), dann Backfill.",
    );
    process.exit(1);
  }
  console.log(
    `[backfill-topics] ${topics.length} Themen im Workspace${dryRun ? " (DRY-RUN)" : ""}`,
  );

  const docs = await db
    .select()
    .from(documents)
    .where(eq(documents.workspace_id, workspaceId));
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

    const topicIds = await classifyText(workspaceId, text);
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

#!/usr/bin/env bun
/**
 * Kanal-Backfill (Ebene 2)
 *
 * Trägt für bestehende YouTube-Dokumente die `channel`-Spalte nach, indem die
 * Zeile `**Kanal**: <name>` aus dem gespeicherten `content` geparst wird.
 * Rein textuell, keine Provider-/API-Calls.
 *
 * NICHT nachtragbar: published_at / duration / youtube_tags standen nie im
 * content — dafür den „Metadaten aktualisieren"-Button (POST
 * /documents/:id/refresh-metadata) pro Video nutzen.
 *
 * Usage:
 *   bun run src/scripts/backfill-channel.ts [--dry-run] [--workspace <id>]
 */

import { db } from "../db/index.ts";
import { documents } from "../db/schema.ts";
import { and, eq, isNull, or } from "drizzle-orm";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const wsIdx = args.indexOf("--workspace");
const workspaceId = wsIdx >= 0 ? args[wsIdx + 1] : undefined;

const CHANNEL_RE = /\*\*Kanal\*\*:\s*(.+)/;

async function main() {
  console.log(
    `[backfill-channel] Start${dryRun ? " (DRY-RUN)" : ""}${workspaceId ? `, Workspace ${workspaceId}` : ""}`,
  );

  const conditions = [eq(documents.type, "youtube")];
  if (workspaceId) conditions.push(eq(documents.workspace_id, workspaceId));
  // Nur Dokumente ohne gesetzten Kanal.
  conditions.push(or(isNull(documents.channel), eq(documents.channel, ""))!);

  const rows = await db
    .select()
    .from(documents)
    .where(and(...conditions));

  console.log(`[backfill-channel] ${rows.length} YouTube-Dokumente ohne Kanal`);

  let updated = 0;
  let skipped = 0;
  for (const doc of rows) {
    const match = doc.content?.match(CHANNEL_RE);
    const channel = match?.[1]?.trim();
    if (!channel) {
      skipped++;
      continue;
    }
    console.log(`  • ${doc.title.slice(0, 60)} → „${channel}"`);
    if (!dryRun) {
      await db
        .update(documents)
        .set({ channel })
        .where(eq(documents.id, doc.id));
    }
    updated++;
  }

  console.log(
    `[backfill-channel] Fertig: ${updated} aktualisiert, ${skipped} ohne Kanal-Zeile${dryRun ? " (DRY-RUN, nichts geschrieben)" : ""}`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfill-channel] Fehler:", e);
  process.exit(1);
});

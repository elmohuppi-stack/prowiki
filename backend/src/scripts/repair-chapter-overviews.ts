#!/usr/bin/env bun
/**
 * Fehlende Übersichtsseiten mehrteiliger Dokumente wiederherstellen.
 *
 * Hintergrund: Das Abräumen verwaister Kapitel in wiki-generate.ts kannte die
 * Übersichtsseite nicht (sie trägt den Basis-Slug, die Kapitel `…-k1`, `-k2`, …)
 * und löschte sie direkt nach dem Erzeugen wieder. Zurück blieben Kapitel mit
 * einem `parent_slug`, zu dem es keine Seite mehr gibt — in der Trefferliste
 * werden sie deshalb nicht mehr gebündelt, im Leser fehlt das Krümel zur
 * Übersicht.
 *
 * Dieses Skript baut die Übersicht aus den vorhandenen Kapiteln neu: Titel aus
 * dem Quelldokument, Inhaltsverzeichnis aus `sort_order` + Kapiteltiteln —
 * genau die Form, die die Pipeline selbst erzeugt. Ein erneuter LLM-Lauf ist
 * dafür nicht nötig, es entstehen keine Provider-Kosten.
 *
 * Bereits vorhandene Übersichtsseiten bleiben unangetastet; das Skript ist
 * mehrfach ausführbar.
 *
 * Usage:
 *   bun run src/scripts/repair-chapter-overviews.ts [--dry-run] [--wiki <id>]
 */

import { db } from "../db/index.ts";
import { documents } from "../db/schema.ts";
import { wikiPages } from "../db/schema/content.ts";
import * as wikiService from "../service/wiki.ts";
import { and, eq, isNotNull } from "drizzle-orm";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const wikiIdx = args.indexOf("--wiki");
const onlyWiki = wikiIdx >= 0 ? args[wikiIdx + 1] : undefined;

async function main() {
  console.log(
    `[repair-overviews] Start${dryRun ? " (DRY-RUN)" : ""}${onlyWiki ? `, Wiki ${onlyWiki}` : ""}`,
  );

  const conditions = [isNotNull(wikiPages.parent_slug)];
  if (onlyWiki) conditions.push(eq(wikiPages.wiki_id, onlyWiki));

  const chapters = await db
    .select({
      wiki_id: wikiPages.wiki_id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      parent_slug: wikiPages.parent_slug,
      sort_order: wikiPages.sort_order,
      source_document_id: wikiPages.source_document_id,
    })
    .from(wikiPages)
    .where(and(...conditions));

  // Nach (Wiki, Eltern-Slug) gruppieren.
  const groups = new Map<string, typeof chapters>();
  for (const c of chapters) {
    const key = `${c.wiki_id} ${c.parent_slug}`;
    const arr = groups.get(key) || [];
    arr.push(c);
    groups.set(key, arr);
  }
  console.log(`[repair-overviews] ${groups.size} Kapitel-Gruppen gefunden`);

  let repaired = 0;
  let intact = 0;
  let skipped = 0;

  for (const [key, kapitel] of groups) {
    const [wikiId, parentSlug] = key.split(" ");

    if (await wikiService.getPage(wikiId, parentSlug)) {
      intact++;
      continue;
    }

    kapitel.sort(
      (a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug),
    );

    // Titel der Übersicht: der des Quelldokuments. Alle Kapitel eines Verbunds
    // zeigen auf dasselbe Dokument; das erste mit gesetzter ID genügt.
    const docId = kapitel.find((k) => k.source_document_id)?.source_document_id;
    let title = "";
    if (docId) {
      const [doc] = await db
        .select({ title: documents.title })
        .from(documents)
        .where(eq(documents.id, docId))
        .limit(1);
      title = doc?.title ?? "";
    }
    // Ohne Dokument (gelöscht oder nie verknüpft): den „– Teil N"-Zusatz vom
    // ersten Kapiteltitel abziehen. Bleibt nichts Brauchbares übrig, wird die
    // Gruppe gemeldet statt geraten.
    if (!title) {
      title = kapitel[0].title.replace(/\s+[–-]\s+Teil\s+\d+\s*$/i, "").trim();
    }
    if (!title) {
      console.log(
        `  ⚠️ ${parentSlug}: kein Titel ermittelbar (${kapitel.length} Kapitel) – übersprungen`,
      );
      skipped++;
      continue;
    }

    const chapterLinks = kapitel.map(
      (k, i) => `- Kapitel ${k.sort_order || i + 1}: [[${k.slug}|${k.title}]]`,
    );
    const content =
      `# ${title}\n\n` +
      `Dieses Dokument ist in ${kapitel.length} Kapitel gegliedert.\n\n` +
      `## Kapitel\n\n${chapterLinks.join("\n")}`;

    console.log(
      `  • ${parentSlug} → „${title.slice(0, 60)}" (${kapitel.length} Kapitel)`,
    );
    if (dryRun) {
      repaired++;
      continue;
    }

    await wikiService.createPage({
      wiki_id: wikiId,
      slug: parentSlug,
      title,
      content,
      summary: `Übersicht über ${kapitel.length} Kapitel aus „${title}".`,
      page_type: "summary",
      source_document_id: docId ?? null,
      parent_slug: null,
      sort_order: 0,
    });

    // Verlinkung nachziehen: out_links der Übersicht und in_links der Kapitel.
    const { out_links } = await wikiService.resolveLinks(wikiId, content);
    if (out_links.length) {
      await wikiService.updatePage(wikiId, parentSlug, { out_links });
      await wikiService.updateIncomingLinks(wikiId, parentSlug, out_links);
    }
    repaired++;
  }

  console.log(
    `[repair-overviews] Fertig: ${repaired} Übersicht(en) ${dryRun ? "wären wiederherzustellen" : "wiederhergestellt"}, ${intact} intakt, ${skipped} übersprungen`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[repair-overviews] Fehlgeschlagen:", err);
  process.exit(1);
});

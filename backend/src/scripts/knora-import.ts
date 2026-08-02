#!/usr/bin/env bun
/**
 * WeKnora → Knora Import Script
 *
 * Importiert exportierte WeKnora-Daten (aus weknora-export.py) in Knora.
 * Unterstützt zwei Modi:
 *
 * 1. Einzelseiten-Import: bun run src/scripts/knora-import.ts <workspace-id> <wiki-pages.json>
 * 2. Kompletter Import:   bun run src/scripts/knora-import.ts <export-verzeichnis>
 *
 * Export-Verzeichnis-Struktur:
 *   exports/
 *     politik/
 *       workspace.json      – Workspace-Metadaten
 *       documents.json      – Dokumente (YouTube, PDFs, etc.)
 *       wiki-pages.json     – Wiki-Seiten (Summary, Entity, Concept)
 *     corona/
 *       ...
 *     _index.json           – Gesamtübersicht (optional)
 */

import { db } from "../db/index.ts";
import { workspaces, documents, users } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import {
  importWeKnoraPages,
  createPage,
  type WeKnoraPage,
} from "../service/wiki.ts";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

interface WorkspaceMeta {
  id?: string;
  name: string;
  description?: string;
  slug?: string;
  type?: string;
  chunk_size?: number;
  chunk_overlap?: number;
  created_at?: string;
  updated_at?: string;
}

interface ExportDoc {
  id: string;
  knowledge_base_id: string;
  title: string;
  type: string;
  source?: string;
  source_url?: string;
  file_name?: string;
  file_type?: string;
  file_size?: number;
  parse_status?: string;
  content?: string;
  description?: string;
  channel?: string;
  metadata?: any;
  youtube_info?: {
    video_id?: string;
    channel_name?: string;
    channel_url?: string;
    duration?: number;
    thumbnail_url?: string;
  };
  created_at?: string;
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Hauptfunktion
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(`
🔧 WeKnora → Knora Import Script

Importiert exportierte WeKnora-Daten in Knora.

Usage:
  # Einzelseiten-Import (einzelne JSON-Datei)
  bun run src/scripts/knora-import.ts <workspace-id> <wiki-pages.json> [--dry-run]

  # Kompletter Import (Export-Verzeichnis)
  bun run src/scripts/knora-import.ts ./exports [--dry-run]

Options:
  --dry-run    Nur analysieren, nicht importieren

Examples:
  bun run src/scripts/knora-import.ts abc-123 ./wiki-pages.json
  bun run src/scripts/knora-import.ts ./exports
  bun run src/scripts/knora-import.ts ./exports --dry-run
`);
    process.exit(1);
  }

  const dryRun = args.includes("--dry-run");

  // Admin-User ermitteln
  const [adminUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .limit(1);
  const userId = adminUser?.id || 1;

  // Prüfen: Einzeldatei oder Export-Verzeichnis?
  const firstArg = path.resolve(args[0]);
  const stat = fs.statSync(firstArg);

  if (stat.isDirectory()) {
    // ── Kompletter Import aus Export-Verzeichnis ──
    await importFromDirectory(firstArg, userId, dryRun);
  } else {
    // ── Einzelseiten-Import ──
    const workspaceId = args[0];
    const jsonFile = args[1] ? path.resolve(args[1]) : null;

    if (!jsonFile || !fs.existsSync(jsonFile)) {
      console.error("❌ JSON-Datei nicht gefunden");
      process.exit(1);
    }

    await importWikiPages(workspaceId, jsonFile, userId, dryRun);
  }

  console.log("\n✨ Fertig!");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Kompletter Import aus Export-Verzeichnis
// ---------------------------------------------------------------------------

async function importFromDirectory(
  exportDir: string,
  userId: number,
  dryRun: boolean,
) {
  console.log(`📂 Importiere aus Verzeichnis: ${exportDir}\n`);

  const entries = fs.readdirSync(exportDir, { withFileTypes: true });
  const kbDirs = entries.filter(
    (e) =>
      e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."),
  );

  if (kbDirs.length === 0) {
    console.log("⚠️ Keine Workspace-Verzeichnisse gefunden.");
    return;
  }

  console.log(`📊 Gefundene Workspaces: ${kbDirs.length}\n`);

  let totalWorkspaces = 0;
  let totalDocs = 0;
  let totalWiki = 0;

  for (const dir of kbDirs) {
    const kbDir = path.join(exportDir, dir.name);
    const wsPath = path.join(kbDir, "workspace.json");
    const docsPath = path.join(kbDir, "documents.json");
    const wikiPath = path.join(kbDir, "wiki-pages.json");

    if (!fs.existsSync(wsPath)) {
      console.log(`  ⏭️  ${dir.name}: Keine workspace.json – übersprungen`);
      continue;
    }

    console.log(`${"=".repeat(50)}`);
    console.log(`📂 Workspace: ${dir.name}`);

    // Workspace-Metadaten laden
    const wsMeta: WorkspaceMeta = JSON.parse(fs.readFileSync(wsPath, "utf-8"));
    console.log(`   Name: ${wsMeta.name}`);

    // Workspace anlegen oder vorhandenen verwenden
    const wsId = await ensureWorkspace(wsMeta, userId, dryRun);
    if (!wsId) {
      console.log(`   ❌ Konnte Workspace nicht anlegen – übersprungen`);
      continue;
    }
    console.log(`   🆔 ID: ${wsId}`);
    totalWorkspaces++;

    // Dokumente importieren
    let docCount = 0;
    if (fs.existsSync(docsPath)) {
      const exportDocs: ExportDoc[] = JSON.parse(
        fs.readFileSync(docsPath, "utf-8"),
      );
      console.log(`   📄 ${exportDocs.length} Dokumente...`);
      if (!dryRun) {
        docCount = await importDocuments(wsId, exportDocs, userId);
      }
      console.log(`      → ${docCount} importiert`);
      totalDocs += docCount;
    }

    // Wiki-Seiten importieren
    let wikiCount = 0;
    if (fs.existsSync(wikiPath)) {
      const wikiFile = wikiPath;
      const result = await importWikiPages(wsId, wikiFile, userId, dryRun);
      wikiCount = result.imported;
      console.log(`      → ${wikiCount} importiert`);
      totalWiki += wikiCount;
    }

    console.log(
      `   ✅ ${dir.name}: ${docCount} Docs, ${wikiCount} Wiki-Seiten`,
    );
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(
    `📊 Gesamt: ${totalWorkspaces} Workspaces, ${totalDocs} Dokumente, ${totalWiki} Wiki-Seiten`,
  );
}

// ---------------------------------------------------------------------------
// Workspace anlegen / auflösen
// ---------------------------------------------------------------------------

async function ensureWorkspace(
  meta: WorkspaceMeta,
  userId: number,
  dryRun: boolean,
): Promise<string | null> {
  // Prüfen ob Workspace mit dieser ID bereits existiert
  if (meta.id) {
    const existing = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, meta.id))
      .limit(1);

    if (existing[0]) {
      console.log(
        `   ✓ Workspace ${meta.name} existiert bereits (ID: ${meta.id})`,
      );
      return meta.id;
    }
  }

  // Prüfen ob Workspace mit diesem Namen existiert
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.name, meta.name))
    .limit(1);

  if (existing[0]) {
    console.log(
      `   ✓ Workspace "${meta.name}" existiert bereits (ID: ${existing[0].id})`,
    );
    return existing[0].id;
  }

  if (dryRun) {
    console.log(`   📝 Würde Workspace "${meta.name}" anlegen`);
    return "dry-run";
  }

  // Neuen Workspace anlegen
  try {
    const [ws] = await db
      .insert(workspaces)
      .values({
        id: meta.id || crypto.randomUUID(),
        name: meta.name,
        description: meta.description || "",
        created_by: userId,
        chunk_size: meta.chunk_size || 512,
        chunk_overlap: meta.chunk_overlap || 50,
        indexing_strategy: {
          vector_enabled: true,
          keyword_enabled: true,
          wiki_enabled: true,
          graph_enabled: false,
        },
        wiki_config: {
          auto_ingest: false,
          synthesis_model_id: null,
          wiki_language: "de",
          max_pages_per_ingest: 10,
          extraction_granularity: "standard",
        },
      })
      .returning();

    console.log(`   ✅ Neuer Workspace angelegt: "${ws.name}" (${ws.id})`);
    return ws.id;
  } catch (e: any) {
    console.error(`   ❌ Fehler beim Anlegen: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dokumente importieren
// ---------------------------------------------------------------------------

async function importDocuments(
  workspaceId: string,
  exportDocs: ExportDoc[],
  userId: number,
): Promise<number> {
  let count = 0;

  for (const doc of exportDocs) {
    try {
      // Prüfen ob bereits vorhanden
      const existing = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.id, doc.id))
        .limit(1);

      if (existing[0]) {
        count++;
        continue;
      }

      // YouTube-Info in description einbetten
      let description = doc.description || "";
      if (doc.youtube_info?.channel_name) {
        const yi = doc.youtube_info;
        description = `Kanal: ${yi.channel_name}\n${description}`.trim();
      }

      // Content aus metadata extrahieren (für YouTube)
      let content = doc.content || "";
      if (!content && doc.metadata) {
        const meta =
          typeof doc.metadata === "string"
            ? JSON.parse(doc.metadata)
            : doc.metadata;
        content = meta.transcript || meta.content || "";
      }

      await db.insert(documents).values({
        id: doc.id,
        workspace_id: workspaceId,
        title: doc.title || doc.file_name || "Unbenannt",
        type: doc.type || "unknown",
        source: doc.source || doc.source_url || "",
        source_url: doc.source_url || null,
        content: content || null,
        file_name: doc.file_name || null,
        file_type: doc.file_type || null,
        file_size: doc.file_size || null,
        parse_status: doc.parse_status || "completed",
        created_by: userId,
        created_at: doc.created_at ? new Date(doc.created_at) : new Date(),
        updated_at: doc.updated_at ? new Date(doc.updated_at) : new Date(),
      });
      count++;
    } catch (e: any) {
      console.warn(`   ⚠️  Fehler bei Dokument ${doc.id}: ${e.message}`);
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Wiki-Seiten importieren (Einzeldatei)
// ---------------------------------------------------------------------------

async function importWikiPages(
  workspaceId: string,
  jsonFile: string,
  userId: number,
  dryRun: boolean,
): Promise<{ imported: number; skipped: number }> {
  console.log(`\n📖 Lese: ${jsonFile}`);

  const raw = fs.readFileSync(jsonFile, "utf-8");
  let pages: WeKnoraPage[];

  try {
    const parsed = JSON.parse(raw);
    pages = Array.isArray(parsed) ? parsed : parsed.pages || [parsed];
  } catch (e: any) {
    console.error(`   ❌ JSON-Parse-Fehler: ${e.message}`);
    return { imported: 0, skipped: 0 };
  }

  if (pages.length === 0) {
    console.log("   ⚠️ Keine Seiten zum Importieren.");
    return { imported: 0, skipped: 0 };
  }

  // Vorschau
  const typeCounts: Record<string, number> = {};
  for (const p of pages) {
    const t = p.page_type || "article";
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  console.log(`   📊 ${pages.length} Seiten:`);
  for (const [type, count] of Object.entries(typeCounts)) {
    console.log(`      ${type}: ${count}`);
  }

  if (dryRun) {
    console.log("   🏁 Dry-Run – keine Änderungen.");
    return { imported: 0, skipped: pages.length };
  }

  const result = await importWeKnoraPages(workspaceId, pages, userId);

  console.log(`   ✅ Importiert: ${result.imported}`);
  if (result.skipped > 0) console.log(`   ⏭️  Übersprungen: ${result.skipped}`);
  if (result.errors.length > 0) {
    for (const err of result.errors.slice(0, 5)) {
      console.log(`   ❌ ${err}`);
    }
    if (result.errors.length > 5) {
      console.log(`      ... und ${result.errors.length - 5} weitere`);
    }
  }

  return { imported: result.imported, skipped: result.skipped };
}

main().catch((err) => {
  console.error("❌ Unerwarteter Fehler:", err);
  process.exit(1);
});

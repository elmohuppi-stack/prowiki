#!/usr/bin/env bun
/**
 * WeKnora (DB-Export) → Knora Import
 *
 * Importiert einen direkten Postgres-Export aus WeKnora (JSONL.gz) in Knora.
 * Anders als das ältere API-basierte knora-import.ts nutzt dieses Script den
 * DB-Dump und – entscheidend – **übernimmt die vorhandenen Embeddings 1:1**
 * (WeKnora und Knora nutzen beide text-embedding-3-small / 1536-Dim), sodass
 * Dokumente ohne Re-Embedding sofort vektor-durchsuchbar sind.
 *
 * Erwartete Dateien im Export-Verzeichnis (aus scripts/weknora-export siehe unten):
 *   knowledges.jsonl.gz   – Dokumente (WeKnora "knowledges")
 *   wiki_pages.jsonl.gz   – Generierte Artikel (summary/entity/concept/...)
 *   embeddings.jsonl.gz   – Dokument-Chunks inkl. halfvec-Embedding
 *
 * Usage:
 *   bun run src/scripts/weknora-db-import.ts <export-dir> [--dry-run]
 */

import { db } from "../db/index.ts";
import { workspaces, documents, wikiPages, chunks, users } from "../db/schema.ts";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { splitIntoChunks, saveChunks } from "../service/document.ts";
import { createReadStream, readFileSync, existsSync } from "fs";
import { createGunzip } from "zlib";
import { createInterface } from "readline";
import * as path from "path";

// ---------------------------------------------------------------------------
// KB → Workspace-Mapping (die 3 Haupt-KBs; leere Zweit-"RKI Files" ignoriert)
// ---------------------------------------------------------------------------
const KB_MAP: Record<string, { name: string; description: string }> = {
  "71f2a230-918c-43a8-a470-e69350a865d0": {
    name: "RKI Files",
    description: "Ungeschwärzte RKI Files",
  },
  "ecc12c1e-790b-43b2-a6c9-a5bbe2223a62": {
    name: "Politik",
    description: "Politische Themen",
  },
  "bc6aa858-5db7-464d-9321-bf9097270ca3": {
    name: "Corona",
    description: "Corona Plandemie",
  },
};

const BATCH = 250;

interface Knowledge {
  id: string;
  knowledge_base_id: string;
  type: string;
  title: string;
  description?: string;
  source: string;
  parse_status?: string;
  file_name?: string;
  file_type?: string;
  file_size?: number;
  file_hash?: string;
  file_path?: string;
  metadata?: any;
  created_at?: string;
  updated_at?: string;
}

interface WikiPage {
  id: string;
  knowledge_base_id: string;
  slug: string;
  title: string;
  page_type: string;
  status: string;
  content: string;
  summary: string;
  source_refs?: any;
  chunk_refs?: any;
  in_links?: any;
  out_links?: any;
  page_metadata?: any;
  aliases?: any;
  version?: number;
  created_at?: string;
  updated_at?: string;
}

function readJsonlGzSync<T>(file: string): T[] {
  const raw = readFileSync(file);
  const { gunzipSync } = require("zlib");
  const text = gunzipSync(raw).toString("utf-8");
  return text
    .split("\n")
    .filter((l: string) => l.trim().length > 0)
    .map((l: string) => JSON.parse(l) as T);
}

function looksLikeUrl(s: string | undefined): boolean {
  return !!s && /^https?:\/\//i.test(s);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const exportDir = path.resolve(args.find((a) => !a.startsWith("--")) || "");

  if (!exportDir || !existsSync(exportDir)) {
    console.error("❌ Export-Verzeichnis fehlt. Usage: bun run ... <export-dir> [--dry-run]");
    process.exit(1);
  }

  const knowledgesFile = path.join(exportDir, "knowledges.jsonl.gz");
  const wikiFile = path.join(exportDir, "wiki_pages.jsonl.gz");
  const embeddingsFile = path.join(exportDir, "embeddings.jsonl.gz");

  for (const f of [knowledgesFile, wikiFile, embeddingsFile]) {
    if (!existsSync(f)) {
      console.error(`❌ Datei fehlt: ${f}`);
      process.exit(1);
    }
  }

  // Besitzer der Workspaces bestimmen. --owner=<email> hat Vorrang, sonst
  // erster Admin. Wichtig: die Workspace-Liste im Frontend filtert nach
  // created_by == eingeloggter User – daher muss hier DER Nutzer stehen,
  // der die Daten später sehen soll.
  const ownerEmail = (args.find((a) => a.startsWith("--owner=")) || "").split("=")[1];
  let userId: number;
  if (ownerEmail) {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, ownerEmail))
      .limit(1);
    if (!u) {
      console.error(`❌ Kein User mit E-Mail ${ownerEmail} gefunden`);
      process.exit(1);
    }
    userId = u.id;
  } else {
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, "admin"))
      .limit(1);
    userId = admin?.id || 1;
  }
  console.log(`👤 created_by = ${userId}${ownerEmail ? ` (${ownerEmail})` : ""}`);

  // ── 1) Workspaces sicherstellen ──
  const wsIdByKb: Record<string, string> = {};
  for (const [kbId, meta] of Object.entries(KB_MAP)) {
    const wsId = await ensureWorkspace(meta.name, meta.description, userId, dryRun);
    wsIdByKb[kbId] = wsId;
    console.log(`📂 ${meta.name} → workspace ${wsId}`);
  }

  // ── 2) Dokumente importieren ──
  const knowledges = readJsonlGzSync<Knowledge>(knowledgesFile);
  console.log(`\n📄 ${knowledges.length} Dokumente aus Export`);
  const importedDocIds = new Set<string>();
  let docCount = 0;

  for (let i = 0; i < knowledges.length; i += BATCH) {
    const slice = knowledges.slice(i, i + BATCH);
    const values = slice
      .filter((k) => wsIdByKb[k.knowledge_base_id])
      .map((k) => {
        importedDocIds.add(k.id);
        return {
          id: k.id,
          workspace_id: wsIdByKb[k.knowledge_base_id],
          title: (k.title || k.file_name || "Unbenannt").slice(0, 512),
          type: (k.type || "unknown").slice(0, 50),
          source: k.source || k.file_name || "",
          source_url: looksLikeUrl(k.source) ? k.source : null,
          content: null as string | null,
          file_path: k.file_path || null,
          file_size: k.file_size ?? null,
          file_hash: k.file_hash || null,
          parse_status: "completed",
          created_by: userId,
          created_at: k.created_at ? new Date(k.created_at) : new Date(),
          updated_at: k.updated_at ? new Date(k.updated_at) : new Date(),
        };
      });
    if (values.length && !dryRun) {
      await db.insert(documents).values(values).onConflictDoNothing();
    }
    docCount += values.length;
  }
  console.log(`   ✅ ${docCount} Dokumente eingefügt (skip vorhandene)`);

  // ── 3) Dokument-Chunks + Embeddings streamen (1:1, kein Re-Embedding) ──
  console.log(`\n🧬 Streame Embeddings → chunks (mit Vektor)…`);
  const chunkIndexByDoc: Record<string, number> = {};
  let embRows: any[] = [];
  let embTotal = 0;
  let embSkipped = 0;

  const flushEmb = async () => {
    if (!embRows.length || dryRun) {
      embRows = [];
      return;
    }
    await db.insert(chunks).values(embRows).onConflictDoNothing();
    embRows = [];
  };

  const rl = createInterface({
    input: createReadStream(embeddingsFile).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as {
      id: number;
      knowledge_id: string;
      knowledge_base_id: string;
      content: string;
      embedding: string; // "[...]" (halfvec::text)
    };
    const wsId = wsIdByKb[e.knowledge_base_id];
    // Nur Chunks zu importierten Dokumenten
    if (!wsId || !importedDocIds.has(e.knowledge_id)) {
      embSkipped++;
      continue;
    }
    const idx = (chunkIndexByDoc[e.knowledge_id] =
      (chunkIndexByDoc[e.knowledge_id] ?? -1) + 1);
    embRows.push({
      id: `wek-${e.id}`, // deterministisch → idempotent
      document_id: e.knowledge_id,
      workspace_id: wsId,
      content: e.content || "",
      chunk_index: idx,
      token_count: (e.content || "").split(/\s+/).filter(Boolean).length,
      embedding: sql`${e.embedding}::vector`,
    });
    embTotal++;
    if (embRows.length >= BATCH) await flushEmb();
  }
  await flushEmb();
  console.log(`   ✅ ${embTotal} Chunks mit Embedding importiert (${embSkipped} übersprungen)`);

  // ── 4) Wiki-Seiten 1:1 importieren + chunken (Embedding folgt im Backfill) ──
  const wikiPagesData = readJsonlGzSync<WikiPage>(wikiFile);
  console.log(`\n📖 ${wikiPagesData.length} Wiki-Seiten aus Export`);
  let wikiCount = 0;

  for (const wp of wikiPagesData) {
    const wsId = wsIdByKb[wp.knowledge_base_id];
    if (!wsId) continue;
    if (dryRun) {
      wikiCount++;
      continue;
    }
    try {
      await db
        .insert(wikiPages)
        .values({
          id: wp.id,
          workspace_id: wsId,
          slug: (wp.slug || "").slice(0, 255),
          title: (wp.title || wp.slug || "Unbenannt").slice(0, 512),
          page_type: (wp.page_type || "article").slice(0, 20),
          status: (wp.status || "published").slice(0, 20),
          content: wp.content || "",
          summary: wp.summary || "",
          source_refs: wp.source_refs ?? [],
          chunk_refs: wp.chunk_refs ?? [],
          in_links: wp.in_links ?? [],
          out_links: wp.out_links ?? [],
          page_metadata: wp.page_metadata ?? {},
          aliases: wp.aliases ?? [],
          version: wp.version ?? 1,
          created_by: userId,
          created_at: wp.created_at ? new Date(wp.created_at) : new Date(),
          updated_at: wp.updated_at ? new Date(wp.updated_at) : new Date(),
        })
        .onConflictDoNothing();

      // Wiki-Content chunken (Embedding=NULL → wird von embedWorkspaceChunks nachgezogen)
      if (wp.content && wp.content.trim().length > 0) {
        const list = splitIntoChunks(wp.content, 512, 50);
        // vorhandene wiki--Chunks ersetzen (idempotent)
        await db
          .delete(chunks)
          .where(
            and(
              eq(chunks.document_id, `wiki--${wp.id}`),
              eq(chunks.workspace_id, wsId),
            ),
          );
        if (list.length) await saveChunks(`wiki--${wp.id}`, wsId, list);
      }
      wikiCount++;
    } catch (err: any) {
      console.warn(`   ⚠️ Wiki ${wp.slug}: ${err.message}`);
    }
  }
  console.log(`   ✅ ${wikiCount} Wiki-Seiten importiert + gechunkt`);

  console.log(`\n${"=".repeat(50)}`);
  console.log(`📊 Fertig: ${docCount} Docs, ${embTotal} Chunks(+Vektor), ${wikiCount} Wiki-Seiten`);
  console.log(
    dryRun
      ? `🏁 DRY-RUN – nichts geschrieben.`
      : `➡️  Nächster Schritt: Wiki-Chunks embedden (embedWorkspaceChunks pro Workspace).`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
async function ensureWorkspace(
  name: string,
  description: string,
  userId: number,
  dryRun: boolean,
): Promise<string> {
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.name, name))
    .limit(1);
  if (existing[0]) return existing[0].id;
  if (dryRun) return "dry-run";

  const [ws] = await db
    .insert(workspaces)
    .values({
      id: crypto.randomUUID(),
      name,
      description,
      created_by: userId,
      chunk_size: 512,
      chunk_overlap: 50,
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
  return ws.id;
}

main().catch((err) => {
  console.error("❌ Fehler:", err);
  process.exit(1);
});

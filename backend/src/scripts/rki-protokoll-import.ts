#!/usr/bin/env bun
/**
 * Stufe 2: RKI-Protokolle (Markdown + manifest.json) → Knora-Dokumente + Chunks
 *
 * Liest die Zwischenstufe aus rki-extract-md.ts. Bewusst NICHT über den
 * HTTP-Upload: der Parser-Container (MarkItDown, mem_limit 1g) wird gar nicht
 * beteiligt, und es werden weder Wiki-Generierung noch workspace-weite
 * Embedding-Sweeps ausgelöst – beides läuft kontrolliert in eigenen Stufen.
 *
 * Idempotent: die Dokument-ID ist ein UUIDv5 über (Gremium, Datum, Fassung).
 * Ein erneuter Lauf aktualisiert dieselbe Zeile statt Dubletten anzulegen, und
 * weil wiki-generate.ts den Wiki-Slug als `summary-<docId>` bildet, bleibt auch
 * der Wiki-Artikel stabil.
 *
 * Usage:
 *   bun run src/scripts/rki-protokoll-import.ts --manifest <md-dir>/manifest.json [Optionen]
 *
 * Optionen:
 *   --manifest <pfad>   manifest.json aus Stufe 0 (Pflicht)
 *   --workspace <name>  Ziel-Workspace, wird bei Bedarf angelegt
 *                       (Default: "RKI Sitzungsprotokolle")
 *   --owner <email>     Besitzer des Workspace (Default: erster Admin)
 *   --chunk-size <n>    Zielgröße der Chunks in Zeichen (Default 1500)
 *   --overlap <n>       Überlappung in Zeichen (Default 200)
 *   --limit <n>         nur die n frühesten Sitzungen
 *   --from-date <iso>   nur Sitzungen ab diesem Datum
 *   --to-date <iso>     nur Sitzungen bis zu diesem Datum
 *   --committee <name>  nur ein Gremium (Krisenstab | AG-nCoV | Lage-AG | Ressortbesprechung)
 *   --force             auch unveränderte Dokumente neu schreiben
 *   --dry-run           nichts schreiben, nur berichten
 */

import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/index.ts";
import { chunks, documents, users, workspaces } from "../db/schema.ts";
import * as documentService from "../service/document.ts";
import * as workspaceService from "../service/workspace.ts";
import { logActivity, updateLog } from "../service/activity-log.ts";
import {
  NORM_VERSION,
  type Committee,
  chunkProtocol,
  uuidv5,
} from "./lib/rki-protokoll.ts";

// ---------------------------------------------------------------------------
// Argumente
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const withEq = args.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const MANIFEST = argValue("manifest");
const WS_NAME = argValue("workspace") || "RKI Sitzungsprotokolle";
const OWNER_EMAIL = argValue("owner");
const CHUNK_SIZE = parseInt(argValue("chunk-size") || "1500", 10);
const OVERLAP = parseInt(argValue("overlap") || "200", 10);
const LIMIT = argValue("limit") ? parseInt(argValue("limit")!, 10) : undefined;
const FROM_DATE = argValue("from-date");
const TO_DATE = argValue("to-date");
const COMMITTEE = argValue("committee");
const FORCE = hasFlag("force");
const DRY = hasFlag("dry-run");

if (!MANIFEST) {
  console.error(
    "Usage: bun run src/scripts/rki-protokoll-import.ts --manifest <md-dir>/manifest.json [--workspace <name>] [--owner <email>] [--dry-run]",
  );
  process.exit(2);
}
if (!existsSync(MANIFEST)) {
  console.error(`❌ Manifest nicht gefunden: ${MANIFEST}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

interface ManifestEntry {
  key: string;
  sourceFile: string;
  sourceDir: string;
  fileName: string;
  ext: string;
  fileSize: number;
  fileHash: string;
  contentHash: string;
  mdFile: string | null;
  mdChars: number;
  committee: Committee | null;
  filenameDate: string | null;
  contentDate: string | null;
  contentWeekday: string | null;
  resolvedDate: string | null;
  dateSource: string;
  dateConflict: boolean;
  dateNote?: string;
  variant: string | null;
  variantRank: number;
  header: Record<string, unknown> & { teilnehmende: string[] };
  norm: Record<string, number>;
  normVersion: number;
  chunkCount: number;
  status: string;
  title: string;
  cancelled: boolean;
  isAgenda: boolean;
  wikiSkip: boolean;
  winner?: boolean;
  secondary?: boolean;
  group?: string;
}

const manifest: { norm_version: number; entries: ManifestEntry[] } = JSON.parse(
  readFileSync(MANIFEST, "utf8"),
);
const MD_DIR = path.dirname(MANIFEST);

if (manifest.norm_version !== NORM_VERSION) {
  console.warn(
    `⚠️  Manifest hat norm_version ${manifest.norm_version}, der Code erwartet ${NORM_VERSION}.\n` +
      `    Bitte rki-extract-md.ts erneut laufen lassen (--force), sonst passen Inhalt und Regeln nicht zusammen.`,
  );
}

// Importierbar sind die kanonischen Fassungen und die eigenständigen
// Nebenfassungen. Chronologisch sortieren: Entity-/Concept-Seiten wachsen in
// Stufe 4 dadurch als Chronik statt als Durcheinander, und --limit meint "die
// frühesten N".
let todo = manifest.entries
  .filter((e) => (e.winner || e.secondary) && e.mdFile && e.resolvedDate)
  .sort((a, b) =>
    a.resolvedDate! === b.resolvedDate!
      ? a.fileName.localeCompare(b.fileName, "de")
      : a.resolvedDate! < b.resolvedDate!
        ? -1
        : 1,
  );

if (COMMITTEE) todo = todo.filter((e) => e.committee === COMMITTEE);
if (FROM_DATE) todo = todo.filter((e) => e.resolvedDate! >= FROM_DATE);
if (TO_DATE) todo = todo.filter((e) => e.resolvedDate! <= TO_DATE);
if (LIMIT !== undefined) todo = todo.slice(0, LIMIT);

console.log(`📋 ${todo.length} Protokolle zum Import ausgewählt`);
if (DRY) console.log("🔎 DRY-RUN – es wird nichts geschrieben\n");

// ---------------------------------------------------------------------------
// Besitzer und Workspace
// ---------------------------------------------------------------------------

// Die Workspace-Liste filtert nach created_by bzw. workspace_members – ein
// falscher Besitzer macht den ganzen Import im Frontend unsichtbar.
let userId: number;
if (OWNER_EMAIL) {
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, OWNER_EMAIL))
    .limit(1);
  if (!u) {
    console.error(`❌ Kein User mit E-Mail ${OWNER_EMAIL} gefunden`);
    process.exit(1);
  }
  userId = u.id;
} else {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .limit(1);
  if (!admin) {
    console.error("❌ Kein Admin-User gefunden – bitte --owner <email> angeben");
    process.exit(1);
  }
  userId = admin.id;
}
console.log(`👤 created_by = ${userId}${OWNER_EMAIL ? ` (${OWNER_EMAIL})` : ""}`);

const [existingWs] = await db
  .select()
  .from(workspaces)
  .where(eq(workspaces.name, WS_NAME))
  .limit(1);

let workspaceId: string;
if (existingWs) {
  workspaceId = existingWs.id;
  console.log(`📂 Workspace "${WS_NAME}" vorhanden → ${workspaceId}`);
} else if (DRY) {
  workspaceId = "(dry-run)";
  console.log(`📂 Workspace "${WS_NAME}" würde angelegt`);
} else {
  // Über den Service, nicht per Direkt-Insert: createWorkspace legt
  // transaktional die workspace_members-Owner-Zeile mit an, auf der das
  // Berechtigungskonzept beruht.
  const ws = await workspaceService.createWorkspace({
    name: WS_NAME,
    description:
      "RKI-Sitzungsprotokolle 2020–2023 (Krisenstab, AG-nCoV, Lage-AG, Ressortbesprechung)",
    created_by: userId,
    chunk_size: CHUNK_SIZE,
    chunk_overlap: OVERLAP,
  });
  workspaceId = ws.id;
  await db
    .update(workspaces)
    .set({
      // wiki_depth bleibt zunächst "off": die Wiki-Generierung läuft
      // kontrolliert über rki-wiki-run.ts, nicht als Nebenwirkung des Imports.
      wiki_config: {
        auto_ingest: false,
        synthesis_model_id: null,
        wiki_language: "de",
        max_pages_per_ingest: 10,
        extraction_granularity: "focused",
        wiki_depth: "off",
      },
      indexing_strategy: {
        vector_enabled: true,
        keyword_enabled: true,
        wiki_enabled: true,
        graph_enabled: false,
      },
    })
    .where(eq(workspaces.id, workspaceId));
  console.log(`📂 Workspace "${WS_NAME}" angelegt → ${workspaceId}`);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** Stabile Dokument-ID: gleiche Sitzung + Fassung ⇒ gleiche ID. */
function docIdFor(e: ManifestEntry): string {
  const fassung = e.secondary ? `:${e.fileName}` : "";
  return uuidv5(`rki:${e.committee}:${e.resolvedDate}${fassung}`);
}

let inserted = 0;
let updated = 0;
let skipped = 0;
let failed = 0;
let chunksWritten = 0;
const t0 = Date.now();

const logId = DRY
  ? null
  : await logActivity({
      action: "rki_import",
      status: "started",
      message: `RKI-Protokoll-Import: ${todo.length} Sitzungen`,
      details: { count: todo.length, chunk_size: CHUNK_SIZE, overlap: OVERLAP },
      workspace_id: workspaceId,
      user_id: userId,
    });

for (let i = 0; i < todo.length; i++) {
  const e = todo[i];
  const pos = `[${String(i + 1).padStart(3)}/${todo.length}]`;

  try {
    const mdPath = path.join(MD_DIR, e.mdFile!);
    if (!existsSync(mdPath)) {
      console.warn(`${pos} ⚠️  ${e.title}: ${e.mdFile} fehlt – übersprungen`);
      failed++;
      continue;
    }
    const md = readFileSync(mdPath, "utf8");
    const docId = docIdFor(e);

    const chunkList = chunkProtocol(md, {
      targetChars: CHUNK_SIZE,
      overlapChars: OVERLAP,
      label: e.title,
    });

    const sourceMetadata = {
      doc_kind: "meeting_protocol",
      committee: e.committee,
      session_date: e.resolvedDate,
      original_filename: e.fileName,
      source_dir: e.sourceDir,
      variant: e.variant,
      is_agenda: e.isAgenda,
      is_secondary: !!e.secondary,
      date_source: e.dateSource,
      date_conflict: e.dateConflict,
      date_note: e.dateNote ?? null,
      filename_date: e.filenameDate,
      content_date: e.contentDate,
      weekday: e.header.wochentag ?? null,
      uhrzeit: e.header.uhrzeit ?? null,
      sitzungsort: e.header.sitzungsort ?? null,
      moderation: e.header.moderation ?? null,
      protokollfuehrung: e.header.protokollfuehrung ?? null,
      anlass: e.header.anlass ?? null,
      aktenzeichen: e.header.aktenzeichen ?? null,
      teilnehmende: e.header.teilnehmende ?? [],
      chars: e.mdChars,
      norm_version: manifest.norm_version,
      cancelled: e.cancelled,
      // Nebenfassungen, Ausfälle und Kurztexte bekommen keinen Wiki-Artikel
      wiki_skip: e.wikiSkip,
    };

    const existing = DRY ? null : await documentService.getDocument(docId);

    if (existing && existing.file_hash === e.fileHash && !FORCE) {
      const meta = (existing.source_metadata ?? {}) as Record<string, unknown>;
      if (
        meta.norm_version === manifest.norm_version &&
        existing.parse_status === "completed"
      ) {
        skipped++;
        continue;
      }
    }

    if (DRY) {
      console.log(
        `${pos} ${e.title.padEnd(38)} ${String(e.mdChars).padStart(6)} Z. → ${chunkList.length} Chunks${e.wikiSkip ? "  [kein Wiki]" : ""}`,
      );
      inserted++;
      chunksWritten += chunkList.length;
      continue;
    }

    // published_at auf 12:00 lokal: die Spalte ist ein timestamp ohne Zeitzone,
    // Mittag verhindert, dass das Datum durch Zeitzonen-Verschiebung kippt.
    const publishedAt = new Date(`${e.resolvedDate}T12:00:00`);

    if (existing) {
      // Update-Pfad: Inhalt und Chunks vollständig ersetzen. Alte Chunks neben
      // neuem Content stehen zu lassen wäre ein stiller Index-Fehler.
      await db
        .update(documents)
        .set({
          title: e.title,
          type: e.ext,
          source: e.fileName,
          file_path: e.sourceFile,
          file_size: e.fileSize,
          file_hash: e.fileHash,
          channel: e.committee,
          published_at: publishedAt,
          source_metadata: { ...sourceMetadata, wiki_stale: true },
          updated_at: new Date(),
        })
        .where(eq(documents.id, docId));
      await documentService.updateDocumentContent(docId, md);
      await db.delete(chunks).where(eq(chunks.document_id, docId));
      updated++;
    } else {
      await documentService.createDocument({
        id: docId,
        workspace_id: workspaceId,
        title: e.title,
        type: e.ext,
        source: e.fileName,
        content: md,
        file_path: e.sourceFile,
        file_size: e.fileSize,
        file_hash: e.fileHash,
        channel: e.committee,
        published_at: publishedAt,
        source_metadata: sourceMetadata,
        created_by: userId,
      });
      inserted++;
    }

    if (chunkList.length > 0) {
      await documentService.saveChunks(docId, workspaceId, chunkList);
      chunksWritten += chunkList.length;
    }
    // embedding bleibt NULL – Stufe 3 (embed-backfill.ts) übernimmt das
    // gebündelt mit Retry. Kein embedWorkspaceChunks() hier: das ist
    // workspace-weit und würde bei 381 Importen 381 überlappende Sweeps
    // über dieselben Zeilen auslösen.
    await documentService.updateDocumentStatus(
      docId,
      "completed",
      undefined,
      chunkList.length,
    );

    if ((i + 1) % 25 === 0 || i + 1 === todo.length) {
      console.log(
        `${pos} ${e.title.padEnd(38)} +${inserted} ~${updated} =${skipped} ✗${failed}  (${chunksWritten} Chunks)`,
      );
    }
  } catch (err: any) {
    // Eine kaputte Datei darf 381 nicht abbrechen.
    failed++;
    console.error(`${pos} ❌ ${e.title}: ${err.message}`);
  }
}

const durationMs = Date.now() - t0;

if (logId) {
  await updateLog(logId, {
    status: failed > 0 ? "completed" : "completed",
    message: `RKI-Import fertig: ${inserted} neu, ${updated} aktualisiert, ${skipped} unverändert, ${failed} fehlgeschlagen`,
    details: { inserted, updated, skipped, failed, chunks: chunksWritten },
    duration_ms: durationMs,
  });
}

console.log("\n" + "=".repeat(70));
console.log("IMPORT ABGESCHLOSSEN");
console.log("=".repeat(70));
console.log(`Neu angelegt:      ${inserted}`);
console.log(`Aktualisiert:      ${updated}`);
console.log(`Unverändert:       ${skipped}`);
console.log(`Fehlgeschlagen:    ${failed}`);
console.log(`Chunks geschrieben:${chunksWritten}`);
console.log(`Dauer:             ${(durationMs / 1000).toFixed(1)} s`);

if (!DRY) {
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.workspace_id, workspaceId));
  const [{ pending }] = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(chunks)
    .where(
      and(eq(chunks.workspace_id, workspaceId), sql`${chunks.embedding} is null`),
    );
  console.log(`\nDokumente im Workspace: ${total}`);
  console.log(`Chunks ohne Embedding:  ${pending}`);
  console.log(
    `\n➡️  Nächster Schritt:\n    bun run src/scripts/embed-backfill.ts ${workspaceId} --batch=64`,
  );
}

process.exit(0);

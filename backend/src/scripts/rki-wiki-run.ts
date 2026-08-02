#!/usr/bin/env bun
/**
 * Stufe 4: Wiki-Artikel für importierte Protokolle erzeugen – kontrolliert
 *
 * Ruft generateWikiArticles() dokumentweise auf, statt es wie der Upload-Pfad
 * unawaited zu feuern. Der Unterschied ist bei hunderten Dokumenten wesentlich:
 * sequenziell, abbrechbar, fortsetzbar, mit Kostenschätzung vor dem großen Lauf.
 *
 * Vor dem Start WIKI_EMBED_AFTER_GENERATE=0 setzen (siehe wiki-generate.ts):
 * sonst löst jeder Aufruf einen workspace-weiten Embedding-Sweep aus. Die
 * Embeddings der neuen Wiki-Chunks holt danach ein Lauf von embed-backfill.ts.
 *
 * Usage:
 *   WIKI_EMBED_AFTER_GENERATE=0 bun run src/scripts/rki-wiki-run.ts --workspace <id|name> [Optionen]
 *
 * Optionen:
 *   --workspace <id|name>  Ziel-Workspace (Pflicht)
 *   --depth <modus>        summary | capped | full – für die Dauer des Laufs
 *                          gesetzt und danach zurückgestellt
 *   --limit <n>            nur n Dokumente (chronologisch die frühesten)
 *   --from-date <iso>      nur Sitzungen ab diesem Datum
 *   --to-date <iso>        nur Sitzungen bis zu diesem Datum
 *   --committee <name>     nur ein Gremium
 *   --redo                 auch Dokumente neu generieren, die schon einen
 *                          Artikel haben
 *   --redo-stale           nur Dokumente neu generieren, deren Inhalt sich
 *                          seit der letzten Generierung geändert hat
 *   --sleep-ms <n>         Pause zwischen Dokumenten (Default 500)
 *   --dry-run              nur zeigen, was liefe, inkl. Kostenschätzung
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db/index.ts";
import { documents, wikiPages, workspaces } from "../db/schema.ts";
import { generateWikiArticles } from "../service/wiki-generate.ts";
import { logActivity, updateLog } from "../service/activity-log.ts";

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

const WS_ARG = argValue("workspace");
const DEPTH = argValue("depth");
const LIMIT = argValue("limit") ? parseInt(argValue("limit")!, 10) : undefined;
const FROM_DATE = argValue("from-date");
const TO_DATE = argValue("to-date");
const COMMITTEE = argValue("committee");
const REDO = hasFlag("redo");
const REDO_STALE = hasFlag("redo-stale");
const SLEEP_MS = parseInt(argValue("sleep-ms") || "500", 10);
const DRY = hasFlag("dry-run");

if (!WS_ARG) {
  console.error(
    "Usage: WIKI_EMBED_AFTER_GENERATE=0 bun run src/scripts/rki-wiki-run.ts --workspace <id|name> [--depth summary|capped] [--limit n] [--dry-run]",
  );
  process.exit(2);
}
if (DEPTH && !["summary", "capped", "full", "off"].includes(DEPTH)) {
  console.error(`❌ --depth muss summary | capped | full sein (war: ${DEPTH})`);
  process.exit(2);
}
if (process.env.WIKI_EMBED_AFTER_GENERATE !== "0") {
  console.warn(
    "⚠️  WIKI_EMBED_AFTER_GENERATE ist nicht 0 – jeder Aufruf startet einen\n" +
      "    workspace-weiten Embedding-Sweep. Bei vielen Dokumenten überlagern die\n" +
      "    sich und embedden Chunks doppelt. Empfohlen:\n" +
      "    WIKI_EMBED_AFTER_GENERATE=0 bun run src/scripts/rki-wiki-run.ts …\n",
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
  WS_ARG,
);
const [ws] = await db
  .select()
  .from(workspaces)
  .where(isUuid ? eq(workspaces.id, WS_ARG) : eq(workspaces.name, WS_ARG))
  .limit(1);

if (!ws) {
  console.error(`❌ Workspace nicht gefunden: ${WS_ARG}`);
  process.exit(1);
}
console.log(`📂 Workspace: ${ws.name} (${ws.id})`);

const originalDepth = (ws.wiki_config as any)?.wiki_depth ?? "capped";
const effectiveDepth = DEPTH ?? originalDepth;
console.log(
  `🎚️  Wiki-Tiefe: ${effectiveDepth}${DEPTH && DEPTH !== originalDepth ? ` (nur für diesen Lauf, danach zurück auf ${originalDepth})` : ""}`,
);
if (effectiveDepth === "off") {
  console.error(
    "❌ wiki_depth ist \"off\" – es würde nichts generiert. Mit --depth summary starten.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Dokumente auswählen
// ---------------------------------------------------------------------------

const conditions = [eq(documents.workspace_id, ws.id)];
if (COMMITTEE) conditions.push(eq(documents.channel, COMMITTEE));
if (FROM_DATE) {
  conditions.push(sql`${documents.published_at} >= ${FROM_DATE}::date`);
}
if (TO_DATE) {
  conditions.push(sql`${documents.published_at} <= ${TO_DATE}::date + 1`);
}

// Chronologisch: Themenseiten wachsen dadurch als Chronik statt als
// Durcheinander, und --limit meint "die frühesten N".
const allDocs = await db
  .select({
    id: documents.id,
    title: documents.title,
    channel: documents.channel,
    published_at: documents.published_at,
    content_len: sql<number>`coalesce(length(${documents.content}), 0)::int`,
    source_metadata: documents.source_metadata,
  })
  .from(documents)
  .where(and(...conditions))
  .orderBy(asc(documents.published_at), asc(documents.title));

// Bereits erzeugte Artikel finden.
//
// Bewusst NICHT über `parent_slug IS NULL`: rki-month-index.ts hängt die
// Sitzungsartikel unter Monats-Übersichtsseiten und setzt dabei parent_slug.
// Eine Prüfung darauf hielt danach alle 159 vorhandenen Artikel für fehlend
// und hätte den kompletten Lauf ein zweites Mal bezahlt.
//
// Stattdessen: eine summary-Seite zu diesem Dokument, die selbst keine
// Monatsseite ist. Monatsseiten haben ohnehin kein source_document_id, der
// Slug-Ausschluss ist nur die zweite Sicherung.
const doneRows = await db
  .select({ docId: wikiPages.source_document_id })
  .from(wikiPages)
  .where(
    and(
      eq(wikiPages.workspace_id, ws.id),
      eq(wikiPages.page_type, "summary"),
      sql`${wikiPages.slug} not like 'monat-%'`,
    ),
  );
const done = new Set(doneRows.map((r) => r.docId).filter(Boolean) as string[]);

let todo = allDocs.filter((d) => {
  const meta = (d.source_metadata ?? {}) as Record<string, unknown>;
  // Nebenfassungen, abgesagte Sitzungen und Kurztexte bekommen keinen Artikel:
  // aus 262 Zeichen "Ausfall des Krisenstabes" lässt sich keiner schreiben, ohne
  // zu erfinden.
  if (meta.wiki_skip === true) return false;
  if (d.content_len < 1200) return false;

  const alreadyDone = done.has(d.id);
  if (REDO) return true;
  if (REDO_STALE) return meta.wiki_stale === true;
  return !alreadyDone;
});

if (LIMIT !== undefined) todo = todo.slice(0, LIMIT);

const skippedNoWiki = allDocs.filter((d) => {
  const meta = (d.source_metadata ?? {}) as Record<string, unknown>;
  return meta.wiki_skip === true || d.content_len < 1200;
}).length;

// `done` zählt workspace-weit, nicht nur im Filter – das getrennt ausweisen,
// sonst liest sich "180 haben schon einen Artikel" bei 198 gefilterten
// Dokumenten so, als wären fast alle schon fertig.
const doneInFilter = allDocs.filter((d) => done.has(d.id)).length;
console.log(
  `📋 ${allDocs.length} Dokumente im Filter: ${doneInFilter} haben schon einen Artikel, ` +
    `${skippedNoWiki} ohne Artikel vorgesehen → ${todo.length} zu generieren ` +
    `(${done.size} Artikel im Workspace insgesamt)`,
);

if (todo.length === 0) {
  console.log("✅ Nichts zu tun.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Kostenschätzung
//
// Ein Modell-Preis ist nirgends in der App hinterlegt, deshalb nur Calls und
// Tokens – multipliziert mit dem Preis des eingestellten Modells ergibt das die
// Kosten. Die Zahlen folgen dem Ablauf in wiki-generate.ts.
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 3.3; // Deutsch, grob
const maxPages = (ws.wiki_config as any)?.max_pages_per_ingest ?? 10;
const generatesPages = effectiveDepth === "capped" || effectiveDepth === "full";

let estCalls = 0;
let estInChars = 0;
for (const d of todo) {
  // Schritt 2: Artikel – 1 Call, ganzes Dokument im Prompt
  estCalls += 1;
  estInChars += d.content_len + 3000; // + Prompt-Gerüst
  if (generatesPages) {
    // Schritt 1: Kandidaten-Extraktion – 1 Call je Kapitel (hier 1)
    estCalls += 1;
    estInChars += d.content_len + 4000;
    // Schritt 3: Chunk-Citation – 1 Call je ~12k Zeichen Chunk-Text
    const citationBatches = Math.max(1, Math.ceil((d.content_len * 1.1) / 12000));
    estCalls += citationBatches;
    estInChars += citationBatches * 14000;
    // Schritt 4: Themenseiten – je Seite 1 Call
    estCalls += maxPages;
    estInChars += maxPages * 8000;
  }
}
const estInTokens = Math.round(estInChars / CHARS_PER_TOKEN);
const estOutTokens = Math.round(estCalls * 1800); // Erfahrungswert je Antwort

console.log("\n" + "-".repeat(70));
console.log("SCHÄTZUNG");
console.log("-".repeat(70));
console.log(`LLM-Aufrufe:        ~${estCalls.toLocaleString("de-DE")}`);
console.log(`Input-Tokens:       ~${estInTokens.toLocaleString("de-DE")}`);
console.log(`Output-Tokens:      ~${estOutTokens.toLocaleString("de-DE")}`);
console.log(
  `Kosten bei 0,27 $/1M in + 1,10 $/1M out: ~${((estInTokens / 1e6) * 0.27 + (estOutTokens / 1e6) * 1.1).toFixed(2)} $`,
);
// 30 s je Aufruf ist der gemessene Mittelwert mit deepseek-chat bei ~16k
// Zeichen Eingabe und langer Ausgabe. Ein früherer Platzhalter von 6 s
// unterschätzte die Laufzeit um das Fünffache.
const SEC_PER_CALL = parseInt(process.env.WIKI_SEC_PER_CALL || "30");
console.log(
  `Laufzeit bei ~${SEC_PER_CALL} s/Aufruf: ~${((estCalls * SEC_PER_CALL) / 3600).toFixed(1)} h (sequenziell)`,
);
console.log("-".repeat(70) + "\n");

if (DRY) {
  for (const d of todo.slice(0, 40)) {
    console.log(
      `   ${(d.published_at?.toISOString().slice(0, 10) ?? "?")}  ${d.title.padEnd(38)} ${String(d.content_len).padStart(6)} Z.`,
    );
  }
  if (todo.length > 40) console.log(`   … und ${todo.length - 40} weitere`);
  console.log("\n🔎 DRY-RUN – es wurde nichts generiert.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Lauf
// ---------------------------------------------------------------------------

// wiki_depth wird pro Aufruf aus der DB gelesen, deshalb für die Dauer des Laufs
// setzen und im finally zurückstellen – kein Eingriff in die Signatur von
// generateWikiArticles().
async function setDepth(depth: string) {
  const [cur] = await db
    .select({ cfg: workspaces.wiki_config })
    .from(workspaces)
    .where(eq(workspaces.id, ws.id))
    .limit(1);
  await db
    .update(workspaces)
    .set({ wiki_config: { ...((cur?.cfg as object) ?? {}), wiki_depth: depth } })
    .where(eq(workspaces.id, ws.id));
}

const t0 = Date.now();
let ok = 0;
let failed = 0;
let entities = 0;
let concepts = 0;
/** Titel der Dokumente ohne Artikel – am Ende ausgeben, damit ein Ausfall nicht
 *  im Log untergeht und gezielt nachgefahren werden kann. */
const failedTitles: string[] = [];

const logId = await logActivity({
  action: "wiki_generate",
  status: "started",
  message: `RKI-Wiki-Lauf: ${todo.length} Protokolle (${effectiveDepth})`,
  details: { count: todo.length, depth: effectiveDepth },
  workspace_id: ws.id,
});

try {
  if (DEPTH && DEPTH !== originalDepth) await setDepth(DEPTH);

  for (let i = 0; i < todo.length; i++) {
    const d = todo[i];
    const pos = `[${String(i + 1).padStart(3)}/${todo.length}]`;
    const elapsed = (Date.now() - t0) / 1000;
    const perDoc = i > 0 ? elapsed / i : 0;
    const eta = perDoc > 0 ? ((todo.length - i) * perDoc) / 60 : 0;

    try {
      const result = await generateWikiArticles(d.id, ws.id);
      // Auf den Artikel prüfen, nicht auf das Rückgabeobjekt: generateWikiArticles
      // liefert seit dem Fix null, wenn keine Seite entstand.
      if (result?.summary) {
        ok++;
        entities += result.entities;
        concepts += result.concepts;
      } else {
        failed++;
        failedTitles.push(d.title);
        console.warn(`${pos} ⚠️  ${d.title}: kein Artikel erzeugt`);
      }
    } catch (err: any) {
      // Ein fehlgeschlagenes Dokument darf den Lauf nicht beenden – beim
      // nächsten Start wird es wieder aufgegriffen.
      failed++;
      failedTitles.push(d.title);
      console.error(`${pos} ❌ ${d.title}: ${err.message}`);
    }

    console.log(
      `${pos} ${d.title.padEnd(38)} ✓${ok} ✗${failed}  ${entities}E/${concepts}C  ` +
        `${elapsed.toFixed(0)}s${eta > 0 ? `, ETA ${eta.toFixed(0)} min` : ""}`,
    );

    if (SLEEP_MS > 0 && i < todo.length - 1) {
      await new Promise((r) => setTimeout(r, SLEEP_MS));
    }
  }
} finally {
  if (DEPTH && DEPTH !== originalDepth) {
    await setDepth(originalDepth);
    console.log(`\n🎚️  wiki_depth zurückgestellt auf "${originalDepth}"`);
  }
}

const durationMs = Date.now() - t0;
await updateLog(logId, {
  status: "completed",
  message: `RKI-Wiki-Lauf fertig: ${ok} Artikel, ${failed} fehlgeschlagen, ${entities} Entities, ${concepts} Concepts`,
  details: { ok, failed, entities, concepts, depth: effectiveDepth },
  duration_ms: durationMs,
});

const [{ pending }] = await db
  .select({ pending: sql<number>`count(*)::int` })
  .from(sql`chunks`)
  .where(sql`workspace_id = ${ws.id} and embedding is null`);

console.log("\n" + "=".repeat(70));
console.log("WIKI-LAUF ABGESCHLOSSEN");
console.log("=".repeat(70));
console.log(`Artikel erzeugt:   ${ok}`);
console.log(`Fehlgeschlagen:    ${failed}`);
if (failedTitles.length > 0) {
  console.log("\nOhne Artikel geblieben – erneuter Lauf greift sie automatisch auf:");
  for (const t of failedTitles) console.log(`  - ${t}`);
}
console.log(`Entity-Seiten:     ${entities}`);
console.log(`Concept-Seiten:    ${concepts}`);
console.log(`Dauer:             ${(durationMs / 60000).toFixed(1)} min`);
console.log(`Chunks ohne Embedding: ${pending}`);
if (pending > 0) {
  console.log(
    `\n➡️  Nächster Schritt:\n    bun run src/scripts/embed-backfill.ts ${ws.id} --batch=64`,
  );
}

process.exit(0);

#!/usr/bin/env bun
/**
 * Monats-Übersichtsseiten für die Sitzungsartikel – ohne LLM, ohne Kosten.
 *
 * Hunderte Sitzungsartikel liegen im Wiki-Browser als flache Kartenliste. Der
 * Browser kann aber eine zweistufige Hierarchie darstellen (parent_slug +
 * sort_order, wiki_pages_parent_idx). Dieses Skript nutzt sie: pro Monat und
 * Gremium entsteht eine Übersichtsseite, die zugehörigen Sitzungsartikel werden
 * ihre Kinder. Aus 378 Karten werden damit ~42 aufklappbare Monatsgruppen.
 *
 * Der Inhalt der Übersichtsseite ist ein deterministisch gebautes
 * Inhaltsverzeichnis (wie die bestehende Kapitel-Übersicht in
 * wiki-generate.ts) – kein LLM-Aufruf, keine Halluzinationsgefahr, beliebig oft
 * wiederholbar.
 *
 * Usage:
 *   bun run src/scripts/rki-month-index.ts --workspace <id|name> [Optionen]
 *
 * Optionen:
 *   --workspace <id|name>  Ziel-Workspace (Pflicht)
 *   --per-committee        eigene Monatsseite je Gremium (Default: eine je Monat
 *                          über alle Gremien)
 *   --reset                bestehende Monatsseiten löschen und Hierarchie lösen
 *   --dry-run              nur zeigen, was entstehen würde
 */

import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "../db/index.ts";
import { documents, wikiPages, workspaces } from "../db/schema.ts";
import * as wikiService from "../service/wiki.ts";

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
const hasFlag = (n: string) => args.includes(`--${n}`);

const WS_ARG = argValue("workspace");
const PER_COMMITTEE = hasFlag("per-committee");
const RESET = hasFlag("reset");
const DRY = hasFlag("dry-run");

if (!WS_ARG) {
  console.error(
    "Usage: bun run src/scripts/rki-month-index.ts --workspace <id|name> [--per-committee] [--reset] [--dry-run]",
  );
  process.exit(2);
}

const isUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(WS_ARG);
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

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

/** Slug einer Monatsseite. Stabil, damit Wiederholungen dieselbe Seite treffen. */
function monthSlug(month: string, committee: string | null): string {
  const c = committee
    ? "-" + committee.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    : "";
  return `monat-${month}${c}`;
}

function monthTitle(month: string, committee: string | null): string {
  const [y, m] = month.split("-");
  const name = MONTH_NAMES[parseInt(m, 10) - 1] ?? m;
  return committee ? `${name} ${y} · ${committee}` : `${name} ${y}`;
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

if (RESET) {
  // Erst die Kinder lösen, dann die Elternseiten löschen – sonst blieben
  // Artikel mit parent_slug auf eine nicht mehr existierende Seite zurück und
  // der Browser würde sie als verwaiste "Kapitel" anzeigen.
  const parents = await db
    .select({ slug: wikiPages.slug })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.workspace_id, ws.id),
        sql`${wikiPages.slug} like 'monat-%'`,
      ),
    );
  const parentSlugs = parents.map((p) => p.slug);
  console.log(`♻️  Reset: ${parentSlugs.length} Monatsseiten`);
  if (!DRY && parentSlugs.length > 0) {
    await db
      .update(wikiPages)
      .set({ parent_slug: null, sort_order: 0 })
      .where(
        and(
          eq(wikiPages.workspace_id, ws.id),
          inArray(wikiPages.parent_slug, parentSlugs),
        ),
      );
    await db
      .delete(wikiPages)
      .where(
        and(
          eq(wikiPages.workspace_id, ws.id),
          inArray(wikiPages.slug, parentSlugs),
        ),
      );
  }
}

// ---------------------------------------------------------------------------
// Sitzungsartikel sammeln
// ---------------------------------------------------------------------------

// Nur eigenständige Sitzungsartikel: parent_slug IS NULL schließt aus, dass
// bereits eingruppierte Kapitel doppelt behandelt werden. Monatsseiten selbst
// werden über den Slug-Präfix ausgenommen.
const articles = await db
  .select({
    slug: wikiPages.slug,
    title: wikiPages.title,
    summary: wikiPages.summary,
    flags: sql<string[] | null>`${wikiPages.page_metadata} -> 'flags'`,
    published_at: documents.published_at,
    channel: documents.channel,
  })
  .from(wikiPages)
  .innerJoin(documents, eq(wikiPages.source_document_id, documents.id))
  .where(
    and(
      eq(wikiPages.workspace_id, ws.id),
      eq(wikiPages.page_type, "summary"),
      sql`${wikiPages.slug} not like 'monat-%'`,
      isNotNull(documents.published_at),
    ),
  )
  .orderBy(asc(documents.published_at), asc(wikiPages.title));

console.log(`📋 ${articles.length} Sitzungsartikel mit Datum gefunden`);
if (articles.length === 0) {
  console.log("Nichts zu gruppieren – zuerst rki-wiki-run.ts laufen lassen.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Nach Monat (und optional Gremium) gruppieren
// ---------------------------------------------------------------------------

type Article = (typeof articles)[number];
const groups = new Map<string, { month: string; committee: string | null; items: Article[] }>();
for (const a of articles) {
  const d = a.published_at as Date;
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const committee = PER_COMMITTEE ? (a.channel ?? null) : null;
  const key = monthSlug(month, committee);
  if (!groups.has(key)) groups.set(key, { month, committee, items: [] });
  groups.get(key)!.items.push(a);
}

const sortedGroups = [...groups.entries()].sort((a, b) =>
  a[1].month === b[1].month
    ? (a[1].committee ?? "").localeCompare(b[1].committee ?? "", "de")
    : a[1].month.localeCompare(b[1].month),
);
console.log(`🗂️  ${sortedGroups.length} Monatsgruppen`);

// ---------------------------------------------------------------------------
// Seiten anlegen und Hierarchie setzen
// ---------------------------------------------------------------------------

let created = 0;
let updated = 0;
let attached = 0;

for (const [slug, g] of sortedGroups) {
  const title = monthTitle(g.month, g.committee);

  // Inhaltsverzeichnis: eine Zeile je Sitzung, mit Auffälligkeiten als Hinweis.
  // Bewusst ohne LLM – ein Verzeichnis ist eine Tatsache, keine Formulierung.
  const lines: string[] = [`# ${title}`, ""];
  const committees = [...new Set(g.items.map((i) => i.channel).filter(Boolean))];
  lines.push(
    `${g.items.length} Sitzung${g.items.length === 1 ? "" : "en"}` +
      (g.committee ? "" : committees.length ? ` (${committees.join(", ")})` : "") +
      ".",
  );
  lines.push("");
  lines.push("## Sitzungen");
  lines.push("");
  for (const a of g.items) {
    const d = a.published_at as Date;
    const day = String(d.getDate()).padStart(2, "0");
    const flags = Array.isArray(a.flags) ? a.flags : [];
    const flagNote = flags.length > 0 ? `  — ⚑ ${flags.join(", ")}` : "";
    lines.push(`- ${day}.: [[${a.slug}|${a.title}]]${flagNote}`);
    if (a.summary) lines.push(`  - ${a.summary}`);
  }
  const content = lines.join("\n");
  const summary = `Übersicht über ${g.items.length} Sitzung${g.items.length === 1 ? "" : "en"} im ${title}.`;

  if (DRY) {
    console.log(`   ${slug.padEnd(28)} ${title.padEnd(26)} ${g.items.length} Sitzungen`);
    continue;
  }

  const existing = await wikiService.getPage(ws.id, slug);
  if (existing) {
    // Bewusst OHNE { manual: true }: das würde die Handedit-Sperre setzen und
    // bei jedem Lauf eine Revision schreiben. Als Auto-Update respektiert der
    // Aufruf umgekehrt eine vom Nutzer bearbeitete Monatsseite und lässt sie
    // unangetastet – richtiges Verhalten für eine generierte Übersicht.
    await wikiService.updatePage(ws.id, slug, { title, content, summary });
    updated++;
  } else {
    await wikiService.createPage({
      workspace_id: ws.id,
      slug,
      title,
      content,
      summary,
      page_type: "summary",
      parent_slug: null,
      sort_order: 0,
      page_metadata: {
        origin: "month_index",
        month: g.month,
        committee: g.committee,
        session_count: g.items.length,
      },
    });
    created++;
  }

  // Artikel als Kinder einhängen; sort_order = Tag im Monat, damit die
  // Reihenfolge im Rail chronologisch ist.
  for (const a of g.items) {
    const d = a.published_at as Date;
    await wikiService.setPageHierarchy(ws.id, a.slug, {
      parent_slug: slug,
      sort_order: d.getDate(),
    });
    attached++;
  }
}

console.log("\n" + "=".repeat(66));
console.log(DRY ? "DRY-RUN – nichts geschrieben" : "MONATS-ÜBERSICHT FERTIG");
console.log("=".repeat(66));
console.log(`Monatsseiten neu:     ${created}`);
console.log(`Monatsseiten ersetzt: ${updated}`);
console.log(`Artikel eingehängt:   ${attached}`);
if (!DRY) {
  console.log(
    `\nHinweis: Die Monatsseiten werden wie andere Wiki-Seiten gechunkt.` +
      `\nFür die Vektorsuche noch embedden:\n    bun run src/scripts/embed-backfill.ts ${ws.id} --batch=64`,
  );
}

process.exit(0);

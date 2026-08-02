#!/usr/bin/env bun
/**
 * Auffälligkeits-Marker bestehender Artikel auf das geschlossene Vokabular
 * normalisieren – ohne LLM, also kostenlos und beliebig wiederholbar.
 *
 * Hintergrund: die erlaubten Marker standen nur im Prompt. Über 180 Protokolle
 * erfand das Modell zehn eigene Varianten (acht Schreibweisen für
 * "politischer_druck", "maßnahme_ohne_evidenz" mit ß). Die Facette
 * "Auffälligkeiten" zerfiel dadurch in Einzeltreffer. Der Generator normalisiert
 * jetzt beim Schreiben; dieses Skript zieht die schon vorhandenen Artikel nach.
 *
 * Usage:
 *   bun run src/scripts/rki-flags-normalize.ts --workspace <id|name> [--dry-run]
 */

import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/index.ts";
import { wikiPages, workspaces } from "../db/schema.ts";
import { normalizeProtocolFlags } from "../service/wiki-prompts.ts";

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const withEq = args.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return undefined;
}
const DRY = args.includes("--dry-run");
const WS_ARG = argValue("workspace");

if (!WS_ARG) {
  console.error(
    "Usage: bun run src/scripts/rki-flags-normalize.ts --workspace <id|name> [--dry-run]",
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

const pages = await db
  .select({
    id: wikiPages.id,
    title: wikiPages.title,
    meta: wikiPages.page_metadata,
  })
  .from(wikiPages)
  .where(
    and(
      eq(wikiPages.workspace_id, ws.id),
      sql`jsonb_typeof(${wikiPages.page_metadata} -> 'flags') = 'array'`,
    ),
  );

console.log(`📋 ${pages.length} Artikel mit Markern`);

let changed = 0;
const removed = new Map<string, number>();
const added = new Map<string, number>();

for (const p of pages) {
  const meta = (p.meta ?? {}) as Record<string, unknown>;
  const before = (Array.isArray(meta.flags) ? meta.flags : []).map(String);
  const after = normalizeProtocolFlags(before);

  const sameSet =
    before.length === after.length && before.every((f) => after.includes(f as any));
  if (sameSet) continue;

  for (const f of before) {
    if (!after.includes(f as any)) removed.set(f, (removed.get(f) || 0) + 1);
  }
  for (const f of after) {
    if (!before.includes(f)) added.set(f, (added.get(f) || 0) + 1);
  }

  if (!DRY) {
    await db
      .update(wikiPages)
      .set({ page_metadata: { ...meta, flags: after } })
      .where(eq(wikiPages.id, p.id));
  }
  changed++;
}

console.log("\n" + "=".repeat(62));
console.log(DRY ? "DRY-RUN – nichts geschrieben" : "MARKER NORMALISIERT");
console.log("=".repeat(62));
console.log(`Artikel geändert: ${changed} von ${pages.length}`);
if (removed.size > 0) {
  console.log("\nEntfernt (unbekannt oder auf einen kanonischen Marker abgebildet):");
  for (const [f, n] of [...removed.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}×  ${f}`);
  }
}
if (added.size > 0) {
  console.log("\nErgänzt (kanonische Form):");
  for (const [f, n] of [...added.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}×  ${f}`);
  }
}

process.exit(0);

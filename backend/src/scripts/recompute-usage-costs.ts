#!/usr/bin/env bun
/**
 * Rechnet `usage_events.cost_micros` mit der aktuellen Preistabelle neu.
 *
 * ## Wozu
 *
 * Die Preistabelle in `service/usage.ts` nannte bis zum 23. August 2026 die
 * Modelle `deepseek-chat` und `deepseek-reasoner`. Abgerechnet wird längst
 * `deepseek-v4-flash`. Für ein Modell ohne Preis schreibt `kostenMicros` eine
 * 0 — und weil eine 0 in einer Kostenspalte aussieht wie „war umsonst" und
 * nicht wie „wurde nicht bewertet", ist das monatelang niemandem aufgefallen.
 *
 * Genau dafür sind `tokens_in`/`tokens_out` von Anfang an getrennt von
 * `cost_micros` geführt worden: die Tokens sind gemessen und bleiben richtig,
 * der Preis ist geschätzt und lässt sich jederzeit neu rechnen. Dieses Skript
 * tut das.
 *
 * ## Was es nicht kann
 *
 * `tokens_cached` ist für alte Zeilen 0, weil das Feld damals nicht gelesen
 * wurde. Ihre Kosten werden deshalb als reine Cache-Miss-Läufe bewertet und
 * sind damit **zu hoch** — bei der Wiki-Generierung, wo dasselbe Transkript
 * mehrfach hingeht, spürbar. Das ist die richtige Richtung für eine
 * Kostenkontrolle, aber es ist eine Obergrenze und keine Messung.
 *
 * Posten mit fester Gebühr (`transcript_fetch`) bleiben unangetastet: sie
 * wurden nie über Tokens gerechnet.
 *
 * Aufruf:
 *   bun run src/scripts/recompute-usage-costs.ts [--dry-run] [--org <id>]
 */
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { usageEvents } from "../db/schema.ts";
import { kostenMicros, istBepreist, PREIS_VERSION } from "../service/usage.ts";

const dryRun = process.argv.includes("--dry-run");
const orgIdx = process.argv.indexOf("--org");
const orgId = orgIdx >= 0 ? process.argv[orgIdx + 1] : undefined;

const bedingungen = [
  isNotNull(usageEvents.model),
  // Nur token-basierte Posten. Ein Transkriptabruf hat 0 Tokens und eine
  // Festgebühr — die würde hier auf 0 gesetzt.
  gt(usageEvents.tokens_in, 0),
];
if (orgId) bedingungen.push(eq(usageEvents.organization_id, orgId));

const zeilen = await db
  .select({
    id: usageEvents.id,
    model: usageEvents.model,
    tokens_in: usageEvents.tokens_in,
    tokens_out: usageEvents.tokens_out,
    tokens_cached: usageEvents.tokens_cached,
    cost_micros: usageEvents.cost_micros,
    created_at: usageEvents.created_at,
  })
  .from(usageEvents)
  .where(and(...bedingungen));

console.log(`${zeilen.length} token-basierte Posten gefunden.`);

let geändert = 0;
let vorher = 0;
let nachher = 0;
const ohnePreis = new Map<string, number>();

for (const z of zeilen) {
  vorher += Number(z.cost_micros);

  if (!istBepreist(z.model)) {
    ohnePreis.set(z.model!, (ohnePreis.get(z.model!) ?? 0) + 1);
    nachher += Number(z.cost_micros);
    continue;
  }

  const neu = kostenMicros(
    z.model,
    z.tokens_in,
    z.tokens_out,
    z.tokens_cached,
    z.created_at,
  );
  nachher += neu;
  if (neu === Number(z.cost_micros)) continue;

  geändert++;
  if (!dryRun) {
    await db
      .update(usageEvents)
      .set({ cost_micros: neu, price_version: PREIS_VERSION })
      .where(eq(usageEvents.id, z.id));
  }
}

const euro = (m: number) => (m / 1_000_000).toFixed(2) + " €";
console.log(
  `${geändert} Posten ${dryRun ? "wären geändert worden" : "geändert"}.`,
);
console.log(`Summe vorher:  ${euro(vorher)}`);
console.log(`Summe nachher: ${euro(nachher)}`);

if (ohnePreis.size > 0) {
  console.warn("\nWeiterhin ohne Preis (bleiben unverändert):");
  for (const [m, n] of ohnePreis) console.warn(`  ${m}: ${n} Posten`);
  console.warn(
    "→ Diese Modelle in PREISE (src/service/usage.ts) eintragen und erneut laufen lassen.",
  );
}

if (dryRun) console.log("\n(--dry-run: nichts geschrieben)");
process.exit(0);

#!/usr/bin/env bun
/**
 * Einmaliger Lauf: verschlüsselt die API-Schlüssel in `model_providers`.
 *
 * Die Spalte heißt seit dem Livegang `api_key_encrypted` und enthielt Klartext.
 * Seit dem 21. August 2026 verschlüsselt `service/model.ts` beim Schreiben
 * (`service/crypto.ts`) — dieser Lauf holt den Bestand nach.
 *
 * Usage:
 *   docker compose --profile tools run --rm prowiki-tools \
 *     bun run src/scripts/encrypt-provider-keys.ts [--dry]
 *
 * **Idempotent.** Wer ihn zweimal laufen lässt, verschlüsselt nichts doppelt:
 * bereits verschlüsselte Werte tragen das Präfix `enc:v1:` und werden
 * übersprungen. Das ist wichtiger, als es klingt — ein doppelt verschlüsselter
 * Schlüssel wäre nicht kaputt, sondern **still falsch**: er entschlüsselt zu
 * `enc:v1:…` statt zu `sk-…`, und der Anbieter antwortet mit 401, was wie ein
 * abgelaufener Schlüssel aussieht.
 *
 * Voraussetzung: dieselbe `AUTH_SECRET` wie die laufende App. Mit einer anderen
 * werden die Schlüssel unlesbar — und weil AES-GCM authentifiziert, fällt das
 * beim Entschlüsseln als Fehler auf und nicht als stiller Unsinn.
 */
import { db } from "../db/index.ts";
import { modelProviders } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { verschlüssele, istVerschlüsselt, entschlüssele } from "../service/crypto.ts";

const trocken = process.argv.includes("--dry");

if (!process.env.AUTH_SECRET) {
  console.error(
    "❌ AUTH_SECRET fehlt. Mit einem anderen Wert als dem der laufenden App\n" +
      "   werden die Schlüssel unlesbar — Abbruch statt Schaden.",
  );
  process.exit(1);
}

const rows = await db
  .select({
    id: modelProviders.id,
    name: modelProviders.name,
    organization_id: modelProviders.organization_id,
    api_key_encrypted: modelProviders.api_key_encrypted,
  })
  .from(modelProviders);

console.log(`📊 ${rows.length} Provider gefunden${trocken ? " (Probelauf)" : ""}`);

let verschlüsselt = 0;
let schonGut = 0;
let fehler = 0;

for (const r of rows) {
  const org = r.organization_id ?? "NULL (Plattform)";
  if (istVerschlüsselt(r.api_key_encrypted)) {
    // Gegenprobe: lässt sich der Wert mit *diesem* AUTH_SECRET auch lesen? Ein
    // Präfix allein sagt nur, dass irgendwer ihn verschlüsselt hat.
    try {
      entschlüssele(r.api_key_encrypted);
      console.log(`   ✓ ${r.name} [${org}] – schon verschlüsselt, lesbar`);
      schonGut++;
    } catch (e: any) {
      console.error(
        `   ❌ ${r.name} [${org}] – verschlüsselt, aber mit diesem AUTH_SECRET NICHT lesbar: ${e.message}`,
      );
      fehler++;
    }
    continue;
  }

  if (trocken) {
    console.log(`   → ${r.name} [${org}] – würde verschlüsselt werden`);
    verschlüsselt++;
    continue;
  }

  const neu = verschlüssele(r.api_key_encrypted);
  // Vor dem Schreiben zurücklesen. Ein Rundlauf, der hier scheitert, hätte
  // sonst einen unbrauchbaren Schlüssel in der Tabelle hinterlassen.
  if (entschlüssele(neu) !== r.api_key_encrypted) {
    console.error(`   ❌ ${r.name} [${org}] – Rundlauf fehlgeschlagen, nicht geschrieben`);
    fehler++;
    continue;
  }
  await db
    .update(modelProviders)
    .set({ api_key_encrypted: neu, updated_at: new Date() })
    .where(eq(modelProviders.id, r.id));
  console.log(`   🔒 ${r.name} [${org}] – verschlüsselt`);
  verschlüsselt++;
}

console.log(
  `\n✨ ${verschlüsselt} verschlüsselt, ${schonGut} schon in Ordnung, ${fehler} Fehler`,
);
if (!trocken && fehler === 0 && verschlüsselt > 0) {
  console.log(
    "   Der Klartextpfad in service/crypto.ts ist damit nicht mehr nötig.\n" +
      "   Solange keine Warnung „[crypto] Mindestens ein API-Schlüssel liegt im Klartext\"\n" +
      "   mehr im Log erscheint, kann er entfallen.",
  );
}
process.exit(fehler > 0 ? 1 : 0);

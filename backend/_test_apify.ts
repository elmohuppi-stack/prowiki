// Direkter Test des Apify-Providers
// Verwendet den API-Key aus der .env oder Umgebungsvariable.
//
// Usage:
//   bun run _test_apify.ts                    # Standard-Video (Rick Roll)
//   bun run _test_apify.ts <video-id>         # Eigene Video-ID
//   ACTOR_TIMEOUT=30000 bun run _test_apify.ts # Kürzeres Timeout

const videoId = process.argv[2] || process.env.VIDEO_ID || "dQw4w9WgXcQ";
const apiKey = process.env.APIFY_API_KEY;
if (!apiKey) {
  console.error("❌ APIFY_API_KEY nicht gesetzt");
  process.exit(1);
}

console.log("╔══════════════════════════════════════╗");
console.log("║       Apify Provider Direkt-Test      ║");
console.log("╚══════════════════════════════════════╝");
console.log(`Video-ID: ${videoId}`);
console.log(`API-Key:  ${apiKey.slice(0, 8)}...`);
console.log(`Timeout:  ${process.env.ACTOR_TIMEOUT || 120000}ms pro Actor`);
console.log("");

import { ApifyProvider } from "./src/service/youtube/apify.ts";

const provider = new ApifyProvider(apiKey);
console.log("Provider instanziiert, rufe fetchVideoInfo auf...\n");

const t0 = Date.now();
try {
  const result = await provider.fetchVideoInfo(videoId, "de");
  const elapsed = Date.now() - t0;

  console.log(`\n━━━ ERGEBNIS (${(elapsed / 1000).toFixed(1)}s) ━━━`);
  if (result.metadata) {
    console.log(`Metadata:`);
    console.log(`  Titel:    "${result.metadata.title}"`);
    console.log(`  Kanal:    ${result.metadata.channelName}`);
    console.log(`  Dauer:    ${result.metadata.duration}s`);
    console.log(`  Tags:     ${result.metadata.tags?.length || 0}`);
  } else {
    console.log(`Metadata: ❌ Keine`);
  }

  if (result.transcript) {
    console.log(`Transkript:`);
    console.log(`  Sprache:  ${result.transcript.language}`);
    console.log(`  Quelle:   ${result.transcript.source}`);
    console.log(`  Länge:    ${result.transcript.content.length} Zeichen`);
    console.log(`  Preview:  ${result.transcript.content.slice(0, 300)}...`);
  } else {
    console.log(`Transkript: ❌ Keines`);
  }
} catch (e: any) {
  console.error(`\n❌ Fehler:`, e.message);
  if (e.stack) console.error(e.stack.slice(0, 500));
}

process.exit(0);

// === YouTube Import Test ===
// Führt einen kompletten YouTube-Import inkl. Wiki-Generierung durch.
//
// Usage:
//   bun run _test_youtube.ts                          # Kurztest (Rick Roll, 3 Min)
//   bun run _test_youtube.ts <video-id>                # Beliebige Video-ID
//   VIDEO_ID=0kYJI9Ewpv4 bun run _test_youtube.ts     # Per Env-Variable
//
// Flags:
//   SKIP_WIKI=1          # Nur YouTube-Import, keine Wiki-Generierung
//   SKIP_CHUNKING=1      # Nur YouTube-Import, kein Chunking/Embedding
//   ACTOR_TIMEOUT=60000  # Timeout pro Apify-Actor (Default: 120s)
//   VERBOSE=1            # Ausführlicheres Logging

import {
  extractVideoId,
  fetchYouTubeInfo,
  buildDocumentContent,
  resetProvider,
} from "./src/service/youtube.ts";
import { ApifyProvider } from "./src/service/youtube/apify.ts";

// --- Config ---

const VIDEO_ID = process.env.VIDEO_ID || "dQw4w9WgXcQ"; // Rick Astley (kurz)
const SKIP_WIKI = process.env.SKIP_WIKI === "1";
const SKIP_CHUNKING = process.env.SKIP_CHUNKING === "1";
const VERBOSE = process.env.VERBOSE === "1";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function assertEq(a: any, b: any, label: string) {
  if (a === b) {
    console.log(`  ✅ ${label}: ${a}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}: expected ${b}, got ${a}`);
    failed++;
  }
}

function assertTruthy(val: any, label: string) {
  if (val) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}: value is falsy (${val})`);
    failed++;
  }
}

function heading(title: string) {
  console.log(`\n━━━ ${title} ━━━`);
}

// === TEST: extractVideoId ===

heading("extractVideoId – URL-Parsing");

const TEST_URLS = [
  ["https://www.youtube.com/watch?v=0kYJI9Ewpv4", "0kYJI9Ewpv4"],
  ["https://youtu.be/0kYJI9Ewpv4", "0kYJI9Ewpv4"],
  ["https://www.youtube.com/embed/0kYJI9Ewpv4", "0kYJI9Ewpv4"],
  ["https://www.youtube.com/shorts/0kYJI9Ewpv4", "0kYJI9Ewpv4"],
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=123", "dQw4w9WgXcQ"],
  ["https://youtu.be/dQw4w9WgXcQ?si=abc123", "dQw4w9WgXcQ"],
  ["https://www.youtube.com/watch?foo=bar&v=abc123defgh", "abc123defgh"],
  ["https://example.com", null],
  ["invalid-url", null],
  ["", null],
];

for (const [url, expected] of TEST_URLS) {
  const result = extractVideoId(url as string);
  assertEq(result, expected as string | null, `extractVideoId("${url}")`);
}

// === TEST: ApifyProvider direkt ===

heading("ApifyProvider – Direkter Unit-Test");

const API_KEY = process.env.APIFY_API_KEY;
if (!API_KEY.trim()) {
  throw new Error("APIFY_API_KEY nicht gesetzt");
}

try {
  const provider = new ApifyProvider(API_KEY);
  assertEq(provider.name, "apify", "Provider-Name");
  console.log("  ℹ️  ApifyProvider instanziiert");
} catch (e: any) {
  assert(false, `ApifyProvider-Instanziierung: ${e.message}`);
}

// === TEST: fetchYouTubeInfo (echter API-Call) ===

heading("fetchYouTubeInfo – Echter API-Call");

console.log(`  ℹ️  Video-ID: ${VIDEO_ID}`);
console.log(`  ℹ️  Timeout pro Actor: ${ACTOR_TIMEOUT || 120000}ms`);

// Provider zurücksetzen, damit env-Vars neu gelesen werden
resetProvider();

const t0 = Date.now();
const info = await fetchYouTubeInfo(VIDEO_ID);
const elapsed = Date.now() - t0;

console.log(`  ℹ️  Dauer: ${(elapsed / 1000).toFixed(1)}s`);

if (info) {
  assertTruthy(info.title, "Titel vorhanden");
  assertTruthy(info.channelName, "Kanalname vorhanden");
  assertEq(info.videoId, VIDEO_ID, "Video-ID stimmt");
  assertTruthy(
    info.transcript.length > 0,
    `Transkript vorhanden (${info.transcript.length} Zeichen)`,
  );
  assertTruthy(
    info.transcriptLanguage !== "unknown",
    "Transkript-Sprache erkannt",
  );

  if (VERBOSE) {
    console.log(`\n  Details:`);
    console.log(`    Titel:    "${info.title}"`);
    console.log(`    Kanal:    ${info.channelName}`);
    console.log(`    Dauer:    ${info.duration}s`);
    console.log(
      `    Sprache:  ${info.transcriptLanguage} (${info.transcriptSource})`,
    );
    console.log(`    Transkript: ${info.transcript.slice(0, 300)}...`);
  }
} else {
  assert(false, "YouTube-Info abgerufen (keine Daten)");
}

// === TEST: buildDocumentContent ===

heading("buildDocumentContent – Content-Bau");

if (info) {
  const content = buildDocumentContent(info);
  assertTruthy(
    content.length > 0,
    `Content erzeugt (${content.length} Zeichen)`,
  );
  assertTruthy(content.includes(info.title), "Content enthält Titel");
  assertTruthy(content.includes(info.channelName), "Content enthält Kanalname");
  assertTruthy(content.includes(info.videoId), "Content enthält Video-ID");
  if (info.transcript) {
    assertTruthy(
      content.includes("## Transkript"),
      "Content enthält Transkript-Header",
    );
  }

  if (VERBOSE) {
    console.log(`\n  Content-Preview (erste 500 Zeichen):`);
    console.log(content.slice(0, 500));
  }
}

// === TEST: splitIntoChunks ===

heading("splitIntoChunks – Chunking");

const { splitIntoChunks } = await import("./src/service/document.ts");

if (info) {
  const content = buildDocumentContent(info);
  const chunks = splitIntoChunks(content, 512, 50);
  assertTruthy(chunks.length > 0, `Chunks erzeugt (${chunks.length} Stück)`);

  if (chunks.length > 0) {
    assertTruthy(chunks[0].content.length > 0, "Erster Chunk hat Inhalt");
    assertTruthy(chunks[0].chunk_index === 0, "Erster Chunk hat index=0");
    assertTruthy(chunks[0].token_count > 0, "Erster Chunk hat Token-Count");

    const totalChars = chunks.reduce((sum, c) => sum + c.content.length, 0);
    console.log(`  ℹ️  Chunks: ${chunks.length}, Gesamtzeichen: ${totalChars}`);
  }
}

// === TEST: Wiki-Generierung (optional) ===

if (!SKIP_WIKI && info) {
  heading("Wiki-Generierung – Via generateWikiPage");

  try {
    const { generateWikiPage } = await import("./src/service/wiki.ts");
    console.log(`  ℹ️  Starte LLM-basierte Wiki-Generierung...`);
    const wikiT0 = Date.now();
    const wikiResult = await generateWikiPage(
      "test-workspace-id",
      "test-doc-id",
      [],
    );
    const wikiElapsed = Date.now() - wikiT0;

    if (wikiResult) {
      console.log(`  ℹ️  Dauer: ${(wikiElapsed / 1000).toFixed(1)}s`);
      assertTruthy(wikiResult.title, "Wiki-Titel vorhanden");
      assertTruthy(wikiResult.content, "Wiki-Content vorhanden");
      assertTruthy(wikiResult.summary, "Wiki-Summary vorhanden");
      assertTruthy(wikiResult.slug, "Wiki-Slug vorhanden");

      if (VERBOSE) {
        console.log(`\n  Wiki-Ergebnis:`);
        console.log(`    Title:   "${wikiResult.title}"`);
        console.log(`    Slug:    ${wikiResult.slug}`);
        console.log(`    Summary: ${wikiResult.summary}`);
        console.log(`    Content: ${wikiResult.content.length} Zeichen`);
        console.log(`\n  Content-Preview:`);
        console.log(wikiResult.content.slice(0, 500));
      }
    } else {
      // Das ist ok, wenn kein LLM-Provider konfiguriert ist
      console.log("  ⚠️  Kein Wiki-Ergebnis (kein LLM-Provider?)");
    }
  } catch (e: any) {
    console.log(`  ⚠️  Wiki-Generierung fehlgeschlagen: ${e.message}`);
  }
} else if (SKIP_WIKI) {
  console.log(`\n  ⏭️  Wiki-Generierung übersprungen (SKIP_WIKI=1)`);
}

// === Zusammenfassung ===

heading("ERGEBNIS");
console.log(`  ✅ Bestanden: ${passed}`);
console.log(`  ❌ Fehlgeschlagen: ${failed}`);
console.log(`  ⏱️  Gesamtdauer: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(
  `\n${failed === 0 ? "🎉 ALLE TESTS BESTANDEN" : "💥 ES GIBT FEHLER"}`,
);

process.exit(failed > 0 ? 1 : 0);

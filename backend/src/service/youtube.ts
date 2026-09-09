// YouTube Video Import Service
// Nutzt konfigurierbare Provider (Apify, Supadata oder Direktzugriff).
// Auf Hetzner: Apify oder Supadata verwenden (YouTube ist von Hetzner-IPs gesperrt).
//
// Provider-Auswahl (via .env):
//   YOUTUBE_TRANSCRIPT_PROVIDER=apify     (explizit)
//   APIFY_API_KEY=...                      (auto-detect)
//   SUPADATA_API_KEY=...                   (auto-detect)
//   Weder noch → direkter Zugriff (nur lokal)

import { createProvider, getConfig } from "./youtube/registry.ts";
import type { YouTubeProvider, TranscriptSegment } from "./youtube/types.ts";
import { formatTimestamp, groupSegments } from "./youtube/segments.ts";

export interface YouTubeInfo {
  videoId: string;
  title: string;
  channelName: string;
  channelUrl: string;
  duration: number;
  thumbnailUrl: string;
  description: string;
  publishedAt: string;
  tags: string[];
  transcript: string;
  transcriptLanguage: string;
  transcriptSource: string;
  /** Leer, wenn der Provider keine Zeitmarken geliefert hat. */
  segments: TranscriptSegment[];
}

// YouTube-URL Patterns (wie WeKnora)
const URL_PATTERNS = [
  /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})/,
  /^(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
  /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
  /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
];

/** Einmalig initialisierter Provider (lazy singleton) */
let _provider: YouTubeProvider | null = null;

function getProvider(): YouTubeProvider {
  if (!_provider) {
    _provider = createProvider();
  }
  return _provider;
}

/**
 * Setzt den Provider zurück (nur für Tests).
 * Nächster Aufruf von getProvider() erzeugt einen neuen.
 */
export function resetProvider(): void {
  _provider = null;
}

/**
 * Extrahiert die YouTube-Video-ID aus einer URL.
 * Unterstützt: /watch?v=, youtu.be, /embed/, /shorts/
 */
export function extractVideoId(url: string): string | null {
  // Zuerst einfache "v" Parameter extrahieren
  try {
    const u = new URL(url);
    if (u.hostname === "youtube.com" || u.hostname.endsWith(".youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return v;
    }
  } catch {}

  // Regex-Patterns
  for (const pattern of URL_PATTERNS) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Sprache, in der das Transkript angefragt wird.
 *
 * Sie kommt aus `wiki_config.wiki_language` — derselben Einstellung, aus der
 * auch die Artikelgenerierung ihre Sprache nimmt (wiki-generate.ts). Vorher
 * griff hier still der Vorgabewert der Providersignatur, also immer "de".
 *
 * Das blieb folgenlos, solange kein Actor die Sprache beachtete. Mit
 * johnvc/YoutubeTranscripts ist es tragend: der Actor nimmt `languages` als
 * Prioritätsliste ernst, ein englischsprachiges Wiki hätte also die deutsche
 * Spur angefragt — und bei einem englischen Video im Zweifel eine
 * Übersetzung erhalten statt des Originals.
 *
 * Der Rückfall ist "de" wie in wiki-generate.ts, damit Transkript und Artikel
 * nicht auseinanderlaufen. Ein Fehler beim Lesen der Konfiguration darf den
 * Import nicht aufhalten: eine unpassende Sprache ist schlimmer als keine
 * Konfiguration, aber besser als ein abgebrochener Abruf.
 */
async function transkriptSprache(wikiId?: string): Promise<string> {
  if (!wikiId) return "de";
  try {
    const [{ db }, { wikis }, { eq }] = await Promise.all([
      import("../db/index.ts"),
      import("../db/schema.ts"),
      import("drizzle-orm"),
    ]);
    const [w] = await db
      .select({ config: wikis.wiki_config })
      .from(wikis)
      .where(eq(wikis.id, wikiId))
      .limit(1);
    return w?.config?.wiki_language || "de";
  } catch (e: any) {
    console.warn(
      `[youtube] Wiki-Sprache nicht lesbar (${e?.message}) – nutze "de"`,
    );
    return "de";
  }
}

/**
 * Ruft Metadaten + Transkript für ein YouTube-Video ab.
 * Nutzt den konfigurierten Provider (Apify → Supadata → Direktzugriff).
 *
 * Apify: Ein Actor-Call liefert Metadaten UND Transkript (schnell).
 * Supadata/Direct: Zwei separate Calls (parallel).
 */
export async function fetchYouTubeInfo(
  videoId: string,
  /**
   * Nur für die Kostenzählung. Ein Abruf kostet echtes Apify- oder
   * Supadata-Guthaben, und zwar je Video — beim Kanal-Import aus Stufe 1 ist
   * das der Posten, der als erster wehtut. Optional, damit vorhandene Aufrufer
   * greifen; ohne ihn bleibt der Abruf ungezählt.
   */
  wikiId?: string,
  /**
   * Das Dokument, zu dem der Abruf gehört. Vorher stand hier die Video-ID —
   * damit ließ sich der Posten zwar einem Video zuordnen, aber nicht der
   * Dokumentzeile in der Kostenübersicht, die über `documents.id` geht. Beim
   * Erstimport gibt es das Dokument noch nicht; der Aufrufer erzeugt die ID
   * deshalb vorher und legt sie danach mit dieser ID an.
   */
  documentId?: string,
): Promise<YouTubeInfo | null> {
  const provider = getProvider();

  const sprache = await transkriptSprache(wikiId);

  console.log(`[youtube] ========== fetchYouTubeInfo START ==========`);
  console.log(`[youtube] Video ID: ${videoId}`);
  console.log(`[youtube] Provider: ${provider.name}`);
  console.log(
    `[youtube] Sprache: ${sprache}${wikiId ? "" : " (kein Wiki – Vorgabe)"}`,
  );
  const t0 = Date.now();

  const { metadata, transcript } = await provider.fetchVideoInfo(
    videoId,
    sprache,
  );

  // Gezählt wird der **Abruf**, nicht der Erfolg: ein Anbieter, der nichts
  // liefert, hat trotzdem abgerechnet. Genau deshalb steht der Aufruf hier und
  // nicht hinter der Erfolgsprüfung weiter unten.
  if (wikiId) {
    const { USAGE, zähleNutzung, TRANSKRIPT_KOSTEN_MICROS } = await import(
      "./usage.ts"
    );
    await zähleNutzung({
      kind: USAGE.transcriptFetch,
      wikiId,
      model: provider.name,
      costMicros: TRANSKRIPT_KOSTEN_MICROS,
      refId: documentId ?? videoId,
    });
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[youtube] ========== fetchVideoInfo ENDE (${elapsed}ms) ==========`,
  );
  console.log(
    `[youtube] Metadaten: ${metadata ? "✅" : "❌"} ${metadata?.title || ""}`,
  );
  console.log(
    `[youtube] Transkript: ${transcript ? `✅ (${transcript.content.length} Zeichen, Sprache: ${transcript.language})` : "❌"}`,
  );

  if (!metadata && !transcript) {
    console.warn(
      `[youtube] FEHLER: Konnte KEINE Daten für Video ${videoId} abrufen`,
    );
    return null;
  }

  const result = {
    videoId,
    title: metadata?.title || `YouTube Video ${videoId}`,
    channelName: metadata?.channelName || "",
    channelUrl: metadata?.channelUrl || "",
    duration: metadata?.duration || 0,
    thumbnailUrl: metadata?.thumbnailUrl || "",
    description:
      metadata?.description ||
      `YouTube-Video von ${metadata?.channelName || "unbekannt"}`,
    // publishedAt + tags werden bisher hier verworfen – jetzt strukturiert
    // durchgereicht (Ebene 2: Filter/Sortierung).
    publishedAt: metadata?.publishedAt || "",
    tags: metadata?.tags || [],
    transcript: transcript?.content || "",
    transcriptLanguage: transcript?.language || "unknown",
    transcriptSource: transcript?.source || "unknown",
    segments: transcript?.segments || [],
  };

  console.log(
    `[youtube] Zeitmarken: ${result.segments.length > 0 ? `✅ ${result.segments.length} Segmente` : "❌ keine (Provider liefert nur Fließtext)"}`,
  );
  console.log(`[youtube] Dokument-Titel: "${result.title}"`);
  console.log(
    `[youtube] Transkript-Länge: ${result.transcript.length} Zeichen`,
  );
  if (result.transcript.length > 0) {
    console.log(
      `[youtube] Transkript-Preview: ${result.transcript.slice(0, 200)}...`,
    );
  }

  return result;
}

/**
 * Ein Textabschnitt des Dokuments und die Videostelle, aus der er stammt.
 * Zeichenbereich, weil das Chunking (documents.splitIntoChunks) zeichenweise
 * schneidet — nur so lässt sich einem Chunk hinterher ein Zeitfenster zuordnen.
 */
export interface ZeitAbschnitt {
  char_start: number;
  char_end: number;
  start_ms: number;
  end_ms: number | null;
}

export interface DokumentText {
  content: string;
  /** Leer, wenn das Transkript keine Zeitmarken hatte. */
  timeline: ZeitAbschnitt[];
}

/** Blockgröße der Zeitmarken im Dokumenttext (siehe groupSegments). */
const ZEITMARKEN_BLOCK_MS = 30_000;

/**
 * Baut den Text für Chunking/Embedding aus den YouTube-Info-Daten.
 *
 * Mit Zeitmarken bekommt jeder Transkriptblock eine Zeile der Form
 * `[12:34] …`. Das ist bewusst *im Text* und nicht nur in einer Nebentabelle:
 * Chunks, Sprachmodell-Kontext und Wiki-Generierung laufen alle über diesen
 * Text — eine Zeitmarke, die nur danebenliegt, käme in keinem Artikel an.
 */
export function buildDocumentContent(info: YouTubeInfo): string {
  return buildDocumentText(info).content;
}

/**
 * Wie buildDocumentContent, liefert zusätzlich die Zeichen-zu-Zeit-Zuordnung.
 * Getrennte Funktion, damit die vorhandenen Aufrufer unverändert bleiben.
 */
export function buildDocumentText(info: YouTubeInfo): DokumentText {
  const parts: string[] = [];

  parts.push(`# ${info.title}`);
  parts.push(``);
  parts.push(`**Kanal**: ${info.channelName}`);
  parts.push(`**URL**: https://www.youtube.com/watch?v=${info.videoId}`);
  parts.push(``);

  if (info.description) {
    parts.push(`**Beschreibung**: ${info.description}`);
    parts.push(``);
  }

  const timeline: ZeitAbschnitt[] = [];

  if (info.segments && info.segments.length > 0) {
    parts.push(`## Transkript\n`);
    // Kopf des Transkripts, bis zu dem der Text feststeht — ab hier zählen die
    // Zeichenpositionen der Blöcke.
    let offset = parts.join("\n").length + 1;

    const blöcke = groupSegments(info.segments, ZEITMARKEN_BLOCK_MS);
    for (const b of blöcke) {
      const zeile = `[${formatTimestamp(b.start_ms)}] ${b.text}`;
      parts.push(zeile);
      timeline.push({
        char_start: offset,
        char_end: offset + zeile.length,
        start_ms: b.start_ms,
        end_ms: b.end_ms,
      });
      // +1 für das "\n", mit dem parts später verbunden wird.
      offset += zeile.length + 1;
    }
  } else if (info.transcript) {
    // Kein Provider-Zeitraster → wie bisher reiner Fließtext.
    parts.push(`## Transkript\n`);
    parts.push(info.transcript);
  }

  const content = parts.join("\n");
  console.log(
    `[youtube] buildDocumentContent: ${content.length} Zeichen, ${timeline.length} Zeitblöcke`,
  );
  return { content, timeline };
}

/**
 * Zeitfenster für einen Zeichenbereich des Dokuments.
 *
 * Ein Chunk deckt in der Regel mehrere Zeitblöcke ab; genommen wird der Beginn
 * des ersten und das Ende des letzten überlappenden Blocks. Chunks, die nur den
 * Kopfbereich (Titel, Kanal, Beschreibung) treffen, ergeben null — ihnen eine
 * Zeit anzudichten wäre schlimmer als keine.
 */
export function zeitfensterFür(
  timeline: ZeitAbschnitt[],
  charStart: number,
  charEnd: number,
): { start_ms: number; end_ms: number | null } | null {
  const treffer = timeline.filter(
    (t) => t.char_start < charEnd && t.char_end > charStart,
  );
  if (treffer.length === 0) return null;

  return {
    start_ms: treffer[0].start_ms,
    end_ms: treffer[treffer.length - 1].end_ms,
  };
}

/**
 * Parst das YouTube-Upload-Datum in ein Date.
 * Apify liefert "YYYYMMDD", Supadata ein ISO-Datum. Null bei ungültig/leer.
 */
export function parsePublishedAt(raw: string): Date | null {
  if (!raw) return null;
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const d = new Date(`${compact[1]}-${compact[2]}-${compact[3]}T00:00:00Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

export interface YouTubeDocumentMetadata {
  channel: string | null;
  published_at: Date | null;
  duration: number | null;
  source_metadata: {
    channelUrl?: string;
    thumbnailUrl?: string;
    youtube_tags?: string[];
  };
}

/**
 * Baut die strukturierten Dokument-Metadaten (Ebene 2) aus YouTubeInfo.
 * channel/published_at/duration sind eigene DB-Spalten (Filter/Sortierung),
 * der Rest landet in source_metadata (jsonb).
 */
export function buildDocumentMetadata(info: YouTubeInfo): YouTubeDocumentMetadata {
  return {
    channel: info.channelName || null,
    published_at: parsePublishedAt(info.publishedAt),
    duration: info.duration || null,
    source_metadata: {
      ...(info.channelUrl ? { channelUrl: info.channelUrl } : {}),
      ...(info.thumbnailUrl ? { thumbnailUrl: info.thumbnailUrl } : {}),
      ...(info.tags && info.tags.length ? { youtube_tags: info.tags } : {}),
    },
  };
}

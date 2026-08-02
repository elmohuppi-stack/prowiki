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
import type { YouTubeProvider } from "./youtube/types.ts";

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
 * Ruft Metadaten + Transkript für ein YouTube-Video ab.
 * Nutzt den konfigurierten Provider (Apify → Supadata → Direktzugriff).
 *
 * Apify: Ein Actor-Call liefert Metadaten UND Transkript (schnell).
 * Supadata/Direct: Zwei separate Calls (parallel).
 */
export async function fetchYouTubeInfo(
  videoId: string,
): Promise<YouTubeInfo | null> {
  const provider = getProvider();

  console.log(`[youtube] ========== fetchYouTubeInfo START ==========`);
  console.log(`[youtube] Video ID: ${videoId}`);
  console.log(`[youtube] Provider: ${provider.name}`);
  const t0 = Date.now();

  const { metadata, transcript } = await provider.fetchVideoInfo(videoId);

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
  };

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
 * Baut den Text für Chunking/Embedding aus den YouTube-Info-Daten.
 */
export function buildDocumentContent(info: YouTubeInfo): string {
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

  if (info.transcript) {
    parts.push(`## Transkript\n`);
    parts.push(info.transcript);
  }

  const result = parts.join("\n");
  console.log(`[youtube] buildDocumentContent: ${result.length} Zeichen`);
  return result;
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

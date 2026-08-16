// YouTube Transcript Provider – Types & Interfaces
// Inspiriert von WeKnora's Go-Implementierung

/**
 * Ein Transkriptabschnitt mit Zeitmarke. Die Provider liefern das ohnehin —
 * knora hat es weggeworfen, weshalb kein Artikel auf eine Stelle im Video
 * verweisen konnte (siehe schema/content.ts, `transcript_segments`).
 */
export interface TranscriptSegment {
  /** Startzeit im Video in Millisekunden. */
  start_ms: number;
  /** Endzeit, falls der Provider sie kennt oder aus der Dauer ableitbar ist. */
  end_ms: number | null;
  text: string;
  /** Nur belegt, wenn ein Provider Sprechertrennung liefert. */
  speaker?: string | null;
}

/** Roh-Ergebnis eines Transcript-Providers */
export interface TranscriptResult {
  content: string;
  language: string;
  source: "native" | "auto_generated" | "ai_generated";
  /**
   * Leer, wenn der Provider nur Fließtext geliefert hat. Der Import muss
   * deshalb weiter ohne Zeitmarken funktionieren.
   */
  segments?: TranscriptSegment[];
}

/** Roh-Ergebnis eines Metadata-Providers */
export interface MetadataResult {
  videoId: string;
  title: string;
  channelName: string;
  channelUrl: string;
  duration: number; // Sekunden
  thumbnailUrl: string;
  description: string;
  publishedAt: string;
  tags: string[];
}

/** Kombiniertes Ergebnis aus einem einzelnen API-Call */
export interface VideoInfoResult {
  metadata: MetadataResult | null;
  transcript: TranscriptResult | null;
}

/** Interface für einen YouTube-Provider (Metadata + Transcript) */
export interface YouTubeProvider {
  readonly name: string;
  /** Einzelner Call: Holt Metadaten + Transkript in einem Request (bevorzugt) */
  fetchVideoInfo(
    videoId: string,
    preferredLang?: string,
  ): Promise<VideoInfoResult>;
  /** Nur Metadaten (Fallback wenn fetchVideoInfo keinen Transcript liefert) */
  fetchMetadata(videoId: string): Promise<MetadataResult | null>;
  /** Nur Transkript (Fallback wenn fetchVideoInfo keine Metadaten liefert) */
  fetchTranscript(
    videoId: string,
    preferredLang?: string,
  ): Promise<TranscriptResult | null>;
}

/** Konfiguration aus .env */
export interface YouTubeConfig {
  provider: "apify" | "supadata" | "direct" | "auto";
  apifyApiKey?: string;
  supadataApiKey?: string;
}

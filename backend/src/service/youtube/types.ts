// YouTube Transcript Provider – Types & Interfaces
// Inspiriert von WeKnora's Go-Implementierung

/** Roh-Ergebnis eines Transcript-Providers */
export interface TranscriptResult {
  content: string;
  language: string;
  source: "native" | "auto_generated" | "ai_generated";
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

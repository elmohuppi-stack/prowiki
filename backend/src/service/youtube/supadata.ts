// Supadata YouTube Transcript Provider
// Nutzt die Supadata API (https://supadata.ai) um YouTube-Transkripte + Metadaten zu holen.
// Läuft auf Supadata-Infrastruktur → funktioniert auch von Hetzner.
//
// API-Docs: https://docs.supadata.ai
// Endpoints:
//   GET /v1/metadata?url=...   → Video-Metadaten
//   GET /v1/transcript?url=... → Transkript (sync oder async job)

import type {
  YouTubeProvider,
  TranscriptResult,
  MetadataResult,
} from "./types.ts";

const SUPADATA_BASE = "https://api.supadata.ai/v1";
const REQUEST_TIMEOUT = 60_000;
const POLL_INTERVAL = 1_000;
const POLL_MAX_DURATION = 120_000;

// ---- API-Response-Typen ----

interface SupadataMetadataResponse {
  platform: string;
  type: string;
  id: string;
  url: string;
  title: string;
  description: string;
  author: {
    displayName: string;
    avatarUrl: string;
  };
  stats: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
  };
  media: {
    duration: number;
    thumbnailUrl: string;
  };
  tags: string[];
  createdAt: string;
  additionalData: {
    channelId: string;
  };
}

interface SupadataTranscriptResponse {
  content: string;
  lang: string;
  availableLangs: string[];
}

interface SupadataJobResponse {
  jobId: string;
}

interface SupadataJobStatusResponse {
  status: string;
  content: string;
  lang: string;
  error?: string;
}

// ---- SupadataProvider ----

export class SupadataProvider implements YouTubeProvider {
  readonly name = "supadata";
  private apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("SUPADATA_API_KEY is required");
    this.apiKey = apiKey;
  }

  private async request(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<Response> {
    const url = new URL(`${SUPADATA_BASE}${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const response = await fetch(url.toString(), {
      headers: { "x-api-key": this.apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    return response;
  }

  // ---- Kombinierter Call (ein API-Aufruf für beides) ----

  async fetchVideoInfo(
    videoId: string,
    preferredLang = "de",
  ): Promise<import("../youtube/types.ts").VideoInfoResult> {
    // Supadata hat getrennte Endpoints für Metadata und Transcript
    // Daher parallelisieren wir die beiden Calls
    const [metadata, transcript] = await Promise.all([
      this.fetchMetadata(videoId),
      this.fetchTranscript(videoId, preferredLang),
    ]);
    return { metadata, transcript };
  }

  // ---- Metadata ----

  async fetchMetadata(videoId: string): Promise<MetadataResult | null> {
    try {
      const videoURL = `https://www.youtube.com/watch?v=${videoId}`;
      const response = await this.request("/metadata", { url: videoURL });

      if (!response.ok) return null;

      const data = (await response.json()) as SupadataMetadataResponse;
      if (!data.title) return null;

      let channelUrl = "";
      if (data.additionalData?.channelId) {
        channelUrl = `https://www.youtube.com/channel/${data.additionalData.channelId}`;
      }

      return {
        videoId,
        title: data.title,
        channelName: data.author?.displayName || "",
        channelUrl,
        duration: data.media?.duration || 0,
        thumbnailUrl: data.media?.thumbnailUrl || "",
        description: data.description || "",
        publishedAt: data.createdAt || "",
        tags: data.tags || [],
      };
    } catch (e: any) {
      console.warn(`[supadata] fetchMetadata failed:`, e.message);
      return null;
    }
  }

  // ---- Transcript ----

  async fetchTranscript(
    videoId: string,
    preferredLang = "de",
  ): Promise<TranscriptResult | null> {
    try {
      const videoURL = `https://www.youtube.com/watch?v=${videoId}`;

      // Zuerst mit preferred language versuchen
      let result = await this.fetchTranscriptRaw(videoURL, preferredLang);
      if (result) return result;

      // Fallback: ohne language
      if (preferredLang) {
        result = await this.fetchTranscriptRaw(videoURL, "");
        if (result) return result;
      }

      return null;
    } catch (e: any) {
      console.warn(`[supadata] fetchTranscript failed:`, e.message);
      return null;
    }
  }

  private async fetchTranscriptRaw(
    videoURL: string,
    lang: string,
  ): Promise<TranscriptResult | null> {
    const params: Record<string, string> = {
      url: videoURL,
      text: "true",
      mode: "auto",
    };
    if (lang) params.lang = lang;

    const response = await this.request("/transcript", params);

    if (response.status === 202) {
      // Async Job → pollen
      const job = (await response.json()) as SupadataJobResponse;
      if (!job.jobId) return null;
      return await this.pollJob(job.jobId);
    }

    if (!response.ok) return null;

    const data = (await response.json()) as SupadataTranscriptResponse;
    if (!data.content) return null;

    return {
      content: data.content,
      language: data.lang || lang || "unknown",
      source: "native", // Supadata mode=auto liefert native oder ai-generiert
    };
  }

  private async pollJob(jobId: string): Promise<TranscriptResult | null> {
    const start = Date.now();

    while (Date.now() - start < POLL_MAX_DURATION) {
      try {
        const response = await this.request(`/transcript/${jobId}`, {});
        if (!response.ok) return null;

        const data = (await response.json()) as SupadataJobStatusResponse;

        if (data.status === "completed" && data.content) {
          return {
            content: data.content,
            language: data.lang || "unknown",
            source: "ai_generated",
          };
        }
        if (data.status === "failed") {
          console.warn(`[supadata] Job ${jobId} failed:`, data.error);
          return null;
        }
      } catch {
        // weitermachen
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }

    console.warn(
      `[supadata] Job ${jobId} timed out after ${POLL_MAX_DURATION}ms`,
    );
    return null;
  }
}

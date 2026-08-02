// Provider Registry – wählt automatisch den richtigen YouTube-Provider
// basierend auf Umgebungsvariablen (wie WeKnora's registry.go)

import type { YouTubeProvider, YouTubeConfig } from "./types.ts";
import { ApifyProvider } from "./apify.ts";
import { SupadataProvider } from "./supadata.ts";

/**
 * Ermittelt die YouTube-Konfiguration aus Umgebungsvariablen.
 *
 * Priorität:
 *   1. YOUTUBE_TRANSCRIPT_PROVIDER env (explizit: "apify" | "supadata")
 *   2. APIFY_API_KEY env → Apify
 *   3. SUPADATA_API_KEY env → Supadata
 *   4. Weder noch → "direct" (oEmbed + youtube-transcript, funktioniert nicht von Hetzner)
 */
export function getConfig(): YouTubeConfig {
  const forced = process.env.YOUTUBE_TRANSCRIPT_PROVIDER;

  if (forced === "apify") {
    return {
      provider: "apify",
      apifyApiKey: process.env.APIFY_API_KEY,
    };
  }
  if (forced === "supadata") {
    return {
      provider: "supadata",
      supadataApiKey: process.env.SUPADATA_API_KEY,
    };
  }

  // Auto-detect
  if (process.env.APIFY_API_KEY) {
    return {
      provider: "apify",
      apifyApiKey: process.env.APIFY_API_KEY,
    };
  }
  if (process.env.SUPADATA_API_KEY) {
    return {
      provider: "supadata",
      supadataApiKey: process.env.SUPADATA_API_KEY,
    };
  }

  // Weder noch → direkter Zugriff (oEmbed + youtube-transcript)
  // Funktioniert nicht von Hetzner, aber von lokalen Maschinen
  return { provider: "direct" };
}

/**
 * Erzeugt den konfigurierten YouTube-Provider.
 * Wirft einen Fehler, wenn kein Provider konfiguriert ist.
 */
export function createProvider(config?: YouTubeConfig): YouTubeProvider {
  const cfg = config || getConfig();

  switch (cfg.provider) {
    case "apify": {
      if (!cfg.apifyApiKey) {
        throw new Error(
          "APIFY_API_KEY nicht gesetzt – aber YOUTUBE_TRANSCRIPT_PROVIDER=apify oder APIFY_API_KEY env erwartet",
        );
      }
      console.log("[youtube] Using Apify provider");
      return new ApifyProvider(cfg.apifyApiKey);
    }
    case "supadata": {
      if (!cfg.supadataApiKey) {
        throw new Error(
          "SUPADATA_API_KEY nicht gesetzt – aber YOUTUBE_TRANSCRIPT_PROVIDER=supadata oder SUPADATA_API_KEY env erwartet",
        );
      }
      console.log("[youtube] Using Supadata provider");
      return new SupadataProvider(cfg.supadataApiKey);
    }
    case "direct":
    default: {
      console.log(
        "[youtube] Using direct provider (oEmbed + youtube-transcript)",
      );
      return createDirectProvider();
    }
  }
}

// ---- Direct Provider (oEmbed + youtube-transcript, bestehende Implementierung) ----

function createDirectProvider(): YouTubeProvider {
  // Dynamischer Import, damit das youtube-transcript package nur bei Bedarf geladen wird
  return {
    name: "direct",

    async fetchVideoInfo(videoId: string) {
      const [metadata, transcript] = await Promise.all([
        this.fetchMetadata(videoId),
        this.fetchTranscript(videoId),
      ]);
      return { metadata, transcript };
    },

    async fetchMetadata(videoId: string) {
      try {
        const videoURL = `https://www.youtube.com/watch?v=${videoId}`;
        const resp = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(videoURL)}&format=json`,
          { signal: AbortSignal.timeout(10000) },
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        return {
          videoId,
          title: data.title || "",
          channelName: data.author_name || "",
          channelUrl: data.author_url || "",
          duration: 0,
          thumbnailUrl: data.thumbnail_url || "",
          description: "",
          publishedAt: "",
          tags: [],
        };
      } catch {
        return null;
      }
    },

    async fetchTranscript(videoId: string) {
      try {
        const { YoutubeTranscript } = await import("youtube-transcript");
        const snippets = await YoutubeTranscript.fetchTranscript(videoId);
        if (!snippets || snippets.length === 0) return null;

        const text = snippets.map((s: any) => s.text).join(" ");
        const language = snippets[0]?.lang || "unknown";

        return {
          content: text,
          language,
          source: "native" as const,
        };
      } catch (e: any) {
        console.warn(`[youtube] Transcript fetch failed:`, e.message);
        return null;
      }
    },
  };
}

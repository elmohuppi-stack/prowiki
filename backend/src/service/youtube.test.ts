/**
 * Prüft die Zuordnung Text → Videostelle.
 *
 * Der wunde Punkt ist die Zeichenarithmetik in buildDocumentText: die Positionen
 * werden beim Bauen des Textes mitgezählt, der Text selbst aber erst am Ende
 * zusammengefügt. Verrutscht das um ein Zeichen, zeigt jeder Zeitstempel eines
 * Chunks auf die Nachbarstelle — ohne dass irgendetwas fehlschlägt.
 *
 * Ausführen: cd backend && bun test src/service/youtube.test.ts
 */
import { expect, test, describe } from "bun:test";
import {
  buildDocumentText,
  buildDocumentContent,
  zeitfensterFür,
  type YouTubeInfo,
} from "./youtube.ts";

function info(overrides: Partial<YouTubeInfo> = {}): YouTubeInfo {
  return {
    videoId: "abc12345678",
    title: "Testvideo",
    channelName: "Testkanal",
    channelUrl: "",
    duration: 600,
    thumbnailUrl: "",
    description: "Eine Beschreibung",
    publishedAt: "",
    tags: [],
    transcript: "",
    transcriptLanguage: "de",
    transcriptSource: "native",
    segments: [],
    ...overrides,
  };
}

/** Segmente im 5-Sekunden-Takt, wie YouTube sie liefert. */
function segmente(anzahl: number) {
  return Array.from({ length: anzahl }, (_, i) => ({
    start_ms: i * 5000,
    end_ms: (i + 1) * 5000,
    text: `Satz Nummer ${i}.`,
    speaker: null,
  }));
}

describe("buildDocumentText", () => {
  test("die Zeichenpositionen zeigen exakt auf ihre Zeile", () => {
    const { content, timeline } = buildDocumentText(
      info({ segments: segmente(20) }),
    );

    expect(timeline.length).toBeGreaterThan(1);
    for (const t of timeline) {
      const zeile = content.slice(t.char_start, t.char_end);
      // Genau die Zeile, samt eigener Zeitmarke – kein Versatz.
      expect(zeile.startsWith("[")).toBe(true);
      expect(zeile).toContain("] Satz Nummer");
      expect(zeile).not.toContain("\n");
    }
  });

  test("die Zeitmarke der Zeile passt zur Startzeit des Blocks", () => {
    const { content, timeline } = buildDocumentText(
      info({ segments: segmente(20) }),
    );
    // 20 Segmente à 5 s = 95 s → Blöcke bei 0 s und 30 s und 60 s und 90 s.
    expect(content).toContain("[0:00] ");
    expect(content).toContain("[0:30] ");
    expect(timeline[0].start_ms).toBe(0);
    expect(timeline[1].start_ms).toBe(30_000);
  });

  test("ohne Segmente bleibt es beim bisherigen Fließtext", () => {
    const { content, timeline } = buildDocumentText(
      info({ transcript: "Reiner Fließtext ohne Zeiten." }),
    );
    expect(timeline).toEqual([]);
    expect(content).toContain("Reiner Fließtext ohne Zeiten.");
    expect(content).not.toContain("[0:00]");
  });

  test("buildDocumentContent liefert weiterhin denselben Text", () => {
    const i = info({ segments: segmente(8) });
    expect(buildDocumentContent(i)).toBe(buildDocumentText(i).content);
  });
});

describe("zeitfensterFür", () => {
  const { timeline } = buildDocumentText(info({ segments: segmente(40) }));

  test("ein Chunk über mehrere Blöcke bekommt Anfang und Ende", () => {
    const fenster = zeitfensterFür(
      timeline,
      timeline[1].char_start,
      timeline[2].char_end,
    );
    expect(fenster?.start_ms).toBe(timeline[1].start_ms);
    expect(fenster?.end_ms).toBe(timeline[2].end_ms);
  });

  test("ein Chunk im Kopfbereich bekommt keine erfundene Zeit", () => {
    // Alles vor dem ersten Transkriptblock: Titel, Kanal, Beschreibung.
    expect(zeitfensterFür(timeline, 0, timeline[0].char_start)).toBeNull();
  });

  test("ohne Zeitleiste immer null", () => {
    expect(zeitfensterFür([], 0, 500)).toBeNull();
  });
});

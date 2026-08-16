/**
 * Prüfungen für die Zeitmarken-Auswertung.
 *
 * Der Schwerpunkt liegt auf der Frage, an der das Ganze scheitern würde:
 * Sekunden oder Millisekunden? Ein Faktor-1000-Fehler fällt in der Datenbank
 * nicht auf, aber jeder erzeugte Link zeigt dann auf die falsche Stelle.
 *
 * Ausführen: cd backend && bun test src/service/youtube/segments.test.ts
 */
import { expect, test, describe } from "bun:test";
import {
  parseTimecode,
  parseSegmentArray,
  parseSrt,
  extractSegments,
  groupSegments,
  formatTimestamp,
} from "./segments.ts";

describe("parseTimecode", () => {
  test("Stunden, Minuten, Sekunden", () => {
    expect(parseTimecode("00:12:34,560")).toBe(754_560);
    expect(parseTimecode("12:34")).toBe(754_000);
    expect(parseTimecode("1:02:34")).toBe(3_754_000);
  });

  test("blanke Zahlen bleiben unverändert (Skalierung entscheidet später)", () => {
    expect(parseTimecode(754)).toBe(754);
    expect(parseTimecode("754.5")).toBe(754.5);
  });

  test("Unbrauchbares ergibt null", () => {
    expect(parseTimecode("")).toBeNull();
    expect(parseTimecode(null)).toBeNull();
    expect(parseTimecode("keine Zeit")).toBeNull();
  });
});

describe("parseSegmentArray – Skalenerkennung", () => {
  test("Sekunden mit Nachkommastellen (Apify/youtube-transcript-Stil)", () => {
    const s = parseSegmentArray([
      { start: 0.0, dur: 3.5, text: "Erster Satz" },
      { start: 3.5, dur: 4.0, text: "Zweiter Satz" },
    ]);
    expect(s).toHaveLength(2);
    expect(s[0].start_ms).toBe(0);
    expect(s[1].start_ms).toBe(3500);
    expect(s[1].end_ms).toBe(7500);
  });

  test("Millisekunden per Feldname (Supadata: offset/duration)", () => {
    const s = parseSegmentArray([
      { text: "Hallo", offset: 0, duration: 2000 },
      { text: "Welt", offset: 2000, duration: 3000 },
    ]);
    expect(s[1].start_ms).toBe(2000);
    expect(s[1].end_ms).toBe(5000);
  });

  test("ganzzahlige Sekunden werden an der Videolänge erkannt", () => {
    // Ohne die Länge sähen 60/120 wie Millisekunden aus – mit ihr ist klar,
    // dass ein 600-Sekunden-Video hier in Sekunden getaktet ist.
    const s = parseSegmentArray(
      [
        { start: 60, text: "eine Minute" },
        { start: 120, text: "zwei Minuten" },
      ],
      600,
    );
    expect(s[0].start_ms).toBe(60_000);
    expect(s[1].start_ms).toBe(120_000);
  });

  test("große Ganzzahlen ohne Videolänge gelten als Millisekunden", () => {
    const s = parseSegmentArray([
      { start: 754_000, text: "a" },
      { start: 3_754_000, text: "b" },
    ]);
    expect(s[0].start_ms).toBe(754_000);
  });

  test("Zeilen ohne Text oder ohne Startzeit fallen heraus", () => {
    const s = parseSegmentArray([
      { start: 1.0, text: "  " },
      { text: "ohne Zeit" },
      { start: 2.0, text: "gut" },
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].text).toBe("gut");
  });

  test("unsortierte Eingabe wird nach Zeit geordnet", () => {
    const s = parseSegmentArray([
      { start: 10.0, text: "später" },
      { start: 2.0, text: "früher" },
    ]);
    expect(s.map((x) => x.text)).toEqual(["früher", "später"]);
  });

  test("fehlende Endzeit wird aus dem nächsten Start gefüllt", () => {
    const s = parseSegmentArray([
      { start: 0.0, text: "a" },
      { start: 5.0, text: "b" },
    ]);
    expect(s[0].end_ms).toBe(5000);
    // Das letzte Segment hat keinen Nachfolger – null statt einer erfundenen Zeit.
    expect(s[1].end_ms).toBeNull();
  });

  test("Unbrauchbares ergibt eine leere Liste, keinen Fehler", () => {
    expect(parseSegmentArray(null)).toEqual([]);
    expect(parseSegmentArray([])).toEqual([]);
    expect(parseSegmentArray([{ irgendwas: 1 }])).toEqual([]);
  });
});

describe("parseSrt", () => {
  test("SRT mit Blocknummern", () => {
    const srt = `1
00:00:00,000 --> 00:00:03,500
Erster Satz

2
00:12:34,560 --> 00:12:38,000
Zweiter Satz
über zwei Zeilen`;
    const s = parseSrt(srt);
    expect(s).toHaveLength(2);
    expect(s[0].end_ms).toBe(3500);
    expect(s[1].start_ms).toBe(754_560);
    expect(s[1].text).toBe("Zweiter Satz über zwei Zeilen");
  });

  test("WebVTT samt Kopfzeile, Auszeichnungen und Positionsangaben", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000 line:90% align:center
<c.colorE5E5E5>Hallo Welt</c>`;
    const s = parseSrt(vtt);
    expect(s).toHaveLength(1);
    expect(s[0].start_ms).toBe(1000);
    expect(s[0].text).toBe("Hallo Welt");
  });

  test("Text ohne Zeitzeilen ergibt nichts", () => {
    expect(parseSrt("nur Fließtext")).toEqual([]);
    expect(parseSrt("")).toEqual([]);
  });
});

describe("extractSegments", () => {
  test("findet die Segmente unter wechselnden Feldnamen", () => {
    expect(
      extractSegments({ captions: [{ start: 1.0, text: "a" }] }),
    ).toHaveLength(1);
    expect(
      extractSegments({ transcript: [{ offset: 1000, text: "a" }] }),
    ).toHaveLength(1);
  });

  test("weicht auf ein SRT-Feld aus", () => {
    const item = { srt: "1\n00:00:01,000 --> 00:00:02,000\nHallo" };
    expect(extractSegments(item)[0].start_ms).toBe(1000);
  });

  test("reiner Fließtext ergibt keine Segmente", () => {
    expect(extractSegments({ transcript_text: "Nur Text ohne Zeiten" })).toEqual(
      [],
    );
  });
});

describe("groupSegments", () => {
  test("fasst auf die Zielgröße zusammen", () => {
    // Zehn Segmente à 5 s = 50 s → bei 30 s Zielgröße zwei Blöcke.
    const roh = Array.from({ length: 10 }, (_, i) => ({
      start_ms: i * 5000,
      end_ms: (i + 1) * 5000,
      text: `s${i}`,
    }));
    const blöcke = groupSegments(roh, 30_000);
    expect(blöcke).toHaveLength(2);
    expect(blöcke[0].start_ms).toBe(0);
    expect(blöcke[1].start_ms).toBe(30_000);
    expect(blöcke[0].text).toBe("s0 s1 s2 s3 s4 s5");
  });

  test("ein Sprecherwechsel trennt auch innerhalb der Zielgröße", () => {
    const blöcke = groupSegments(
      [
        { start_ms: 0, end_ms: 1000, text: "a", speaker: "A" },
        { start_ms: 1000, end_ms: 2000, text: "b", speaker: "B" },
      ],
      30_000,
    );
    expect(blöcke).toHaveLength(2);
  });
});

describe("formatTimestamp", () => {
  test("passt zur Umrechnung in der Zitierregel", () => {
    expect(formatTimestamp(754_000)).toBe("12:34");
    expect(formatTimestamp(3_754_000)).toBe("1:02:34");
    expect(formatTimestamp(0)).toBe("0:00");
  });
});

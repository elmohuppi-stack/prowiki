/**
 * Zeitmarken aus Provider-Antworten herauslösen.
 *
 * Warum ein eigenes Modul: Die drei Apify-Actors und Supadata liefern dieselbe
 * Information in vier verschiedenen Formen — mal als Array von Objekten mit
 * `start`/`dur` in Sekunden, mal `offset`/`duration` in Millisekunden, mal als
 * SRT- oder VTT-Text. Jeder Provider hätte sonst seinen eigenen, leicht
 * abweichenden Parser, und ein Actor-Wechsel wäre wieder ein stiller Verlust
 * der Zeitmarken — genau der Fehler, der in knora unbemerkt blieb.
 *
 * Alles hier ist rein und ohne Netzwerk, damit es sich einzeln prüfen lässt.
 */
import type { TranscriptSegment } from "./types.ts";

/**
 * Feldnamen, unter denen die Provider die Startzeit führen. Die zuerst
 * genannten benennen die Einheit mit (bzw. sind bei Supadata dokumentiert als
 * Millisekunden) — siehe MS_KEYS.
 */
const START_KEYS = [
  "start_ms",
  "startMs",
  "offset",
  "offsetMs",
  "start",
  "startTime",
  "start_time",
  "begin",
  "from",
];

/**
 * Feldnamen, die die Einheit selbst festlegen. Nötig, weil die Größenordnung
 * allein trügt: Supadatas `offset: 2000` sind 2 Sekunden, gelesen als Sekunden
 * wären es 33 Minuten — jeder erzeugte Link zeigte auf die falsche Stelle.
 */
const MS_KEYS = [
  "start_ms",
  "startMs",
  "offset",
  "offsetMs",
  "end_ms",
  "endMs",
  "duration_ms",
  "durationMs",
];
const END_KEYS = ["end_ms", "endMs", "end", "endTime", "end_time", "to"];
const DUR_KEYS = ["dur", "duration", "duration_ms", "durationMs", "length"];
const TEXT_KEYS = ["text", "content", "caption", "snippet", "line"];
const SPEAKER_KEYS = ["speaker", "speaker_label", "speakerLabel", "author"];

function firstKey(obj: Record<string, unknown>, keys: string[]): unknown {
  return firstEntry(obj, keys).value;
}

/** Wie firstKey, gibt aber auch den Feldnamen zurück — der verrät die Einheit. */
function firstEntry(
  obj: Record<string, unknown>,
  keys: string[],
): { key: string | null; value: unknown } {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return { key: k, value: v };
  }
  return { key: null, value: undefined };
}

/**
 * Timecode `00:01:23,456` / `1:23.4` / `83` in Millisekunden.
 * Gibt null zurück, wenn nichts Verwertbares drinsteht.
 */
export function parseTimecode(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;

  const s = raw.trim().replace(",", ".");
  if (!s) return null;

  if (s.includes(":")) {
    const teile = s.split(":").map((t) => parseFloat(t));
    if (teile.some((t) => !Number.isFinite(t))) return null;
    // hh:mm:ss, mm:ss — von rechts aufsummieren, damit beides passt.
    let sekunden = 0;
    for (const t of teile) sekunden = sekunden * 60 + t;
    return Math.round(sekunden * 1000);
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Sekunden oder Millisekunden? Die Feldnamen allein verraten es nicht
 * (`start` ist bei einem Actor Sekunden, beim nächsten Millisekunden).
 *
 * Entschieden wird an den Werten selbst:
 *   1. Ist die Videolänge bekannt und die größte Startzeit deutlich größer,
 *      können es keine Sekunden sein.
 *   2. Sonst: Nachkommastellen sprechen für Sekunden (in Millisekunden gäbe
 *      niemand Bruchteile an).
 *   3. Sonst: eine Startzeit jenseits von 10 Stunden *in Sekunden* ist
 *      unplausibel — dann sind es Millisekunden.
 *
 * Rest-Unschärfe: Videos über 10 Stunden ohne bekannte Länge. Die gibt es bei
 * YouTube, sie sind hier aber nicht der Fall, und ein falsch skaliertes
 * Transkript fiele bei der ersten Sichtprüfung auf.
 */
function istInMillisekunden(
  werte: number[],
  durationSec?: number,
  msFeldname = false,
): boolean {
  // Nachkommastellen schlagen alles: in Millisekunden gäbe niemand Bruchteile
  // an. Das gilt auch gegen einen ms-Feldnamen, denn manche Bibliotheken führen
  // `offset` in Sekunden.
  if (werte.some((w) => !Number.isInteger(w))) return false;
  if (msFeldname) return true;
  if (durationSec && durationSec > 0) return max(werte) > durationSec * 1.5;
  return max(werte) > 36_000;
}

function max(werte: number[]): number {
  return Math.max(0, ...werte);
}

/**
 * Ein Array beliebig benannter Segment-Objekte in TranscriptSegments.
 * Unbekannte Strukturen ergeben eine leere Liste, keinen Fehler — ein Import
 * ohne Zeitmarken ist besser als ein abgebrochener Import.
 */
export function parseSegmentArray(
  raw: unknown,
  durationSec?: number,
): TranscriptSegment[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  interface Roh {
    start: number;
    end: number | null;
    dur: number | null;
    text: string;
    speaker: string | null;
  }

  const roh: Roh[] = [];
  // Wahr, sobald ein Eintrag die Startzeit unter einem Feldnamen führt, der die
  // Einheit Millisekunden festlegt.
  let msFeldname = false;

  for (const eintrag of raw) {
    if (!eintrag || typeof eintrag !== "object") continue;
    const o = eintrag as Record<string, unknown>;

    const text = firstKey(o, TEXT_KEYS);
    if (typeof text !== "string" || !text.trim()) continue;

    const startFeld = firstEntry(o, START_KEYS);
    const start = parseTimecode(startFeld.value);
    if (start === null) continue;
    if (startFeld.key && MS_KEYS.includes(startFeld.key)) msFeldname = true;

    const speaker = firstKey(o, SPEAKER_KEYS);
    roh.push({
      start,
      end: parseTimecode(firstKey(o, END_KEYS)),
      dur: parseTimecode(firstKey(o, DUR_KEYS)),
      text: text.trim(),
      speaker: typeof speaker === "string" && speaker ? speaker : null,
    });
  }

  if (roh.length === 0) return [];

  // Die Skala einmal für die ganze Liste bestimmen, nicht je Zeile: eine
  // zeilenweise Entscheidung könnte den Anfang eines Videos in Sekunden und
  // das Ende in Millisekunden lesen.
  const ms = istInMillisekunden(
    roh.map((r) => r.start),
    durationSec,
    msFeldname,
  );
  const skalieren = (v: number | null) =>
    v === null ? null : Math.round(ms ? v : v * 1000);

  return normalizeSegments(
    roh.map((r) => {
      const start = skalieren(r.start)!;
      const end =
        skalieren(r.end) ??
        (r.dur !== null ? start + (skalieren(r.dur) ?? 0) : null);
      return { start_ms: start, end_ms: end, text: r.text, speaker: r.speaker };
    }),
  );
}

/**
 * SRT und WebVTT — beides Zeilenblöcke mit `-->` in der Zeitzeile. Die kleinen
 * Unterschiede (VTT-Kopfzeile, Punkt statt Komma, fehlende Blocknummer) fallen
 * durch die Verarbeitung ohnehin heraus, deshalb ein Parser für beide.
 */
export function parseSrt(raw: string): TranscriptSegment[] {
  if (!raw || !raw.includes("-->")) return [];

  const segmente: TranscriptSegment[] = [];
  // Blöcke sind durch Leerzeilen getrennt (\r\n toleriert).
  for (const block of raw.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const zeilen = block.split("\n").filter((z) => z.trim() !== "");
    if (zeilen.length === 0) continue;

    const zeitIndex = zeilen.findIndex((z) => z.includes("-->"));
    if (zeitIndex === -1) continue;

    const [von, bis] = zeilen[zeitIndex].split("-->").map((t) => t.trim());
    const start = parseTimecode(von.split(/\s+/)[0]);
    if (start === null) continue;
    // WebVTT hängt an die Endzeit Positionsangaben ("… line:90%").
    const end = parseTimecode((bis || "").split(/\s+/)[0]);

    const text = zeilen
      .slice(zeitIndex + 1)
      .join(" ")
      // VTT-Auszeichnungen wie <c.colorE5E5E5> oder <00:00:01.000> entfernen.
      .replace(/<[^>]*>/g, "")
      .trim();
    if (!text) continue;

    segmente.push({ start_ms: start, end_ms: end, text, speaker: null });
  }

  return normalizeSegments(segmente);
}

/**
 * Sortieren, Leeres entfernen, offene Endzeiten aus dem jeweils nächsten
 * Startpunkt füllen. Ohne das kollidiert die Zuordnung von Chunks zu
 * Zeitfenstern an jeder Lücke.
 */
export function normalizeSegments(
  segmente: TranscriptSegment[],
): TranscriptSegment[] {
  const sauber = segmente
    .filter((s) => s.text.trim() !== "" && Number.isFinite(s.start_ms))
    .map((s) => ({
      ...s,
      start_ms: Math.max(0, Math.round(s.start_ms)),
      end_ms: s.end_ms !== null ? Math.round(s.end_ms) : null,
      text: s.text.trim(),
    }))
    .sort((a, b) => a.start_ms - b.start_ms);

  for (let i = 0; i < sauber.length; i++) {
    const naechster = sauber[i + 1];
    // Endzeit fehlt oder ist unplausibel (≤ Start) → bis zum nächsten Segment.
    if (sauber[i].end_ms === null || sauber[i].end_ms! <= sauber[i].start_ms) {
      sauber[i].end_ms = naechster ? naechster.start_ms : null;
    }
  }

  return sauber;
}

/**
 * Sucht in einem beliebigen Provider-Item nach dem, was Segmente sein könnte:
 * erst die üblichen Feldnamen, dann als letzte Möglichkeit ein SRT/VTT-Feld.
 *
 * Bewusst gutgläubig gegenüber Feldnamen und streng gegenüber Inhalten: die
 * Actors ändern ihre Ausgabefelder gelegentlich, ohne es anzukündigen.
 */
export function extractSegments(
  item: Record<string, unknown>,
  durationSec?: number,
): TranscriptSegment[] {
  const ARRAY_FELDER = [
    // `timestamped` führt johnvc/YoutubeTranscripts: Einträge der Form
    // { text, start: 0.32, duration: 4.72 } — Sekunden mit Nachkommastellen,
    // die istInMillisekunden an genau diesen Bruchteilen erkennt.
    "timestamped",
    "segments",
    "transcript_segments",
    "transcriptSegments",
    "captions",
    "chunks",
    "lines",
    "entries",
    "transcript",
    "transcript_json",
    "content",
    "data",
  ];

  for (const feld of ARRAY_FELDER) {
    const segmente = parseSegmentArray(item[feld], durationSec);
    if (segmente.length > 0) return segmente;
  }

  const TEXT_FELDER = [
    "srt",
    "transcript_srt",
    "vtt",
    "transcript_vtt",
    "subtitles",
    "transcript_text",
  ];
  for (const feld of TEXT_FELDER) {
    const wert = item[feld];
    if (typeof wert === "string") {
      const segmente = parseSrt(wert);
      if (segmente.length > 0) return segmente;
    }
  }

  return [];
}

/** `754000` → `12:34`, `3754000` → `1:02:34`. */
export function formatTimestamp(ms: number): string {
  const gesamt = Math.max(0, Math.floor(ms / 1000));
  const s = gesamt % 60;
  const m = Math.floor(gesamt / 60) % 60;
  const h = Math.floor(gesamt / 3600);
  const zwei = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${zwei(m)}:${zwei(s)}` : `${m}:${zwei(s)}`;
}

/**
 * Segmente zu größeren Blöcken zusammenfassen.
 *
 * YouTube liefert Untertitel in Häppchen von zwei bis fünf Sekunden. Eine
 * Zeitmarke je Häppchen wäre im Dokumenttext mehr Zeitmarke als Text — sie
 * würde die Einbettungen verrauschen und dem Sprachmodell hunderte nutzloser
 * Ankerpunkte anbieten. Blöcke von rund einer halben Minute sind grob genug für
 * lesbaren Text und fein genug, um im Video die Stelle zu finden.
 */
export function groupSegments(
  segmente: TranscriptSegment[],
  zielMs = 30_000,
): TranscriptSegment[] {
  if (segmente.length === 0) return [];

  const blöcke: TranscriptSegment[] = [];
  let aktuell: TranscriptSegment | null = null;

  for (const s of segmente) {
    const sprecherwechsel =
      aktuell !== null && (aktuell.speaker ?? null) !== (s.speaker ?? null);
    const zuLang =
      aktuell !== null && s.start_ms - aktuell.start_ms >= zielMs;

    if (aktuell === null || zuLang || sprecherwechsel) {
      aktuell = { ...s };
      blöcke.push(aktuell);
      continue;
    }

    aktuell.text += " " + s.text;
    aktuell.end_ms = s.end_ms ?? aktuell.end_ms;
  }

  return blöcke;
}

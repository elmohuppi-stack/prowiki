/**
 * RKI-Sitzungsprotokolle – reine Hilfsfunktionen (ohne DB, ohne I/O)
 *
 * Geteilt von rki-extract-md.ts, rki-protokoll-import.ts und rki-wiki-run.ts.
 * Bewusst ohne Seiteneffekte, damit die Regeln einzeln prüfbar sind.
 *
 * Enthält:
 *   - parseFileName()      Gremium + Datum + Variante aus dem Dateinamen
 *   - DATE_OVERRIDES       geprüfte Korrekturen für die 14 fehlerhaften Datumsangaben
 *   - resolveDate()        Dateiname vs. Datum im Dokument auflösen
 *   - normalizeProtocol()  textutil-Rohtext → strukturiertes Markdown
 *   - chunkProtocol()      protokollbewusstes Chunking an TOP-Grenzen
 *   - pickWinners()        Deduplizierung nach (Datum, Gremium)
 *   - uuidv5()             deterministische Dokument-IDs
 */

import { createHash } from "node:crypto";

/**
 * Version der Normalisierungsregeln. Bei jeder Änderung an normalizeProtocol()
 * hochzählen – der Import erkennt daran, dass ein Dokument neu geschrieben
 * werden muss, obwohl die Quelldatei unverändert ist.
 */
export const NORM_VERSION = 3;

export type Committee =
  | "Krisenstab"
  | "AG-nCoV"
  | "Lage-AG"
  | "Ressortbesprechung";

export type DateSource = "filename" | "content" | "override" | "directory";

export interface ProtocolHeader {
  /** Erste Zeile des Dokuments, z.B. 'Krisenstabssitzung „Neuartiges Coronavirus (COVID-19)"' */
  kopfzeile?: string;
  anlass?: string;
  datum_raw?: string;
  datum_iso?: string;
  wochentag?: string;
  uhrzeit?: string;
  sitzungsort?: string;
  moderation?: string;
  sitzungsleitung?: string;
  protokollfuehrung?: string;
  aktenzeichen?: string;
  /**
   * Teilnehmende mit Listenebene: 0 = Organisationseinheit ("FG36"),
   * 1 = Person darunter ("Walter Haas"). Die Ebene stammt aus dem docx-XML,
   * weil textutil sie verwirft – ohne sie wäre nicht erkennbar, wer zu welcher
   * Einheit gehört.
   */
  teilnehmende: { text: string; level: number }[];
}

export interface NormStats {
  zeilen: number;
  topUeberschriften: number;
  unterUeberschriften: number;
  bullets: number;
  entfernteZeilen: number;
  seitenumbrueche: number;
  eingebrachtVon: number;
}

export interface ProtocolChunk {
  content: string;
  chunk_index: number;
  token_count: number;
}

// ---------------------------------------------------------------------------
// Dateiname → Metadaten
// ---------------------------------------------------------------------------

/**
 * Gremium aus dem Dateinamen. Reihenfolge ist wichtig: "Lage-AG-nCoV" muss vor
 * "AG-nCoV" greifen, sonst werden die Lage-AG-Sitzungen von Januar 2020 falsch
 * einsortiert.
 */
function detectCommittee(fileName: string): Committee | null {
  if (/Lage[-_ ]?AG/i.test(fileName)) return "Lage-AG";
  if (/Krisenstabs?s?itzung/i.test(fileName)) return "Krisenstab";
  if (/AG[-_ ]?nCoV/i.test(fileName)) return "AG-nCoV";
  if (/Ressortbesprechung/i.test(fileName)) return "Ressortbesprechung";
  return null;
}

/**
 * Varianten-Rang: höher gewinnt bei der Deduplizierung. Die Stufen spiegeln,
 * wie "endgültig" eine Fassung ist – eine korrigierte Version schlägt die
 * Basisdatei, die Basisdatei schlägt den Entwurf.
 */
const VARIANT_RANKS: { pattern: RegExp; label: string; rank: number }[] = [
  { pattern: /(^|[_\-. ])korr\.?([_\-. ]|$)/i, label: "korr", rank: 60 },
  { pattern: /aktualiert|aktualisiert/i, label: "aktualisiert", rank: 55 },
  { pattern: /clean/i, label: "clean", rank: 50 },
  { pattern: /_V2|-V2/i, label: "V2", rank: 45 },
  { pattern: /mit[_ ]Aufgaben/i, label: "mit Aufgaben", rank: 30 },
  { pattern: /prefinal/i, label: "prefinal", rank: 20 },
  { pattern: /Anmerkungen/i, label: "Anmerkungen", rank: 20 },
  { pattern: /Kommentare/i, label: "Kommentare", rank: 20 },
  { pattern: /Entwurf|Draft/i, label: "Entwurf", rank: 10 },
];

/** Kürzel-Suffixe von Bearbeitern (z.B. _DJ, _BR, -UR) – nachrangig. */
const INITIALS_SUFFIX = /[_-](DJ|DJO|BR|UR|WH|ma|IBBS)([_.-]|$)/i;

export function parseFileName(fileName: string): {
  committee: Committee | null;
  filenameDate: string | null;
  variant: string | null;
  variantRank: number;
} {
  const committee = detectCommittee(fileName);

  // ISO-artig: 2020-03-04, 2020_03_04, 2020.03.04
  let filenameDate: string | null = null;
  const iso = fileName.match(/(20\d{2})[-_.](\d{2})[-_.](\d{2})/);
  if (iso) {
    filenameDate = `${iso[1]}-${iso[2]}-${iso[3]}`;
  } else {
    // Leerzeichen-getrennt, zweistelliges Jahr: "… Long-COVID 21 06 08.docx"
    const sp = fileName.match(/\b(\d{2})[ _](\d{2})[ _](\d{2})\b/);
    if (sp) filenameDate = `20${sp[1]}-${sp[2]}-${sp[3]}`;
  }

  // Variante nur im Namensrest suchen (ohne Datum und Endung), damit z.B. eine
  // "03" im Datum nicht als Kürzel missgedeutet wird.
  const rest = fileName
    .replace(/(20\d{2})[-_.](\d{2})[-_.](\d{2})/, "")
    .replace(/\.[A-Za-z]+$/, "");

  let variant: string | null = null;
  let variantRank = 40; // Basisdatei ohne Marker
  for (const v of VARIANT_RANKS) {
    if (v.pattern.test(rest)) {
      variant = v.label;
      variantRank = v.rank;
      break;
    }
  }
  if (variant === null) {
    const m = rest.match(INITIALS_SUFFIX);
    if (m) {
      variant = m[1];
      variantRank = 30;
    }
  }

  return { committee, filenameDate, variant, variantRank };
}

// ---------------------------------------------------------------------------
// Datums-Korrekturen
// ---------------------------------------------------------------------------

/**
 * Geprüfte Datumskorrekturen, Schlüssel ist "<Verzeichnis>/<Dateiname>".
 *
 * Zwei Fehlerklassen im Quellmaterial:
 *   (a) Dateiname und Datum im Dokument widersprechen sich (13 Dateien)
 *   (b) beide nennen dasselbe, aber falsche Jahr – im Original wurde die
 *       Vorjahresvorlage kopiert (4 Dateien, alle Januar/Februar)
 *
 * Belege sind der Wochentag, die Existenz einer eigenen Datei für den
 * konkurrierenden Termin, und bei (b) Anachronismen im Text.
 */
export const DATE_OVERRIDES: Record<
  string,
  { date: string; reason: string; sicher: boolean }
> = {
  // --- (b) Vorjahresvorlage kopiert: Text nennt 2020, Inhalt ist 2021 ---
  "2021 Original/Ergebnisprotokoll_Krisenstabssitzung_2020-01-08.docx": {
    date: "2021-01-08",
    reason:
      "Text nennt 08.01.2020, erwähnt aber BioNTech, Impfquote, 7-Tage-Inzidenz und Lockdown – unmöglich im Januar 2020. 2021-01-08 ist unbelegt.",
    sicher: true,
  },
  "2021 Original/Ergebnisprotokoll_Krisenstabssitzung_2020-01-08_aktualiert.docx":
    {
      date: "2021-01-08",
      reason: "Variante derselben Sitzung wie oben.",
      sicher: true,
    },
  "2021 Original/Ergebnisprotokoll_Krisenstabssitzung_2020-01-15.docx": {
    date: "2021-01-15",
    reason:
      "Text nennt 15.01.2020, erwähnt aber 6× die 7-Tage-Inzidenz – dieses Konzept existierte im Januar 2020 nicht. 2021-01-15 ist unbelegt.",
    sicher: true,
  },
  "2021 Original/Ergebnisprotokoll_Krisenstabssitzung_2020-02-19.docx": {
    date: "2021-02-19",
    reason:
      "Text nennt 19.02.2020, erwähnt aber B.1.1.7 (4×) und B.1.351 (2×) – beide erst ab Dezember 2020 benannt. 2021-02-19 ist unbelegt.",
    sicher: true,
  },

  // --- (a) Dateiname falsch, Datum im Dokument gewinnt ---
  "2021 Original/Ergebnisprotokoll_Krisenstabssitzung_2020-01-11.docx": {
    date: "2021-01-11",
    reason:
      "Dateiname wäre ein Samstag; das Dokument nennt 11.01.2021 (Montag). 2021-01-11 ist unbelegt.",
    sicher: true,
  },
  "2021 Original/Ergebnisprotokoll_Krisenstabssitzung_2020-01-25.docx": {
    date: "2021-01-25",
    reason:
      "Dateiname wäre ein Samstag; das Dokument nennt 25.01.2021 (Montag). 2021-01-25 ist unbelegt.",
    sicher: true,
  },
  "2020 Original/Ergebnisprotokoll_AG-nCoV-Sitzung_2020-01-25.docx": {
    date: "2020-01-24",
    reason:
      "Dateiname wäre ein Samstag; das Dokument nennt 24.01.2020. Damit ist dies die Endfassung zu AG-nCoV-Sitzung_2020-01-24_Entwurf.docx und wird mit ihr dedupliziert.",
    sicher: true,
  },
  "2022 Original/Ergebnisprotokoll_Krisenstabssitzung_2021-01-14.docx": {
    date: "2022-01-14",
    reason:
      "Dokument nennt 14.01.2022 (Freitag, passt), Datei liegt in „2022 Original“. 2022-01-14 ist unbelegt.",
    sicher: true,
  },
  "2023 Original/Ergebnisprotokoll_Lage-AG-Sitzung_2022-02-15.docx": {
    date: "2023-02-15",
    reason:
      "Dokument nennt 15.02.2023 (Mittwoch, passt zur Lage-AG-Kadenz), Datei liegt in „2023 Original“. 2023-02-15 ist unbelegt.",
    sicher: true,
  },

  // --- (a) Datum im Dokument falsch, Dateiname gewinnt ---
  "2021 Original/Ergebnisprotokoll_Krisenstabsitzung_2021-01-22.docx": {
    date: "2021-01-22",
    reason:
      "Dokument nennt 22.01.2020 – im Januar 2020 gab es noch keinen Krisenstab (erst ab Januar 2021 unter diesem Namen).",
    sicher: true,
  },
  "2022 Original/Ergebnisprotokoll_Krisenstabssitzung_2022-01-05.docx": {
    date: "2022-01-05",
    reason:
      "Dokument nennt 05.01.2021 – klassischer Jahresdreher im Januar. Dateiname (Mittwoch) passt, Datei liegt in „2022 Original“.",
    sicher: true,
  },
  "2022 Original/Ergebnisprotokoll_Krisenstabssitzung_2022-01-12.docx": {
    date: "2022-01-12",
    reason: "Wie oben: Jahresdreher im Januar, Dateiname passt.",
    sicher: true,
  },
  "2022 Original/Ergebnisprotokoll_Lage-AG-Sitzung_2022-08-17.docx": {
    date: "2022-08-17",
    reason:
      "Dokument nennt 16.08.2022 (Dienstag). Alle Lage-AG-Sitzungen von Juni bis August 2022 (22.06., 29.06., 13.07., 20.07., 27.07., 03.08., 10.08.) liegen auf einem Mittwoch – der Dateiname (Mittwoch) passt, das Feld nicht.",
    sicher: false,
  },
  "2022 Original/Ergebnisprotokoll_Lage-AG-Sitzung_2022-08-25.docx": {
    date: "2022-08-24",
    reason:
      "Dokument nennt 24.08.20222 (Jahres-Tippfehler → 2022, ein Mittwoch) und passt damit zur Mittwochs-Kadenz der Lage-AG; der Dateiname wäre ein Donnerstag. Der Wochentag 'Montag' im Feld ist ebenfalls falsch (Vorlagenrest).",
    sicher: false,
  },
};

const WEEKDAYS = [
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
  "Sonntag",
];

const GERMAN_MONTHS: Record<string, string> = {
  januar: "01",
  februar: "02",
  märz: "03",
  maerz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

/**
 * Jahresangaben im Quellmaterial sind teils vertippt: „13.10.221",
 * „24.08.20222". Ohne Toleranz findet ein strenges 20\d\d-Muster gar nichts und
 * greift dann auf das erste Datum im Fließtext zurück – was regelmäßig das
 * Datum der FOLGEsitzung ist ("Nächste Sitzung: Freitag, 15.10.2021").
 */
function normalizeYear(y: string): string | null {
  if (/^20\d{2}$/.test(y)) return y;
  if (/^20\d{3}$/.test(y)) return y.slice(0, 4); // 20222 → 2022
  if (/^2\d{2}$/.test(y)) return `20${y.slice(1)}`; // 221 → 2021
  if (/^\d{2}$/.test(y)) return `20${y}`; // 21 → 2021
  return null;
}

/**
 * Ein Datum aus einem Textfragment lesen (ISO, numerisch, ausgeschrieben).
 *
 * Zwei Eigenheiten des Quellmaterials:
 *  - Der Wochentag klebt manchmal am Datum ("Mittwoch12.04.2023"), weshalb er
 *    vorab entfernt wird statt sich auf eine Wortgrenze zu verlassen.
 *  - Zweistellige Jahre werden NICHT akzeptiert. Sonst liest das Muster das
 *    Aktenzeichen "4.06.02/0024#0014", das in fast jedem Protokoll steht, als
 *    04.06.2002 – ein falsches Datum, das echte Sitzungen verschiebt.
 */
function parseAnyDate(text: string): string | null {
  const cleaned = text.replace(
    /\b(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)\b/gi,
    " ",
  );

  const iso = cleaned.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  }
  const num = cleaned.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(2\d{2,4})(?!\d)/);
  if (num) {
    const y = normalizeYear(num[3]);
    if (y) return `${y}-${num[2].padStart(2, "0")}-${num[1].padStart(2, "0")}`;
  }
  const written = cleaned.match(/(\d{1,2})\.?\s+([A-Za-zÄÖÜäöü]+)\s+(20\d{2})/);
  if (written) {
    const mon = GERMAN_MONTHS[written[2].toLowerCase()];
    const y = normalizeYear(written[3]);
    if (mon && y) return `${y}-${mon}-${written[1].padStart(2, "0")}`;
  }
  return null;
}

/**
 * Sitzungsdatum und Wochentag aus dem Dokument lesen.
 *
 * Bewusst am „Datum:"-Kopffeld verankert und nicht am ersten Datum im Text:
 * Protokolle enthalten am Ende eine Zeile „Nächste Sitzung: Freitag,
 * 15.10.2021", die sonst als Sitzungsdatum durchgeht und zwei Sitzungen
 * vertauscht. Der Wert kann auch in der Folgezeile stehen (Ressortbesprechung).
 *
 * Der Wochentag im Feld ist häufig der unersetzte Vorlagen-Platzhalter
 * „Wochentag" – der wird verworfen, sonst wäre er ein Scheinbeweis.
 */
export function readProtocolDate(raw: string): {
  date: string | null;
  weekday: string | null;
  fromField: boolean;
} {
  const lines = raw.split(/\r?\n/).slice(0, 90);
  const fieldRe = /^[ \t]*(Datum|Datum,[ \t]*Uhrzeit|Zeit)[ \t]*:[ \t]*(.*)$/i;

  for (let i = 0; i < lines.length; i++) {
    // "Nächste Sitzung: …" nennt den FOLGEtermin, "Aktenzeichen: 4.06.02/…"
    // sieht wie ein Datum aus – beide dürfen nicht als Sitzungsdatum durchgehen.
    if (/Nächste\s+Sitzung|Aktenzeichen/i.test(lines[i])) continue;
    const m = lines[i].match(fieldRe);
    if (!m) continue;

    let value = m[2].trim();
    if (!value) {
      // Wert steht in der Folgezeile
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (lines[j].trim()) {
          value = lines[j].trim();
          break;
        }
      }
    }
    const date = parseAnyDate(value);
    const wm = value.match(
      /\b(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)\b/,
    );
    if (date) return { date, weekday: wm ? wm[1] : null, fromField: true };
  }

  // Rückfall: erstes Datum im Kopfbereich, ohne Folgetermin- und Aktenzeichen-Zeilen
  const head = lines
    .filter((l) => !/Nächste\s+Sitzung|Aktenzeichen/i.test(l))
    .join("\n")
    .slice(0, 6000);
  const date = parseAnyDate(head);
  const wm = head.match(
    /\b(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)\b/,
  );
  return { date, weekday: wm ? wm[1] : null, fromField: false };
}

/** Wochentag zu einem ISO-Datum, oder null bei ungültigem Datum. */
export function weekdayOf(iso: string): string | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime())) return null;
  // getUTCDay(): 0 = Sonntag
  return WEEKDAYS[(d.getUTCDay() + 6) % 7];
}

/**
 * Löst das maßgebliche Sitzungsdatum auf.
 *
 * Reihenfolge: geprüfte Override-Tabelle → Übereinstimmung → Wochentagsabgleich
 * → Verzeichnisjahr → Dateiname. Alles außer den ersten beiden Fällen wird als
 * `conflict` markiert und vom Audit gemeldet.
 */
export function resolveDate(e: {
  key: string; // "<Verzeichnis>/<Dateiname>"
  filenameDate: string | null;
  contentDate: string | null;
  contentWeekday: string | null;
  dirYear: string | null;
}): { date: string | null; source: DateSource; conflict: boolean; note?: string } {
  const ov = DATE_OVERRIDES[e.key];
  if (ov) {
    return {
      date: ov.date,
      source: "override",
      conflict: !ov.sicher,
      note: ov.reason,
    };
  }

  if (e.filenameDate && e.contentDate && e.filenameDate === e.contentDate) {
    return { date: e.filenameDate, source: "filename", conflict: false };
  }
  if (e.filenameDate && !e.contentDate) {
    return { date: e.filenameDate, source: "filename", conflict: false };
  }
  if (!e.filenameDate && e.contentDate) {
    return { date: e.contentDate, source: "content", conflict: true, note: "Kein Datum im Dateinamen." };
  }
  if (!e.filenameDate && !e.contentDate) {
    return { date: null, source: "filename", conflict: true, note: "Kein Datum gefunden." };
  }

  // Widerspruch: Wochentag aus dem Dokument als Schiedsrichter
  const wd = e.contentWeekday;
  if (wd && WEEKDAYS.includes(wd)) {
    const fnMatch = weekdayOf(e.filenameDate!) === wd;
    const cdMatch = weekdayOf(e.contentDate!) === wd;
    if (fnMatch && !cdMatch) {
      return {
        date: e.filenameDate!,
        source: "filename",
        conflict: true,
        note: `Wochentag „${wd}“ passt zum Dateinamen, nicht zum Datum im Text.`,
      };
    }
    if (cdMatch && !fnMatch) {
      return {
        date: e.contentDate!,
        source: "content",
        conflict: true,
        note: `Wochentag „${wd}“ passt zum Datum im Text, nicht zum Dateinamen.`,
      };
    }
  }

  // Verzeichnisjahr als letzter Anhaltspunkt
  if (e.dirYear) {
    const fnYear = e.filenameDate!.slice(0, 4);
    const cdYear = e.contentDate!.slice(0, 4);
    if (cdYear === e.dirYear && fnYear !== e.dirYear) {
      return {
        date: e.contentDate!,
        source: "content",
        conflict: true,
        note: `Jahr im Text passt zum Verzeichnis (${e.dirYear}).`,
      };
    }
    if (fnYear === e.dirYear && cdYear !== e.dirYear) {
      return {
        date: e.filenameDate!,
        source: "filename",
        conflict: true,
        note: `Jahr im Dateinamen passt zum Verzeichnis (${e.dirYear}).`,
      };
    }
  }

  return {
    date: e.filenameDate!,
    source: "filename",
    conflict: true,
    note: `Widerspruch ungeklärt: Dateiname ${e.filenameDate}, Text ${e.contentDate}.`,
  };
}

// ---------------------------------------------------------------------------
// Normalisierung: textutil-Rohtext → Markdown
// ---------------------------------------------------------------------------

/** Bullet-Zeichen, die in den Protokollen vorkommen (inkl. Symbol-Font-Reste). */
const BULLET_CHARS = /^[\t ]*[•▪◦·•]\s?/;

/** Reste der Tabellenkopfzeile, die beim Flachlegen der 3-Spalten-Tabelle entstehen. */
const TABLE_ARTIFACTS = [
  /^TOP$/i,
  /^Beitrag\s*\/?\s*Thema$/i,
  /^eingebracht von$/i,
  /^Ergebnis\s*\/?\s*Aufgabe$/i,
];

const HEADER_FIELDS: { keys: RegExp; field: keyof ProtocolHeader }[] = [
  { keys: /^Anlass$/i, field: "anlass" },
  { keys: /^Lage$/i, field: "anlass" },
  { keys: /^Datum(,\s*Uhrzeit)?$/i, field: "datum_raw" },
  { keys: /^Zeit$/i, field: "uhrzeit" },
  { keys: /^Sitzungsort$/i, field: "sitzungsort" },
  { keys: /^Ort$/i, field: "sitzungsort" },
  { keys: /^Moderation$/i, field: "moderation" },
  { keys: /^Moderator$/i, field: "moderation" },
  { keys: /^Sitzungsleitung$/i, field: "sitzungsleitung" },
  { keys: /^Protokollführung$/i, field: "protokollfuehrung" },
  { keys: /^Aktenzeichen$/i, field: "aktenzeichen" },
];

/** Zeichen-Aufräumen vor der Zeilenanalyse. */
function cleanupChars(raw: string): { text: string; formFeeds: number } {
  const formFeeds = (raw.match(/\f/g) || []).length;
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n")
    .replace(/ /g, " ") // NBSP
    .replace(/­/g, "") // Soft-Hyphen
    .replace(/[​‌‍﻿]/g, ""); // Zero-Width
  return { text, formFeeds };
}

/**
 * Leere Tabellenzellen kommen als Zeilen an, die nur aus Satzzeichen bestehen
 * ("-", "–", "."). Ohne diese Prüfung landen sie als Aufzählungspunkte im
 * Artikel und als eigene Teilnehmende.
 */
function isEmptyCell(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text);
}

/** Sieht die Zeile wie eine Überschrift aus (kurz, kein Satzende)? */
function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 90) return false;
  if (/[.!?;]$/.test(t)) return false;
  if (/^[-*]/.test(t)) return false;
  return true;
}

/**
 * Kandidat für die Spalte „eingebracht von“: kurze Zeile ohne Satzzeichen, die
 * unmittelbar vor der nächsten TOP-Nummer steht. Wird dem VORHERGEHENDEN TOP
 * zugeordnet – so liegt es in der Quelltabelle.
 */
function looksLikeUnit(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  if (/[.!?]$/.test(t)) return false;
  if (/^[-*]/.test(t)) return false;
  // Einheiten-Kürzel und Namen, ggf. mehrere durch / , + & getrennt
  return /^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß0-9 .\-/,+&()]*$/.test(t);
}

export function normalizeProtocol(
  raw: string,
  meta: {
    committee: Committee | null;
    date: string | null;
    /**
     * Listen-Ebenen aus dem docx-XML in Dokumentreihenfolge. textutil liefert
     * alle Ebenen als gleichwertige Bullets; ohne diese Zusatzinformation
     * verschmelzen z.B. Organisationseinheit und Person in der Teilnehmerliste
     * zu einer flachen Aufzählung.
     */
    listLevels?: { text: string; level: number }[];
  },
): { md: string; header: ProtocolHeader; stats: NormStats } {
  const { text, formFeeds } = cleanupChars(raw);

  const stats: NormStats = {
    zeilen: 0,
    topUeberschriften: 0,
    unterUeberschriften: 0,
    bullets: 0,
    entfernteZeilen: 0,
    seitenumbrueche: formFeeds,
    eingebrachtVon: 0,
  };

  // --- Zeilen vorbereiten: Bullets vereinheitlichen, Tabs glätten ----------
  // Die Listen-Ebenen aus dem docx-XML werden den Bullet-Zeilen sequenziell
  // zugeordnet: beide Quellen stehen in Dokumentreihenfolge, ein Abgleich nur
  // über den Text wäre bei Wiederholungen nicht eindeutig.
  const levels = meta.listLevels ?? [];
  let levelCursor = 0;
  const normText = (s: string) => s.replace(/\s+/g, " ").trim();
  const nextLevelFor = (content: string): number => {
    const target = normText(content);
    for (let j = levelCursor; j < Math.min(levels.length, levelCursor + 40); j++) {
      if (normText(levels[j].text) === target) {
        levelCursor = j + 1;
        return levels[j].level;
      }
    }
    return 0;
  };

  type Line = { text: string; bullet: boolean; level: number };
  const lines: Line[] = [];
  for (const rawLine of text.split("\n")) {
    if (BULLET_CHARS.test(rawLine)) {
      const content = rawLine.replace(BULLET_CHARS, "").replace(/\t+/g, " ").trim();
      if (content && !isEmptyCell(content)) {
        // Auf 2 Ebenen begrenzt: tiefere Verschachtelung kommt im Bestand nicht
        // vor und würde die Lesbarkeit im Artikel nur verschlechtern.
        const level = Math.min(nextLevelFor(content), 1);
        lines.push({ text: content, bullet: true, level });
        stats.bullets++;
      } else {
        stats.entfernteZeilen++;
      }
      continue;
    }
    const flat = rawLine.replace(/\t+/g, " ").replace(/\s+$/, "");
    const flatTrim = flat.trim();
    if (TABLE_ARTIFACTS.some((re) => re.test(flatTrim))) {
      stats.entfernteZeilen++;
      continue;
    }
    if (flatTrim && isEmptyCell(flatTrim)) {
      stats.entfernteZeilen++;
      continue;
    }
    lines.push({ text: flat, bullet: false, level: 0 });
  }
  stats.zeilen = lines.length;

  // --- Kopfbereich parsen -------------------------------------------------
  // Der Kopf ist nicht positionsfest: manche Vorlagen haben Leerzeilen, eine
  // Zeile "Ergebnisprotokoll", eine geklammerte Aktenzeichen-Zeile oder einen
  // Beschreibungssatz vor den Feldern. Deshalb wird nicht nach Zeilennummer
  // entschieden, sondern nach Zeilenform – und erst abgebrochen, wenn
  // eindeutig Inhalt beginnt.
  const header: ProtocolHeader = { teilnehmende: [] };
  const preamble: string[] = [];
  let bodyStart = 0;
  let inTeilnehmende = false;
  let sawKopfzeile = false;
  let fieldsSeen = 0;

  for (let i = 0; i < Math.min(lines.length, 80); i++) {
    const l = lines[i];
    const t = l.text.trim();

    if (!t) continue;

    if (l.bullet) {
      if (inTeilnehmende) {
        header.teilnehmende.push({ text: t, level: l.level });
        bodyStart = i + 1;
        continue;
      }
      break; // Inhalts-Bullet → Kopf ist zu Ende
    }

    // Alleinstehende Zahl = erste TOP-Nummer → Kopf ist zu Ende
    if (/^\d{1,2}[.)]?$/.test(t)) break;

    // Geklammerte Zeilen wie "(Aktenzeichen: 4.06.02/0024#0014)" mitnehmen
    const bare = t.replace(/^\((.*)\)$/, "$1").trim();

    const fieldMatch = bare.match(/^([A-ZÄÖÜ][A-Za-zÄÖÜäöüß ,]{1,30}?)\s*:\s*(.*)$/);
    if (fieldMatch) {
      const name = fieldMatch[1].trim();
      const value = fieldMatch[2].trim();

      if (/^(Teilnehmende|Sitzungsort Teilnehmende|Teilnehmer)$/i.test(name)) {
        inTeilnehmende = true;
        fieldsSeen++;
        // Inline-Form: "Teilnehmende: FG14, FG17, AL1, …"
        if (value) {
          for (const part of value.split(",")) {
            const p = part.trim();
            if (p) header.teilnehmende.push(p);
          }
        }
        bodyStart = i + 1;
        continue;
      }

      const def = HEADER_FIELDS.find((f) => f.keys.test(name));
      if (def) {
        inTeilnehmende = false;
        fieldsSeen++;
        let v = value;
        // Manche Vorlagen setzen den Wert in die Folgezeile ("Zeit:\nDienstag, …")
        if (!v) {
          for (let j = i + 1; j < Math.min(lines.length, i + 3); j++) {
            const next = lines[j];
            if (!next.text.trim()) continue;
            if (next.bullet) break;
            if (/^[A-ZÄÖÜ][A-Za-zÄÖÜäöüß ,]{1,30}?\s*:/.test(next.text.trim())) break;
            v = next.text.trim();
            i = j; // Folgezeile ist verbraucht
            break;
          }
        }
        if (v && !header[def.field]) {
          (header as Record<string, unknown>)[def.field] = v;
        }
        bodyStart = i + 1;
        continue;
      }
      // Unbekanntes "Wort:" – nach den Feldern beginnt hier der Inhalt
      if (fieldsSeen > 0) break;
      preamble.push(t);
      bodyStart = i + 1;
      continue;
    }

    if (!sawKopfzeile) {
      header.kopfzeile = t;
      sawKopfzeile = true;
      bodyStart = i + 1;
      continue;
    }

    // Vorlagen-Zeilen ohne Informationsgehalt
    if (/^(Ergebnisprotokoll|Agenda|Protokoll|Entwurf)\b/i.test(t) && t.length < 60) {
      bodyStart = i + 1;
      continue;
    }

    if (inTeilnehmende && looksLikeUnit(t)) {
      header.teilnehmende.push({ text: t, level: 0 });
      bodyStart = i + 1;
      continue;
    }

    // Beschreibungssatz vor den Feldern (z.B. „Die nCoV-Lage-AG wird … einberufen")
    if (fieldsSeen === 0) {
      preamble.push(t);
      bodyStart = i + 1;
      continue;
    }

    break;
  }

  // Datum und Uhrzeit aus dem Kopffeld herauslösen
  if (header.datum_raw) {
    const dm = header.datum_raw.match(/(\d{1,2})\.(\d{1,2})\.(20\d{2})/);
    if (dm) {
      header.datum_iso = `${dm[3]}-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")}`;
    }
    const um = header.datum_raw.match(/(\d{1,2}([:.]\d{2})?\s*[-–bis]{1,3}\s*\d{1,2}([:.]\d{2})?\s*Uhr|\d{1,2}[:.]\d{2}\s*Uhr)/i);
    if (um && !header.uhrzeit) header.uhrzeit = um[1].trim();
    const wm = header.datum_raw.match(
      /\b(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)\b/i,
    );
    if (wm) header.wochentag = wm[1];
  }
  if (!header.wochentag) {
    // Wochentag kann auch in einer eigenen Kopfzeile stehen
    const head = lines
      .slice(0, 14)
      .map((l) => l.text)
      .join(" ");
    const wm = head.match(
      /\b(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)\b/,
    );
    if (wm) header.wochentag = wm[1];
  }

  // --- Körper in TOP-Blöcke schneiden -------------------------------------
  // Eine alleinstehende Zahl ist nur dann eine TOP-Nummer, wenn sie die
  // erwartete nächste Nummer ist. Ohne diese Monotonie-Prüfung würden Zahlen
  // aus dem Inhalt (Fallzahlen, Jahre) zu Überschriften befördert.
  const body = lines.slice(bodyStart);
  const boundaries: { index: number; label: string }[] = [];
  let expected = 1;
  let lastAccepted = 0;
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    if (l.bullet) continue;
    // Unterpunkte mit Buchstaben kommen vor ("1a", "1b", dann "2")
    const m = l.text.trim().match(/^(\d{1,2})([a-z])?[.)]?$/);
    if (!m) continue;
    const num = +m[1];
    const letter = m[2];
    const isNext = num === expected;
    const isSubItem = letter !== undefined && num === lastAccepted;
    if (!isNext && !isSubItem) continue;
    // Auf die Nummer muss eine nicht-leere Zeile als Titel folgen
    let j = i + 1;
    while (j < body.length && !body[j].text.trim()) j++;
    if (j >= body.length) continue;
    boundaries.push({ index: i, label: `${num}${letter ?? ""}` });
    if (isNext) {
      lastAccepted = num;
      expected = num + 1;
    }
  }

  const out: string[] = [];

  // Kopfblock als Definitionsliste
  const titleDate = meta.date || header.datum_iso || "";
  const titleCommittee = meta.committee || "Sitzung";
  out.push(`# ${docTitle(meta.committee, meta.date)} — Ergebnisprotokoll`);
  out.push("");
  const kv: [string, string | undefined][] = [
    ["Gremium", titleCommittee],
    ["Sitzungsdatum", titleDate ? `${titleDate}${header.wochentag ? ` (${header.wochentag})` : ""}` : undefined],
    ["Uhrzeit", header.uhrzeit],
    ["Sitzungsort", header.sitzungsort],
    ["Moderation", header.moderation || header.sitzungsleitung],
    ["Protokollführung", header.protokollfuehrung],
    ["Anlass", header.anlass],
    ["Aktenzeichen", header.aktenzeichen],
  ];
  for (const [k, v] of kv) {
    if (v) out.push(`- **${k}:** ${v}`);
  }
  out.push("");

  if (preamble.length > 0) {
    for (const p of preamble) out.push(p);
    out.push("");
  }

  if (header.teilnehmende.length > 0) {
    out.push("## Teilnehmende");
    out.push("");
    for (const t of header.teilnehmende) {
      out.push(`${"  ".repeat(t.level)}- ${t.text}`);
    }
    out.push("");
  }

  /** Gibt einen Abschnitt aus und befördert Unterüberschriften. */
  const emitSection = (section: Line[], isTopBlock: boolean) => {
    // Ende des Blocks: kurze Nicht-Bullet-Zeilen sind die Spalte "eingebracht von"
    const unitLines: string[] = [];
    let end = section.length;
    if (isTopBlock) {
      while (end > 0) {
        const l = section[end - 1];
        if (!l.text.trim()) {
          end--;
          continue;
        }
        if (!l.bullet && looksLikeUnit(l.text)) {
          unitLines.unshift(l.text.trim());
          end--;
          continue;
        }
        break;
      }
    }

    const inner = section.slice(0, end);
    for (let i = 0; i < inner.length; i++) {
      const l = inner[i];
      const t = l.text.trim();
      if (!t) {
        if (out[out.length - 1] !== "") out.push("");
        continue;
      }
      if (l.bullet) {
        out.push(`${"  ".repeat(l.level)}- ${t}`);
        continue;
      }
      // Unterüberschrift, wenn kurz und von einem Bullet oder einer weiteren
      // kurzen Zeile gefolgt
      let j = i + 1;
      while (j < inner.length && !inner[j].text.trim()) j++;
      const followedByBullet = j < inner.length && inner[j].bullet;
      const followedByShort =
        j < inner.length && !inner[j].bullet && looksLikeHeading(inner[j].text);
      if (looksLikeHeading(t) && (followedByBullet || followedByShort)) {
        if (out[out.length - 1] !== "") out.push("");
        out.push(`### ${t}`);
        out.push("");
        stats.unterUeberschriften++;
        continue;
      }
      out.push(t);
    }

    if (unitLines.length > 0) {
      if (out[out.length - 1] !== "") out.push("");
      out.push(`**Eingebracht von:** ${unitLines.join(", ")}`);
      stats.eingebrachtVon++;
    }
  };

  if (boundaries.length === 0) {
    // Kein TOP-Gerüst (abgesagte Sitzung, abweichende Vorlage)
    emitSection(body, false);
  } else {
    // Text vor dem ersten TOP (selten, z.B. Vorbemerkung)
    if (boundaries[0].index > 0) {
      emitSection(body.slice(0, boundaries[0].index), false);
    }
    for (let b = 0; b < boundaries.length; b++) {
      const start = boundaries[b].index;
      const stop = b + 1 < boundaries.length ? boundaries[b + 1].index : body.length;
      // Titel = erste nicht-leere Zeile nach der Nummer
      let ti = start + 1;
      while (ti < stop && !body[ti].text.trim()) ti++;
      const topTitle = ti < stop ? body[ti].text.trim() : "";

      if (out[out.length - 1] !== "") out.push("");
      out.push(`## TOP ${boundaries[b].label}${topTitle ? ` — ${topTitle}` : ""}`);
      out.push("");
      stats.topUeberschriften++;

      emitSection(body.slice(ti + 1, stop), true);
    }
  }

  const md = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { md, header, stats };
}

// ---------------------------------------------------------------------------
// Titel und Slugs
// ---------------------------------------------------------------------------

/**
 * Dokumenttitel – Datum zuerst. Das ist tragend: der Titel erscheint als
 * Quellenangabe im Chat (search.ts COALESCE(d.title, …)), alphabetisch
 * sortieren ergibt damit chronologische Ordnung, und beim Abschneiden in der
 * UI bleibt das Datum sichtbar.
 */
export function docTitle(
  committee: Committee | null,
  date: string | null,
  suffix?: string,
): string {
  const c = committee || "Sitzung";
  const base = date ? `${date} · ${c}` : c;
  return suffix ? `${base} ${suffix}` : base;
}

/**
 * Titel-Zusatz für Nebenfassungen. Ohne den wären zwei Dokumente derselben
 * Sitzung im Chat nicht unterscheidbar – und der Titel ist die Quellenangabe.
 */
export function secondaryTitleSuffix(
  variant: string | null,
  isAgenda: boolean,
): string {
  if (isAgenda) return "(Agenda)";
  switch (variant) {
    case "Anmerkungen":
      return "(Anmerkungen)";
    case "Kommentare":
    case "prefinal":
      return "(Kommentare)";
    case "Entwurf":
      return "(Entwurf)";
    case "korr":
    case "clean":
    case "aktualisiert":
    case "V2":
      return "(Zweitfassung)";
    default:
      return variant ? `(${variant})` : "(Nebenfassung)";
  }
}

/** Dateiname für die Markdown-Zwischenstufe. */
export function mdFileName(
  committee: Committee | null,
  date: string | null,
  discriminator?: string,
): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const c = slug(committee || "sitzung");
  const extra = discriminator ? `__${slug(discriminator)}` : "";
  return `${date || "ohne-datum"}__${c}${extra}.md`;
}

// ---------------------------------------------------------------------------
// Deduplizierung
// ---------------------------------------------------------------------------

export interface DedupCandidate {
  key: string;
  fileName: string;
  ext: string;
  variantRank: number;
  mdChars: number;
  resolvedDate: string | null;
  committee: Committee | null;
  status: string;
  winner?: boolean;
  /**
   * Aussortierte Fassung, die trotzdem importiert wird, weil sie deutlich
   * länger ist als die behaltene und damit eigenen Inhalt enthält (z.B. eine
   * während der Sitzung mitgeschriebene Agenda). Wird gechunkt und ist im Chat
   * findbar, bekommt aber keinen eigenen Wiki-Artikel.
   */
  secondary?: boolean;
  group?: string;
}

const EXT_RANK: Record<string, number> = { docx: 3, odt: 2, pdf: 1 };

/**
 * Ab welchem Längenverhältnis eine aussortierte Fassung als eigenständiger
 * Inhalt gilt. 5 % über der behaltenen Fassung – darunter sind es
 * Kommentarspuren und Formatierungsunterschiede.
 */
export const SECONDARY_LENGTH_RATIO = 1.05;

/**
 * Setzt `group` und `winner` je Eintrag. Gruppenschlüssel ist
 * (Datum, Gremium) – am 2020-01-25 und 2020-02-19 tagten nach der
 * Datumskorrektur keine zwei Gremien mehr am selben Tag, aber der Schlüssel
 * bleibt richtig, falls doch einmal zwei Gremien zusammenfallen.
 */
export function pickWinners(entries: DedupCandidate[]): void {
  const groups = new Map<string, DedupCandidate[]>();
  for (const e of entries) {
    e.winner = false;
    e.secondary = false;
    if (e.status !== "ok" || !e.resolvedDate) continue;
    e.group = `${e.resolvedDate}|${e.committee ?? "?"}`;
    const list = groups.get(e.group) || [];
    list.push(e);
    groups.set(e.group, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => {
      if (b.variantRank !== a.variantRank) return b.variantRank - a.variantRank;
      const ea = EXT_RANK[a.ext.toLowerCase()] ?? 0;
      const eb = EXT_RANK[b.ext.toLowerCase()] ?? 0;
      if (eb !== ea) return eb - ea;
      if (b.mdChars !== a.mdChars) return b.mdChars - a.mdChars;
      return a.fileName.localeCompare(b.fileName, "de");
    });
    const winner = list[0];
    winner.winner = true;
    for (const e of list.slice(1)) {
      e.secondary = e.mdChars > winner.mdChars * SECONDARY_LENGTH_RATIO;
    }
  }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Protokollbewusstes Chunking: trennt zuerst an den `## `-Grenzen (TOP), packt
 * dann bis `targetChars` und teilt zu große Abschnitte an Absatz-, dann an
 * Zeilengrenzen. Jeder Chunk wird mit Sitzung und TOP präfigiert und ist damit
 * selbstidentifizierend – wichtig, weil die Chunk-Tabelle keine Metadaten hat.
 *
 * Bewusst nicht splitIntoChunks(): das ist ein blindes Fixfenster, das mitten
 * durch Wörter und Zahlen schneidet. Bei einem Bestand, dessen Substanz Zahlen
 * sind ("7-Tage-Inzidenz 258,6/100.000"), liefert das Chunks, die gut
 * retrieven und falsch lesen.
 */
export function chunkProtocol(
  md: string,
  opts: { targetChars?: number; overlapChars?: number; label: string },
): ProtocolChunk[] {
  const target = opts.targetChars ?? 1500;
  const overlap = opts.overlapChars ?? 200;

  // In Abschnitte an "## " zerlegen, Überschrift bleibt beim Abschnitt
  const sections: { heading: string; body: string }[] = [];
  let currentHeading = "";
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body || currentHeading) sections.push({ heading: currentHeading, body });
    buf = [];
  };
  for (const line of md.split("\n")) {
    if (/^##\s+/.test(line)) {
      flush();
      currentHeading = line.replace(/^##\s+/, "").trim();
      continue;
    }
    if (/^#\s+/.test(line)) {
      flush();
      currentHeading = "";
      buf.push(line.replace(/^#\s+/, "").trim());
      continue;
    }
    buf.push(line);
  }
  flush();

  const chunks: ProtocolChunk[] = [];
  const push = (heading: string, body: string) => {
    const text = body.trim();
    if (!text) return;
    const prefix = heading
      ? `[${opts.label} · ${heading}]\n`
      : `[${opts.label}]\n`;
    const content = prefix + text;
    chunks.push({
      content,
      chunk_index: chunks.length,
      token_count: content.split(/\s+/).filter(Boolean).length,
    });
  };

  // Kurze Abschnitte zusammenpacken. Ohne das ergibt jeder TOP einen eigenen
  // Chunk – bei ~10 TOPs je Protokoll wären das über 10.000 Fragmente à ~600
  // Zeichen, die im Retrieval nur Bruchstücke liefern.
  let packHeadings: string[] = [];
  let packBody: string[] = [];
  let packLen = 0;
  const flushPack = () => {
    if (packBody.length === 0) return;
    const label =
      packHeadings.length === 0
        ? ""
        : packHeadings.length === 1
          ? packHeadings[0]
          : `${packHeadings[0]} … ${packHeadings[packHeadings.length - 1]}`;
    push(label, packBody.join("\n\n"));
    packHeadings = [];
    packBody = [];
    packLen = 0;
  };

  for (const sec of sections) {
    if (!sec.body) continue;
    if (sec.body.length <= target) {
      // Passt der Abschnitt noch in das laufende Paket?
      const addLen = sec.body.length + (sec.heading ? sec.heading.length + 4 : 0);
      if (packLen > 0 && packLen + addLen > target) flushPack();
      if (sec.heading) {
        packHeadings.push(sec.heading);
        packBody.push(`## ${sec.heading}`);
      }
      packBody.push(sec.body);
      packLen += addLen + 2;
      continue;
    }
    flushPack();
    // Zu groß: an Absätzen packen, Overlap nur innerhalb des Abschnitts
    const paras = sec.body.split(/\n{2,}/);
    let acc: string[] = [];
    let accLen = 0;
    const flushAcc = () => {
      if (acc.length === 0) return;
      const body = acc.join("\n\n");
      push(sec.heading, body);
      if (overlap > 0 && body.length > overlap) {
        const tail = body.slice(-overlap);
        acc = [tail];
        accLen = tail.length;
      } else {
        acc = [];
        accLen = 0;
      }
    };
    for (const para of paras) {
      if (para.length > target) {
        flushAcc();
        acc = [];
        accLen = 0;
        // Einzelner Riesen-Absatz: an Zeilen, sonst hart
        const lines = para.split("\n");
        let lineAcc: string[] = [];
        let lineLen = 0;
        for (const line of lines) {
          if (lineLen + line.length > target && lineAcc.length > 0) {
            push(sec.heading, lineAcc.join("\n"));
            lineAcc = [];
            lineLen = 0;
          }
          if (line.length > target) {
            for (let i = 0; i < line.length; i += target) {
              push(sec.heading, line.slice(i, i + target));
            }
            continue;
          }
          lineAcc.push(line);
          lineLen += line.length + 1;
        }
        if (lineAcc.length > 0) push(sec.heading, lineAcc.join("\n"));
        continue;
      }
      if (accLen + para.length > target && acc.length > 0) flushAcc();
      acc.push(para);
      accLen += para.length + 2;
    }
    if (acc.length > 0) {
      const body = acc.join("\n\n");
      push(sec.heading, body);
    }
  }
  flushPack();

  // chunk_index nach dem Filtern neu vergeben
  return chunks.map((c, i) => ({ ...c, chunk_index: i }));
}

// ---------------------------------------------------------------------------
// Deterministische IDs
// ---------------------------------------------------------------------------

/** Fester Namespace für RKI-Protokolle (selbst gewählt, darf sich nie ändern). */
export const RKI_UUID_NAMESPACE = "b7c1e4a2-6f3d-4c8e-9a15-2d7f8b0c4e63";

/**
 * UUIDv5 (SHA-1 über Namespace + Name). Gleiches (Gremium, Datum) ergibt immer
 * dieselbe Dokument-ID – Grundlage der Idempotenz und, weil wiki-generate.ts
 * den Slug als `summary-${doc.id}` bildet, auch eines stabilen Wiki-Slugs.
 */
export function uuidv5(name: string, namespace: string = RKI_UUID_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (ns.length !== 16) throw new Error(`Ungültiger UUID-Namespace: ${namespace}`);
  const hash = createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(name, "utf8")]))
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // Version 5
  b[8] = (b[8] & 0x3f) | 0x80; // Variante RFC 4122
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** SHA-256 als Hex (Datei- und Inhaltshashes). */
export function sha256(data: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

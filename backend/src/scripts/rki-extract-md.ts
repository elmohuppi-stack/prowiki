#!/usr/bin/env bun
/**
 * Stufe 0/1: RKI-Protokolle (docx/odt) → normalisiertes Markdown + manifest.json
 *
 * Läuft ausschließlich auf dem Mac – `textutil` ist ein macOS-Bordmittel und
 * existiert auf dem Linux-Host nicht. Genau deshalb ist diese Zwischenstufe
 * eine Datei-Ebene: das Ergebnis (6 MB Markdown) lässt sich inspizieren,
 * diffen und per rsync auf Prod bringen, ohne dass der Parser-Container
 * (MarkItDown, mem_limit 1g) jemals beteiligt ist.
 *
 * Der Import (Stufe 2) liest nur noch manifest.json + die .md-Dateien.
 *
 * Usage:
 *   bun run src/scripts/rki-extract-md.ts --src <orig-dir> --out <md-dir> [Optionen]
 *
 * Optionen:
 *   --src <dir>     Verzeichnis mit den "* Original"-Unterordnern (Pflicht)
 *   --out <dir>     Zielverzeichnis für die .md-Dateien + manifest.json (Pflicht)
 *   --audit         Nur prüfen und berichten, nichts schreiben. Exit 1, wenn
 *                   etwas menschliche Prüfung braucht.
 *   --limit <n>     Nur die ersten n Dateien verarbeiten (Testläufe)
 *   --force         Auch unveränderte Dateien neu extrahieren
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import {
  NORM_VERSION,
  type Committee,
  type DedupCandidate,
  type NormStats,
  type ProtocolHeader,
  DATE_OVERRIDES,
  chunkProtocol,
  docTitle,
  mdFileName,
  normalizeProtocol,
  parseFileName,
  secondaryTitleSuffix,
  pickWinners,
  readProtocolDate,
  resolveDate,
  sha256,
  weekdayOf,
} from "./lib/rki-protokoll.ts";

// ---------------------------------------------------------------------------
// Argumente
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const withEq = args.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const SRC = argValue("src");
const OUT = argValue("out");
const AUDIT = hasFlag("audit");
const FORCE = hasFlag("force");
const LIMIT = argValue("limit") ? parseInt(argValue("limit")!, 10) : undefined;

if (!SRC || (!OUT && !AUDIT)) {
  console.error(
    "Usage: bun run src/scripts/rki-extract-md.ts --src <orig-dir> --out <md-dir> [--audit] [--limit n] [--force]",
  );
  process.exit(2);
}
if (!existsSync(SRC)) {
  console.error(`❌ Quellverzeichnis nicht gefunden: ${SRC}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Manifest-Typen
// ---------------------------------------------------------------------------

type EntryStatus = "ok" | "empty" | "binary" | "extract_failed" | "oversize";

interface ManifestEntry extends DedupCandidate {
  sourceFile: string;
  sourceDir: string;
  fileSize: number;
  fileHash: string;
  contentHash: string;
  mdFile: string | null;
  filenameDate: string | null;
  contentDate: string | null;
  contentWeekday: string | null;
  dateSource: string;
  dateConflict: boolean;
  dateNote?: string;
  variant: string | null;
  header: ProtocolHeader;
  norm: NormStats;
  normVersion: number;
  chunkCount: number;
  title: string;
  cancelled: boolean;
  /** Vorlage ist eine (mitgeschriebene) Agenda, kein Ergebnisprotokoll. */
  isAgenda: boolean;
  /** Nebenfassung: importieren, aber keinen Wiki-Artikel generieren. */
  wikiSkip: boolean;
}

interface Manifest {
  generated_at: string;
  norm_version: number;
  src: string;
  entries: ManifestEntry[];
}

// ---------------------------------------------------------------------------
// Extraktion
// ---------------------------------------------------------------------------

const ALLOWED_EXT = new Set(["docx", "odt", "pdf"]);

function collectFiles(root: string): { file: string; dir: string }[] {
  const found: { file: string; dir: string }[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dirPath = path.join(root, dirent.name);
    for (const f of readdirSync(dirPath)) {
      // macOS AppleDouble-Dateien ("._Name.docx") sind Metadaten-Beiwerk, kein Inhalt
      if (f.startsWith("._")) continue;
      const ext = f.split(".").pop()?.toLowerCase() || "";
      if (!ALLOWED_EXT.has(ext)) continue;
      found.push({ file: path.join(dirPath, f), dir: dirent.name });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file, "de"));
}

/** textutil aufrufen. Gibt null zurück, wenn der Aufruf fehlschlägt. */
function extractText(file: string): string | null {
  const res = Bun.spawnSync(["textutil", "-convert", "txt", "-stdout", file]);
  if (res.exitCode !== 0) return null;
  return res.stdout.toString("utf8");
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, "&");
}

/**
 * Liest die Listen-Ebenen (w:ilvl) direkt aus dem docx-XML.
 *
 * Nötig, weil `textutil` die Verschachtelung wegwirft: eine zweistufige Liste
 *   • Institutsleitung
 *       o Lothar Wieler
 * kommt als zwei gleichwertige U+2022-Zeilen an. Damit verschmelzen in der
 * Teilnehmerliste Organisationseinheit und Person zu einer flachen Aufzählung –
 * und wer zu welcher Einheit gehört, ist nicht mehr erkennbar.
 *
 * Ein docx ist ein ZIP; `unzip -p` liegt auf macOS bei. Zurückgegeben werden die
 * Listenabsätze in Dokumentreihenfolge, damit der Normalisierer sie den
 * textutil-Zeilen sequenziell zuordnen kann (Text allein wäre nicht eindeutig).
 */
function readDocxListLevels(file: string): { text: string; level: number }[] {
  if (!/\.docx$/i.test(file)) return [];
  const res = Bun.spawnSync(["unzip", "-p", file, "word/document.xml"]);
  if (res.exitCode !== 0) return [];
  const xml = res.stdout.toString("utf8");
  const out: { text: string; level: number }[] = [];
  for (const para of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const ilvl = para.match(/<w:ilvl w:val="(\d+)"/);
    if (!ilvl) continue; // kein Listenabsatz
    const text = decodeXmlEntities(
      (para.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) ?? [])
        .map((t) => t.replace(/<[^>]+>/g, ""))
        .join(""),
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    out.push({ text, level: parseInt(ilvl[1], 10) });
  }
  return out;
}

/**
 * Erkennt Ausgaben, die kein Text sind. Ohne diese Prüfung würde das
 * teilgeschwärzte PDF ~146.000 Zeichen PDF-Stream-Müll in den Bestand
 * schreiben, der sich wie Inhalt verhält (chunkbar, embeddbar, unlesbar).
 */
function looksBinary(text: string): boolean {
  const head = text.slice(0, 2000);
  if (head.startsWith("%PDF") || head.startsWith("PK")) return true;
  let ctrl = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) ctrl++;
  }
  return head.length > 0 && ctrl / head.length > 0.02;
}

// Datum/Wochentag liest readProtocolDate() aus lib/rki-protokoll.ts – dort
// zusammen mit der Toleranz für vertippte Jahre und dem Ausschluss der
// "Nächste Sitzung"-Zeilen.

// ---------------------------------------------------------------------------
// Hauptlauf
// ---------------------------------------------------------------------------

const files = LIMIT ? collectFiles(SRC).slice(0, LIMIT) : collectFiles(SRC);
console.log(`📂 ${files.length} Dateien gefunden in ${SRC}`);

// Vorhandenes Manifest für den Skip-Pfad laden
const manifestPath = OUT ? path.join(OUT, "manifest.json") : null;
const previous = new Map<string, ManifestEntry>();
if (!FORCE && manifestPath && existsSync(manifestPath)) {
  try {
    const old: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (old.norm_version === NORM_VERSION) {
      for (const e of old.entries) previous.set(e.key, e);
      console.log(
        `♻️  Vorheriges Manifest gelesen (${previous.size} Einträge, norm_version ${old.norm_version})`,
      );
    } else {
      console.log(
        `⚙️  Manifest hat norm_version ${old.norm_version}, aktuell ist ${NORM_VERSION} → alles neu`,
      );
    }
  } catch {
    console.warn("⚠️  Vorheriges Manifest nicht lesbar, wird ignoriert");
  }
}

if (OUT && !AUDIT && !existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const entries: ManifestEntry[] = [];
/** Normalisiertes Markdown des aktuellen Laufs, key → md. Übernommene Einträge
 *  fehlen hier bewusst – ihre .md-Datei liegt schon im Zielverzeichnis. */
const mdByKey = new Map<string, string>();
let reused = 0;

for (const { file, dir } of files) {
  const fileName = path.basename(file);
  const key = `${dir}/${fileName}`;
  const ext = fileName.split(".").pop()!.toLowerCase();
  const fileBytes = readFileSync(file);
  const fileHash = sha256(fileBytes);
  const fileSize = statSync(file).size;

  const prev = previous.get(key);
  if (prev && prev.fileHash === fileHash && prev.normVersion === NORM_VERSION) {
    entries.push(prev);
    reused++;
    continue;
  }

  const { committee, filenameDate, variant, variantRank } = parseFileName(fileName);
  const dirYear = dir.match(/(20\d{2})/)?.[1] ?? null;

  let status: EntryStatus = "ok";
  let raw = extractText(file);
  if (raw === null) {
    status = "extract_failed";
    raw = "";
  } else if (looksBinary(raw)) {
    status = "binary";
    raw = "";
  } else if (raw.trim().length < 150) {
    status = "empty";
  } else if (raw.length > 60_000) {
    status = "oversize";
  }

  const { date: contentDate, weekday: contentWeekday } = raw
    ? readProtocolDate(raw)
    : { date: null, weekday: null };

  const resolved = resolveDate({
    key,
    filenameDate,
    contentDate,
    contentWeekday,
    dirYear,
  });

  let md = "";
  let header: ProtocolHeader = { teilnehmende: [] };
  let norm: NormStats = {
    zeilen: 0,
    topUeberschriften: 0,
    unterUeberschriften: 0,
    bullets: 0,
    entfernteZeilen: 0,
    seitenumbrueche: 0,
    eingebrachtVon: 0,
  };
  let chunkCount = 0;

  if (status === "ok" || status === "empty") {
    const res = normalizeProtocol(raw, {
      committee,
      date: resolved.date,
      listLevels: readDocxListLevels(file),
    });
    md = res.md;
    header = res.header;
    norm = res.stats;
    chunkCount = chunkProtocol(md, {
      label: docTitle(committee, resolved.date),
    }).length;
    mdByKey.set(key, md);
  }

  // Agenda-Vorlagen tragen das in der ersten Zeile ("Agenda AG-Sitzung …").
  // Der Titel muss das später sagen, sonst sind zwei Dokumente derselben
  // Sitzung im Chat nicht auseinanderzuhalten.
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const isAgenda = /^\s*Agenda\b/i.test(firstLine);

  // winner/secondary stehen erst nach pickWinners() fest – Titel und
  // Dateiname werden deshalb unten nachgezogen.
  entries.push({
    key,
    sourceFile: file,
    sourceDir: dir,
    fileName,
    ext,
    fileSize,
    fileHash,
    contentHash: md ? sha256(md) : "",
    mdFile: null,
    mdChars: md.length,
    committee,
    filenameDate,
    contentDate,
    contentWeekday,
    resolvedDate: resolved.date,
    dateSource: resolved.source,
    dateConflict: resolved.conflict,
    dateNote: resolved.note,
    variant,
    variantRank,
    header,
    norm,
    normVersion: NORM_VERSION,
    chunkCount,
    status,
    title: "",
    cancelled: /Ausfall|entfällt|abgesagt/i.test(md.slice(0, 600)) && md.length < 1200,
    isAgenda,
    wikiSkip: false,
  });
}

// Deduplizieren (setzt group, winner, secondary)
pickWinners(entries);

// Titel und Zieldateinamen erst jetzt festlegen: eine Nebenfassung braucht
// einen unterscheidbaren Titel und einen eigenen Dateinamen, sonst überschreibt
// sie die behaltene Fassung derselben Sitzung.
for (const e of entries) {
  const importable = e.winner || e.secondary;
  if (!importable || (e.status !== "ok" && e.status !== "empty")) {
    e.mdFile = null;
    e.title = docTitle(e.committee, e.resolvedDate);
    e.wikiSkip = true;
    continue;
  }
  if (e.secondary) {
    const suffix = secondaryTitleSuffix(e.variant, e.isAgenda);
    e.title = docTitle(e.committee, e.resolvedDate, suffix);
    e.mdFile = mdFileName(e.committee, e.resolvedDate, suffix.replace(/[()]/g, ""));
    e.wikiSkip = true; // kein eigener Wiki-Artikel, nur für Chat/RAG
  } else {
    e.title = docTitle(e.committee, e.resolvedDate);
    e.mdFile = mdFileName(e.committee, e.resolvedDate);
    e.wikiSkip = e.cancelled || e.mdChars < 1200;
  }
}

// Markdown schreiben: Gewinner und die eigenständigen Nebenfassungen
if (OUT && !AUDIT) {
  let written = 0;
  let kept = 0;
  for (const e of entries) {
    if (!e.mdFile) continue;
    const target = path.join(OUT, e.mdFile);
    const md = mdByKey.get(e.key);
    if (md === undefined) {
      // Aus dem Manifest übernommen: Datei muss schon da sein, sonst neu bauen
      if (existsSync(target)) {
        kept++;
        continue;
      }
      const raw = extractText(e.sourceFile);
      if (raw === null) {
        console.warn(`⚠️  ${e.key}: Extraktion beim Schreiben fehlgeschlagen`);
        continue;
      }
      writeFileSync(
        target,
        normalizeProtocol(raw, {
          committee: e.committee,
          date: e.resolvedDate,
          listLevels: readDocxListLevels(e.sourceFile),
        }).md,
        "utf8",
      );
      written++;
      continue;
    }
    writeFileSync(target, md, "utf8");
    written++;
  }
  if (kept > 0) console.log(`♻️  ${kept} unveränderte .md-Dateien belassen`);
  const manifest: Manifest = {
    generated_at: new Date().toISOString(),
    norm_version: NORM_VERSION,
    src: SRC,
    entries,
  };
  writeFileSync(manifestPath!, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\n💾 ${written} Markdown-Dateien geschrieben nach ${OUT}`);
  console.log(`💾 manifest.json geschrieben (${entries.length} Einträge)`);
}

// ---------------------------------------------------------------------------
// Bericht
// ---------------------------------------------------------------------------

const winners = entries.filter((e) => e.winner);
const secondaries = entries.filter((e) => e.secondary);
const skipped = entries.filter((e) => !e.winner && !e.secondary && e.status === "ok");
const broken = entries.filter((e) => e.status !== "ok");
const imported = [...winners, ...secondaries];

console.log("\n" + "=".repeat(78));
console.log("ÜBERSICHT");
console.log("=".repeat(78));
console.log(`Dateien gesamt:            ${entries.length}${reused ? `  (${reused} aus Manifest übernommen)` : ""}`);
console.log(`Kanonische Protokolle:     ${winners.length}`);
console.log(`Nebenfassungen (Import):   ${secondaries.length}   – eigener Inhalt, kein Wiki-Artikel`);
console.log(`Übersprungene Varianten:   ${skipped.length}`);
console.log(`Nicht verwertbar:          ${broken.length}`);
console.log(`→ Zu importieren:          ${imported.length}`);
console.log(
  `Zeichen (Import):          ${imported.reduce((s, e) => s + e.mdChars, 0).toLocaleString("de-DE")}`,
);
console.log(
  `Chunks (geschätzt):        ${imported.reduce((s, e) => s + e.chunkCount, 0).toLocaleString("de-DE")}`,
);

const byCommittee = new Map<string, number>();
for (const e of winners) {
  const c = e.committee ?? "?";
  byCommittee.set(c, (byCommittee.get(c) || 0) + 1);
}
console.log("\nGremien (kanonisch):");
for (const [c, n] of [...byCommittee.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${c}`);
}

const byYear = new Map<string, number>();
for (const e of winners) {
  const y = e.resolvedDate?.slice(0, 4) ?? "?";
  byYear.set(y, (byYear.get(y) || 0) + 1);
}
console.log("\nSitzungen pro Jahr:");
for (const [y, n] of [...byYear.entries()].sort()) {
  console.log(`  ${y}: ${n}`);
}

// --- Prüfpunkte ----------------------------------------------------------
const problems: string[] = [];

const corrected = entries.filter((e) => e.dateSource === "override");
if (corrected.length > 0) {
  console.log("\n" + "=".repeat(78));
  console.log(`DATUMSKORREKTUREN (${corrected.length}) – bitte bestätigen`);
  console.log("=".repeat(78));
  for (const e of corrected.sort((a, b) => (a.resolvedDate! < b.resolvedDate! ? -1 : 1))) {
    const ov = DATE_OVERRIDES[e.key];
    // sicher=false heißt "Ermessensentscheidung, von Elmo am 2026-07-29 bestätigt"
    const flag = ov?.sicher ? "  " : "· ";
    const wd = e.resolvedDate ? weekdayOf(e.resolvedDate) : null;
    console.log(
      `${flag} ${e.resolvedDate} (${wd})  ←  Datei ${e.filenameDate ?? "—"} / Text ${e.contentDate ?? "—"}`,
    );
    console.log(`     ${e.key}`);
    console.log(`     ${ov?.reason ?? e.dateNote ?? ""}`);
  }
}

const unresolved = entries.filter((e) => e.dateConflict && e.dateSource !== "override");
if (unresolved.length > 0) {
  console.log("\n" + "=".repeat(78));
  console.log(`UNGEKLÄRTE DATUMSKONFLIKTE (${unresolved.length})`);
  console.log("=".repeat(78));
  for (const e of unresolved) {
    console.log(`❗ ${e.key}`);
    console.log(
      `     Datei ${e.filenameDate ?? "—"} / Text ${e.contentDate ?? "—"} → gewählt ${e.resolvedDate ?? "—"} (${e.dateSource})`,
    );
    if (e.dateNote) console.log(`     ${e.dateNote}`);
    problems.push(`Ungeklärter Datumskonflikt: ${e.key}`);
  }
}

if (broken.length > 0) {
  console.log("\n" + "=".repeat(78));
  console.log(`NICHT VERWERTBAR (${broken.length})`);
  console.log("=".repeat(78));
  for (const e of broken) {
    // Ist dieselbe Sitzung über eine andere Datei abgedeckt, ist der Ausfall
    // unschädlich (das geschwärzte PDF ist die Dublette zum .docx).
    const covered = entries.some(
      (o) =>
        o.winner &&
        o.committee === e.committee &&
        o.resolvedDate !== null &&
        o.resolvedDate === e.filenameDate,
    );
    console.log(
      `${covered ? "ℹ️ " : "⛔"} [${e.status}] ${e.key}  (${e.fileSize.toLocaleString("de-DE")} Bytes)`,
    );
    if (covered) {
      console.log(`     Sitzung ist über eine andere Datei abgedeckt – unschädlich.`);
    } else {
      problems.push(`${e.status}: ${e.key}`);
    }
  }
}

// Ohne TOP-Gerüst: geprüft und in Ordnung – die Ressortbesprechung nutzt eine
// andere Vorlage, die Sondersitzung hatte nur ein Thema. Der Inhalt bleibt als
// Absätze erhalten, nur die ##-Gliederung fehlt.
const noTop = imported.filter((e) => e.norm.topUeberschriften === 0 && e.mdChars > 1200);
if (noTop.length > 0) {
  console.log("\n" + "=".repeat(78));
  console.log(`OHNE TOP-GERÜST (${noTop.length}) – abweichende Vorlage, Inhalt vollständig`);
  console.log("=".repeat(78));
  for (const e of noTop) {
    console.log(`ℹ️  ${e.key}  (${e.mdChars.toLocaleString("de-DE")} Zeichen)`);
  }
}

const tiny = imported.filter((e) => e.mdChars < 1200);
if (tiny.length > 0) {
  console.log("\n" + "=".repeat(78));
  console.log(`SEHR KURZ (${tiny.length}) – wird importiert, aber ohne Wiki-Artikel`);
  console.log("=".repeat(78));
  for (const e of tiny) {
    console.log(
      `ℹ️  ${e.resolvedDate} ${e.committee}: ${e.mdChars} Zeichen${e.cancelled ? "  [als Ausfall erkannt]" : ""}`,
    );
    console.log(`     ${e.key}`);
  }
}

const groups = new Map<string, ManifestEntry[]>();
for (const e of entries) {
  if (!e.group) continue;
  const l = groups.get(e.group) || [];
  l.push(e);
  groups.set(e.group, l);
}

// Nebenfassungen werden importiert – das ist eine Entscheidung, kein Problem.
if (secondaries.length > 0) {
  console.log("\n" + "=".repeat(78));
  console.log(
    `NEBENFASSUNGEN (${secondaries.length}) – werden importiert, kein eigener Wiki-Artikel`,
  );
  console.log("=".repeat(78));
  for (const e of secondaries.sort((a, b) => (a.group! < b.group! ? -1 : 1))) {
    const w = groups.get(e.group!)?.find((x) => x.winner);
    const plus = w ? e.mdChars - w.mdChars : 0;
    console.log(`   ${e.title}`);
    console.log(
      `     ${e.fileName} (${e.mdChars.toLocaleString("de-DE")} Z., +${plus.toLocaleString("de-DE")} gegenüber der Hauptfassung)`,
    );
  }
}

// Gruppen mit starker Längenabweichung, die NICHT als Nebenfassung laufen –
// dort könnten zwei verschiedene Sitzungen zusammengeworfen sein.
const suspectGroups: string[] = [];
for (const [g, list] of groups) {
  if (list.length < 2) continue;
  const w = list.find((e) => e.winner)!;
  for (const l of list) {
    if (l.winner || l.secondary) continue;
    if (Math.abs(l.mdChars - w.mdChars) > w.mdChars * 0.2) {
      suspectGroups.push(
        `${g}: starke Längenabweichung – ${w.fileName} (${w.mdChars}) vs ${l.fileName} (${l.mdChars}); evtl. verschiedene Sitzungen`,
      );
    }
  }
}
if (suspectGroups.length > 0) {
  console.log("\n" + "=".repeat(78));
  console.log(`VARIANTEN ZUM PRÜFEN (${suspectGroups.length})`);
  console.log("=".repeat(78));
  for (const s of suspectGroups) {
    console.log(`❓ ${s}`);
    problems.push(`Variante prüfen: ${s}`);
  }
}

if (skipped.length > 0) {
  console.log("\n" + "=".repeat(78));
  console.log(`ÜBERSPRUNGENE VARIANTEN (${skipped.length})`);
  console.log("=".repeat(78));
  for (const e of skipped.sort((a, b) => (a.group! < b.group! ? -1 : 1))) {
    const w = groups.get(e.group!)?.find((x) => x.winner);
    console.log(
      `   ${e.group}  ${e.fileName} (${e.variant ?? "Basis"}, Rang ${e.variantRank}, ${e.mdChars} Z.)`,
    );
    console.log(`     → behalten: ${w?.fileName} (${w?.variant ?? "Basis"}, Rang ${w?.variantRank})`);
  }
}

console.log("\n" + "=".repeat(78));
if (problems.length === 0) {
  console.log("✅ Keine offenen Punkte.");
} else {
  console.log(`⚠️  ${problems.length} Punkte brauchen eine Entscheidung (siehe oben).`);
}
console.log("=".repeat(78));

if (AUDIT && problems.length > 0) process.exit(1);
process.exit(0);

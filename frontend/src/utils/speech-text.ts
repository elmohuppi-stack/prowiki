// Markdown → vorlesbarer Text.
//
// Engine-unabhängig: wird aktuell von useSpeech (Web Speech API) genutzt und
// ist unverändert für ein späteres Server-TTS (OpenAI/Azure) wiederverwendbar –
// dort nur mit größerem maxChunkChars.
//
// Roh vorgelesenes Markdown klingt furchtbar ("Klammer Klammer Vektor-Suche
// Klammer Klammer"), darum werden Syntax, URLs, Code-Blöcke und Tabellen hier
// entfernt bzw. angesagt.

export interface SpeechTextOptions {
  /**
   * Maximale Zeichen pro Chunk. Für die Web Speech API klein halten: Chrome
   * bricht lange Utterances nach ~15 s ab, kurze Chunks umgehen das.
   */
  maxChunkChars?: number;
  /** Für übersprungene Blöcke eine kurze Ansage einfügen. */
  announceSkipped?: boolean;
}

export interface SpeechArticle {
  title?: string | null;
  summary?: string | null;
  content?: string | null;
}

const DEFAULT_MAX_CHUNK_CHARS = 220;

// Platzhalter, um Punkte zu schützen, die kein Satzende sind.
const DOT = "";

// Deutsche Abkürzungen, an denen nicht getrennt werden darf.
const ABBREVIATIONS = [
  "z.B.",
  "z. B.",
  "d.h.",
  "d. h.",
  "u.a.",
  "u. a.",
  "i.d.R.",
  "u.U.",
  "o.ä.",
  "bzw.",
  "etc.",
  "usw.",
  "ca.",
  "vgl.",
  "ggf.",
  "inkl.",
  "exkl.",
  "max.",
  "min.",
  "evtl.",
  "bspw.",
  "Mio.",
  "Mrd.",
  "Tsd.",
  "Dr.",
  "Prof.",
  "Nr.",
  "Abb.",
  "Tab.",
  "Str.",
  "Jh.",
  "Bd.",
  "Hrsg.",
  "Aufl.",
];

/** Kompletten Artikel in vorlesbare Chunks zerlegen (Titel → Summary → Inhalt). */
export function buildArticleSpeech(
  article: SpeechArticle,
  options: SpeechTextOptions = {},
): string[] {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const announceSkipped = options.announceSkipped ?? true;

  const blocks: string[] = [];

  const title = markdownToSpeech(article.title ?? "", false).trim();
  if (title) blocks.push(endWithPeriod(title));

  const summary = markdownToSpeech(article.summary ?? "", false).trim();
  if (summary) blocks.push(endWithPeriod(summary));

  const content = markdownToSpeech(article.content ?? "", announceSkipped).trim();
  if (content) blocks.push(content);

  return splitIntoChunks(blocks.join("\n\n"), maxChunkChars);
}

/** Markdown von Syntax befreien, Struktur als Absätze erhalten. */
export function markdownToSpeech(
  markdown: string,
  announceSkipped = true,
): string {
  if (!markdown) return "";

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let inTable = false;

  for (const raw of lines) {
    // Code-Blöcke: Inhalt überspringen, einmal ansagen
    if (/^\s*(```|~~~)/.test(raw)) {
      if (inFence) {
        inFence = false;
      } else {
        inFence = true;
        if (announceSkipped) {
          out.push("", "Codebeispiel übersprungen.", "");
        }
      }
      continue;
    }
    if (inFence) continue;

    // Tabellen sind vorgelesen unbrauchbar → überspringen, einmal ansagen
    if (/^\s*\|/.test(raw)) {
      if (!inTable) {
        inTable = true;
        if (announceSkipped) out.push("", "Tabelle übersprungen.", "");
      }
      continue;
    }
    inTable = false;

    const trimmed = raw.trim();

    // Absatzgrenze
    if (!trimmed) {
      out.push("");
      continue;
    }

    // Horizontale Linie
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push("");
      continue;
    }

    // Blockquote-Marker entfernen, Inhalt normal weiterverarbeiten
    let line = trimmed.replace(/^>\s?/, "");

    // Überschrift: als eigener Absatz, damit die Stimme davor/danach pausiert
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const text = cleanInline(heading[1]);
      if (text) out.push("", endWithPeriod(text), "");
      continue;
    }

    // Listenpunkt: Marker weg, Satzzeichen erzwingen (sonst hetzt die Stimme durch)
    const listItem = line.match(/^([-*+]|\d+[.)])\s+(.*)$/);
    if (listItem) {
      const text = cleanInline(listItem[2]);
      if (text) out.push(endWithPeriod(text));
      continue;
    }

    const text = cleanInline(line);
    if (text) out.push(text);
  }

  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Inline-Markdown, HTML und URLs aus einer Zeile entfernen. */
function cleanInline(input: string): string {
  let text = input;

  // Bilder ganz weg (Alt-Text hilft beim Hören nicht)
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");

  // Wiki-Links [[slug|label]] → Anzeigetext
  text = text.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, slug: string, label?: string) =>
      label || (slug.split("/").pop() || slug).replace(/-/g, " "),
  );

  // Markdown-Links → nur der Linktext
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

  // Fußnoten-Referenzen
  text = text.replace(/\[\^[^\]]+\]/g, "");

  // Autolinks und rohe URLs – vorgelesene URLs sind unerträglich.
  // Nachgestellte Interpunktion bleibt stehen, sonst verliert der Satz sein Ende.
  text = text.replace(/<https?:\/\/[^>]+>/g, "");
  text = text.replace(/https?:\/\/\S+/g, (url) => {
    const trailing = url.match(/[.,;:!?)\]]+$/);
    return trailing ? trailing[0] : "";
  });

  // Inline-Code und Hervorhebungen (einzelne _ bleiben stehen:
  // snake_case-Bezeichner sind in Knora-Artikeln häufiger als _kursiv_)
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // Rest-HTML
  text = text.replace(/<[^>]+>/g, "");
  text = text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "und")
    .replace(/&lt;/g, "")
    .replace(/&gt;/g, "")
    .replace(/&quot;/g, "")
    .replace(/&#39;/g, "'");

  return text
    .replace(/\s+/g, " ")
    // Lücken, die durch entfernte URLs/Bilder entstehen ("… unter .")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim();
}

/**
 * Text in Chunks zerlegen – an Absatz-, sonst an Satzgrenzen.
 * Ein Chunk ist die Einheit, die am Stück gesprochen wird.
 */
export function splitIntoChunks(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      chunks.push(paragraph);
      continue;
    }

    let buffer = "";
    for (const sentence of splitSentences(paragraph)) {
      if (sentence.length > maxChars) {
        if (buffer) {
          chunks.push(buffer);
          buffer = "";
        }
        chunks.push(...splitOnWords(sentence, maxChars));
        continue;
      }
      if (!buffer) {
        buffer = sentence;
      } else if (buffer.length + 1 + sentence.length <= maxChars) {
        buffer += " " + sentence;
      } else {
        chunks.push(buffer);
        buffer = sentence;
      }
    }
    if (buffer) chunks.push(buffer);
  }

  return chunks;
}

/** Sätze trennen, ohne an Abkürzungen und Zahlen wie "3.7" zu zerbrechen. */
function splitSentences(text: string): string[] {
  let masked = text;
  for (const abbreviation of ABBREVIATIONS) {
    masked = masked.split(abbreviation).join(abbreviation.replace(/\./g, DOT));
  }
  // Dezimal- und Tausenderpunkte
  masked = masked.replace(/(\d)\.(\d)/g, `$1${DOT}$2`);

  const sentences: string[] = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (!".!?…".includes(masked[i])) continue;
    // Nachgestellte Satzzeichen mitnehmen (z. B. »…«, Anführungszeichen)
    let end = i + 1;
    while (end < masked.length && '.!?…"»)]\''.includes(masked[end])) end++;
    // Satzende nur, wenn Leerraum oder Textende folgt
    if (end < masked.length && !/\s/.test(masked[end])) continue;
    const sentence = masked.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
    i = end - 1;
  }
  const rest = masked.slice(start).trim();
  if (rest) sentences.push(rest);

  return sentences.map((s) => s.split(DOT).join("."));
}

/** Notnagel für überlange Sätze: an Wortgrenzen aufteilen. */
function splitOnWords(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let buffer = "";
  for (const word of text.split(/\s+/)) {
    if (!buffer) {
      buffer = word;
    } else if (buffer.length + 1 + word.length <= maxChars) {
      buffer += " " + word;
    } else {
      parts.push(buffer);
      buffer = word;
    }
  }
  if (buffer) parts.push(buffer);
  return parts;
}

function endWithPeriod(text: string): string {
  return /[.!?:…]$/.test(text) ? text : text + ".";
}

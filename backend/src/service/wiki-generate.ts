/**
 * Wiki-Generierungs-Pipeline
 *
 * 1. extractCandidates  – LLM scannt Dokument → Entities + Concepts
 * 2. generateSummary     – LLM schreibt Wiki-Artikel mit [[links]]
 * 3. reduceEntitiesConcepts – Entity/Concept-Seiten anlegen/updaten
 * 4. injectCrossLinks    – Automatische Links in bestehenden Seiten
 * 5. updateIndexIntro    – Index-Intro aktualisieren
 */

import { db } from "../db/index.ts";
import {
  documents,
  wikiPages,
  wikis,
  chunks,
} from "../db/schema.ts";
import { eq, and, inArray } from "drizzle-orm";
import {
  WIKI_CANDIDATE_SLUG_PROMPT,
  WIKI_SUMMARY_PROMPT,
  WIKI_PAGE_MODIFY_PROMPT,
  WIKI_DEDUP_PROMPT,
  WIKI_INDEX_INTRO_PROMPT,
  WIKI_CHUNK_CITATION_PROMPT,
  docKindOf,
  granularityGuidance,
  normalizeProtocolFlags,
  pagePromptFor,
  summaryPromptFor,
  zeitmarkenRegel,
} from "./wiki-prompts.ts";
import * as wikiService from "./wiki.ts";
import * as topicService from "./topic.ts";
import { getActiveProvider, callLLM, callLLMJson } from "./llm.ts";
import { USAGE } from "./usage.ts";
import { getGlossary, glossaryForPrompt } from "./glossary.ts";

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

interface ExtractedItem {
  name: string;
  slug: string;
  aliases: string[];
  description: string;
  details: string;
}

interface CombinedExtraction {
  entities: ExtractedItem[];
  concepts: ExtractedItem[];
}

interface WikiResult {
  slug: string;
  title: string;
  summary: string;
  content: string;
  page_type: string;
  source_chunks?: string[];
}

interface Chapter {
  title: string;
  text: string;
  /**
   * true = `title` ist nur ein mechanischer Notnagel (Größen-Split innerhalb
   * EINER Überschrift, z.B. „Transkript"/„Transkript (Teil 3)"). Solche Titel
   * sagen nichts über den Inhalt, deshalb hat der vom LLM generierte Artikel-
   * titel Vorrang. Bei echten Dokument-Überschriften bleibt es umgekehrt.
   */
  titleIsFallback?: boolean;
}

// Zielgröße pro Kapitel in Zeichen (~10-15 Seiten) – das Fenster, das die
// Summary-/Extraktions-Prompts zuverlässig als Ganzes verarbeiten. Über
// WIKI_CHAPTER_CHARS konfigurierbar.
const CHAPTER_CHARS = parseInt(process.env.WIKI_CHAPTER_CHARS || "32000");

// Wiki-Tiefe-Steuerung (kombiniert Auto-Deckel + Summary-only in EINER Einstellung
// wiki_config.wiki_depth). Harte Obergrenze für Entity/Concept-Seiten pro Import im
// Modus "capped" – verhindert die Seiten-Explosion bei großen Dokumenten.
const WIKI_MAX_PAGES_CEILING = parseInt(
  process.env.WIKI_MAX_PAGES_CEILING || "120",
);
// Ab so vielen Kapiteln stuft der Default-Modus "capped" automatisch auf
// summary-only herunter (nur Kapitel-Artikel, keine teuren Entity/Concept-Seiten),
// um Stunden-Läufe/Kostenexplosion bei Riesen-Dokumenten zu vermeiden.
const WIKI_SUMMARY_ONLY_CHAPTERS = parseInt(
  process.env.WIKI_SUMMARY_ONLY_CHAPTERS || "25",
);

// Wie viele bestehende Themen-Slugs als Kontext in den Extraktions-Prompt
// gehen. Ein Deckel ist unvermeidlich – bei mehreren tausend Seiten passt die
// Liste nicht in einen Prompt. Die verlässliche Zusammenführung übernimmt
// deshalb nicht das LLM, sondern der deterministische Abgleich in
// resolveSlugAgainstExisting().
const PREVIOUS_SLUGS_IN_PROMPT = parseInt(
  process.env.WIKI_PREVIOUS_SLUGS || "300",
);

/**
 * Normalisiert Slug-/Titel-/Alias-Text für den Abgleich: Kleinschreibung,
 * Umlaute aufgelöst, alles Nicht-Alphanumerische zu Bindestrichen. So findet
 * "Impfpflicht" auch die bestehende Seite "concept/impfpflicht", und
 * "SARS-CoV-2" trifft "sars-cov-2".
 */
function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/^(entity|concept)\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Zeilenanfang der Form `[12:34] ` — so schreibt buildDocumentText die
 * Zeitmarken in den Dokumenttext.
 */
const ZEITMARKE_IM_TEXT = /^\[\d{1,3}:\d{2}(?::\d{2})?\]\s/m;

/**
 * Video-URL für die Zeitmarken-Zitate — oder null, wenn dieses Dokument keine
 * Zeitmarken trägt.
 *
 * Geprüft wird der Text selbst statt nur des Dokumenttyps: ein vor der
 * Umstellung importiertes Video ist weiterhin `type = "youtube"`, hat aber
 * keine Marken. Ohne diese Prüfung bekäme das Modell die Anweisung, auf
 * Zeitmarken zu verweisen, die es nirgends findet — und würde sie erfinden.
 */
function videoUrlFürZeitmarken(doc: {
  type: string;
  source_url: string | null;
  source: string;
  content: string | null;
}): string | null {
  if (doc.type !== "youtube") return null;
  if (!doc.content || !ZEITMARKE_IM_TEXT.test(doc.content)) return null;
  return doc.source_url || doc.source || null;
}

// ---------------------------------------------------------------------------
// Hauptfunktion
// ---------------------------------------------------------------------------

export async function generateWikiArticles(
  docId: string,
  wikiId: string,
  /**
   * Beim Import gewählter Anbieter. Optional und nur ein Wunsch: gehört er
   * nicht zur Organisation des Wiki oder ist er inzwischen weg, wird der
   * übliche genommen (service/provider.ts).
   */
  providerId?: string,
): Promise<{ summary: any; entities: number; concepts: number } | null> {
  const t0 = Date.now();
  console.log(`[wiki-gen] ========== START ==========`);
  console.log(`[wiki-gen] Dokument: ${docId}, Wiki: ${wikiId}`);

  // 1. Dokument laden
  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, docId))
    .limit(1);

  if (!doc || !doc.content) {
    console.log(`[wiki-gen] ❌ Dokument nicht gefunden oder leer`);
    return null;
  }

  // 2. Chat-Provider laden — den gewählten, sonst den aktiven
  const provider = await getActiveProvider({ wikiId, providerId });
  if (!provider) {
    console.log(`[wiki-gen] ❌ Kein Chat-Provider konfiguriert`);
    return null;
  }

  // 3. Wiki-Konfiguration laden
  const [ws] = await db
    .select()
    .from(wikis)
    .where(eq(wikis.id, wikiId))
    .limit(1);
  const language = ws?.wiki_config?.wiki_language || "de";
  const granularity = ws?.wiki_config?.extraction_granularity || "standard";
  const maxPages = ws?.wiki_config?.max_pages_per_ingest || 10;

  // Dokumentart bestimmt die Prompts. Ein Sitzungsprotokoll braucht eine andere
  // Textsorte als ein Video-Transkript (Chronologie und Sprecherzuordnung statt
  // Lexikonartikel) – siehe wiki-prompts.ts.
  const docKind = docKindOf(doc.source_metadata);
  if (docKind !== "default") {
    console.log(`[wiki-gen] 📄 Dokumentart: ${docKind} (eigene Prompts)`);
  }

  // Wiki-Tiefe: "full" (alles, kein Deckel) | "capped" (Entity/Concept-Seiten,
  // gedeckelt + Auto-Summary bei sehr großen Docs) | "summary" (nur Kapitel-Artikel)
  // | "off" (kein Wiki – Dokument ist trotzdem via Chat/RAG durchsuchbar).
  // Default "capped": sinnvoll bounded ohne manuelles Konfigurieren.
  const wikiDepth = ws?.wiki_config?.wiki_depth || "capped";
  if (wikiDepth === "off") {
    console.log(`[wiki-gen] ⏭️ wiki_depth="off" – Wiki-Generierung übersprungen`);
    return null;
  }

  // 4. Existierende Entity-/Concept-Seiten laden (für Deduplizierung).
  //
  // Bewusst schlank und UNBEGRENZT statt listPages({page_size: 500}):
  //  - Das 500er-Fenster war nach updated_at sortiert und füllte sich in einem
  //    großen Wiki mit `summary-<uuid>`-Slugs. Die sind als Linkziel
  //    nutzlos und verdrängten die echten Themenseiten aus dem Prompt – das LHM
  //    sah bestehende Slugs nicht mehr und erfand neue, sodass ein Thema
  //    mehrere konkurrierende Seiten bekam statt einer wachsenden.
  //  - Nur slug/title/aliases, kein content: das Fenster hat vorher bis zu 500
  //    vollständige Artikel in den Heap geladen.
  const existingTopicPages = await db
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      aliases: wikiPages.aliases,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.wiki_id, wikiId),
        inArray(wikiPages.page_type, ["entity", "concept"]),
      ),
    );

  // Dokument in Kapitel (~CHAPTER_CHARS) zerlegen, damit das GANZE Dokument
  // verarbeitet wird statt bei 32k Zeichen abgeschnitten. Kurze Dokumente ergeben
  // genau ein Kapitel = bisheriges Verhalten.
  const chapters = verwertbareKapitel(
    splitIntoChapters(doc.content, CHAPTER_CHARS),
  );
  const multiChapter = chapters.length > 1;
  console.log(
    `[wiki-gen] 📖 Dokument in ${chapters.length} Kapitel zerlegt (~${CHAPTER_CHARS} Zeichen/Kapitel)`,
  );

  // Effektive Tiefe: Im Default-Modus "capped" sehr große Dokumente automatisch auf
  // summary-only herunterstufen. "full" bleibt bewusst unangetastet (Power-User).
  let depth = wikiDepth;
  if (depth === "capped" && chapters.length >= WIKI_SUMMARY_ONLY_CHAPTERS) {
    depth = "summary";
    console.log(
      `[wiki-gen] ⚙️ ${chapters.length} Kapitel ≥ ${WIKI_SUMMARY_ONLY_CHAPTERS} → Auto-Summary-Modus (keine Entity/Concept-Seiten)`,
    );
  }
  // Entity/Concept-Seiten nur in "full"/"capped"; "summary" erzeugt nur Kapitel.
  const generatePages = depth === "full" || depth === "capped";

  // Seiten-Budget pro Kapitel skalieren: "full" unbegrenzt (maxPages × Kapitel),
  // "capped" zusätzlich hart gedeckelt gegen die Seiten-Explosion.
  const effectiveMaxPages =
    depth === "capped"
      ? Math.min(WIKI_MAX_PAGES_CEILING, maxPages * chapters.length)
      : maxPages * chapters.length;

  console.log(`[wiki-gen] 🎚️ Wiki-Tiefe: ${depth} (konfiguriert: ${wikiDepth})`);

  // Kontext für die Extraktion. Bei mehreren tausend Themenseiten passt die
  // Liste nicht mehr in einen Prompt, deshalb ein Deckel – die eigentliche
  // Zusammenführung übernimmt danach resolveSlugAgainstExisting() deterministisch,
  // nicht das LLM.
  const previousSlugs = existingTopicPages
    .slice(0, PREVIOUS_SLUGS_IN_PROMPT)
    .map((p) => `[[${p.slug}|${p.title}]]`)
    .join("\n");

  /**
   * Ordnet einen vom LLM vorgeschlagenen Kandidaten einer bestehenden Seite zu.
   *
   * Nötig, weil der Prompt bei großen Wikis unmöglich alle bestehenden Slugs
   * enthalten kann: das LLM würde für ein längst vorhandenes Thema einen neuen
   * Slug erfinden und die Seite spalten. Der Abgleich läuft über normalisierten
   * Slug, Titel und Aliase – kostet keine Tokens und ist reproduzierbar.
   */
  // Der Schlüssel trägt immer das Präfix mit: eine Entität darf nie mit einer
  // Konzeptseite zusammengeführt werden (gleiche Regel wie im Dedup-Prompt).
  const slugIndex = new Map<string, string>();
  for (const p of existingTopicPages) {
    const prefix = p.slug.startsWith("entity/") ? "entity" : "concept";
    const add = (text: string) => {
      const k = normalizeKey(text);
      if (k) slugIndex.set(`${prefix}/${k}`, p.slug);
    };
    add(p.slug);
    add(p.title);
    for (const a of (p.aliases as string[] | null) ?? []) {
      if (typeof a === "string" && a.trim()) add(a);
    }
  }
  function resolveSlugAgainstExisting(item: ExtractedItem): string {
    const prefix = item.slug.startsWith("entity/") ? "entity" : "concept";
    const keys = [item.slug, item.name, ...(item.aliases || [])]
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
      .map((t) => `${prefix}/${normalizeKey(t)}`);
    for (const k of keys) {
      const hit = slugIndex.get(k);
      if (hit) return hit;
    }
    return item.slug;
  }

  // =========================================================================
  // SCHRITT 1: Kandidaten extrahieren (Entities + Concepts) – über ALLE Kapitel
  // Im Summary-Modus übersprungen (keine Entity/Concept-Seiten → keine Extraktion
  // nötig; spart bei großen Dokumenten die teuersten Zusatz-Calls).
  // =========================================================================
  const candidateMap = new Map<string, ExtractedItem>();
  let reusedSlugs = 0;
  if (generatePages) {
    console.log(
      `[wiki-gen] 🔍 Schritt 1: Extrahiere Kandidaten aus ${chapters.length} Kapitel(n)...`,
    );
    for (let i = 0; i < chapters.length; i++) {
      const extractionJson = await callLLMJson<CombinedExtraction>(
        provider,
        WIKI_CANDIDATE_SLUG_PROMPT.replace("{{content}}", chapters[i].text)
          .replace(/\{\{language\}\}/g, language)
          .replace("{{previousSlugs}}", previousSlugs || "Keine")
          .replace("{{granularityGuidance}}", granularityGuidance(granularity)),
        { kind: USAGE.llmWikiGenerate, wikiId, refId: docId },
      );
      if (!extractionJson) continue;
      for (const it of [
        ...(extractionJson.entities || []),
        ...(extractionJson.concepts || []),
      ]) {
        // Vor dem Zusammenführen auf eine bestehende Seite umbiegen, falls es
        // sie schon gibt. Ohne diesen Schritt hängt die Zusammenführung daran,
        // dass der Prompt alle bestehenden Slugs enthält – was bei mehreren
        // tausend Seiten nicht mehr möglich ist.
        const resolved = resolveSlugAgainstExisting(it);
        if (resolved !== it.slug) {
          reusedSlugs++;
          it.slug = resolved;
        }
        mergeCandidate(candidateMap, it);
      }
    }
    console.log(
      `[wiki-gen] ✅ ${candidateMap.size} Kandidaten (dedupliziert über alle Kapitel)` +
        (reusedSlugs > 0 ? `, ${reusedSlugs}× auf bestehende Seite umgebogen` : ""),
    );
  } else {
    console.log(`[wiki-gen] ⏭️ Schritt 1 übersprungen (Summary-Modus)`);
  }

  const allCandidates = [...candidateMap.values()];
  const extractedSlugsText = allCandidates
    .map((e) => `  - [[${e.slug}|${e.name}]]`)
    .join("\n");

  // =========================================================================
  // SCHRITT 2: Kapitel-Artikel generieren (+ Übersichtsseite bei mehreren Kapiteln)
  // =========================================================================
  console.log(
    `[wiki-gen] 📝 Schritt 2: Generiere ${chapters.length} Kapitel-Artikel...`,
  );

  // Einmal für den ganzen Lauf: entweder trägt das Dokument Zeitmarken oder nicht.
  const zeitmarken = zeitmarkenRegel(videoUrlFürZeitmarken(doc));
  if (zeitmarken) {
    console.log(`[wiki-gen] ⏱️ Zeitmarken vorhanden – Artikel dürfen belegen`);
  }

  const baseSlug = slugify(`summary-${doc.id}`);
  const chapterSlugs: string[] = [];
  const chapterLinks: string[] = [];
  let summaryPage: any = null;
  let protocolFlags: { flags: string[]; quotes: string[] } | null = null;

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    const summaryRaw = await callLLM(
      provider,
      summaryPromptFor(docKind)
        .replace("{{content}}", chapter.text)
        .replace(/\{\{timestampRule\}\}/g, zeitmarken)
        .replace(/\{\{language\}\}/g, language)
        .replace(/\{\{sessionLabel\}\}/g, doc.title)
        .replace("{{extractedSlugs}}", extractedSlugsText || "Keine")
        // Nur geprüfte Auflösungen. Kürzel, die nicht in dieser Liste stehen,
        // darf das Modell laut Prompt nicht auflösen – siehe service/glossary.ts.
        .replace(
          "{{glossar}}",
          glossaryForPrompt(await getGlossary(doc.wiki_id)),
        ),
    );
    if (!summaryRaw) {
      console.log(`[wiki-gen] ⚠️ Kapitel ${i + 1}: Summary fehlgeschlagen`);
      continue;
    }

    const sumMatch = summaryRaw.match(/SUMMARY:\s*(.+)/im);
    const summaryLine = sumMatch ? sumMatch[1].trim() : "";
    let body = summaryRaw.replace(/SUMMARY:\s*.+(\r?\n|$)/i, "").trim();

    // Brisanz-Marker aus der FLAGS-Zeile lösen und aus dem Artikeltext
    // entfernen – sie gehören in page_metadata, nicht in den Fließtext.
    // Absichtlich ohne Zeilenende-Anker und ohne Positionsannahme: die Zeile
    // soll laut Prompt an zweiter Stelle stehen, Modelle setzen sie aber
    // gelegentlich woanders hin, und ein zu strenges Muster verwirft sie dann
    // stillschweigend.
    const flagsMatch = body.match(/FLAGS:\s*(\{[\s\S]*?\})/);
    if (flagsMatch) {
      body = body.replace(flagsMatch[0], "").trim();
      try {
        const parsed = JSON.parse(flagsMatch[1]);
        // Gegen das geschlossene Vokabular normalisieren: das Modell hielt sich
        // nicht an die Liste im Prompt und erfand Varianten.
        const flags = normalizeProtocolFlags(parsed.flags);
        const quotes = Array.isArray(parsed.quotes)
          ? parsed.quotes.filter((q: unknown) => typeof q === "string").slice(0, 3)
          : [];
        protocolFlags = { flags, quotes };
      } catch {
        console.log(`[wiki-gen] ⚠️ FLAGS-Block nicht lesbar, wird ignoriert`);
      }
    } else if (docKind === "meeting_protocol") {
      // Sichtbar machen statt schlucken: ohne Marker fehlt das Dokument später
      // in der Auffälligkeiten-Facette, und das wäre ohne Hinweis nicht zu
      // erklären.
      console.log(
        `[wiki-gen] ⚠️ Keine FLAGS-Zeile in der Antwort – Auffälligkeiten fehlen für dieses Protokoll`,
      );
    }
    // Titel-Priorität: echte Dokument-Überschrift → vom LLM generierter Artikel-
    // titel (# …) → generischer Fallback. So bekommen auch PDFs ohne Markdown-
    // Überschriften aussagekräftige Kapitel-Titel statt "Kapitel N".
    // Bei mechanischen Größen-Splits (titleIsFallback) ist die Reihenfolge
    // umgedreht: „Transkript (Teil 3)" sagt nichts, der Artikel-Titel schon.
    const titleMatch = body.match(/^#\s+(.+)/m);
    const llmTitle = titleMatch ? titleMatch[1].trim() : "";
    // Bei Sitzungsprotokollen ist der Titel eine Tatsache, keine Formulierung:
    // "2020-03-04 · Krisenstab" kommt aus dem Dokument, nicht aus der
    // LLM-Antwort. Datum zuerst heißt, dass alphabetisch sortieren
    // chronologisch sortiert und Abschneiden in der UI das Datum nie frisst.
    let chapterTitle =
      docKind === "meeting_protocol"
        ? multiChapter
          ? `${doc.title} – Teil ${i + 1}`
          : doc.title
        : (chapter.titleIsFallback
            ? llmTitle || chapter.title
            : chapter.title || llmTitle) ||
          (multiChapter ? `${doc.title} – Teil ${i + 1}` : doc.title);
    // Kein Kapitel darf denselben Titel wie die Übersichtsseite tragen – sonst
    // steht der Dokumenttitel doppelt in der Navigation.
    if (
      docKind !== "meeting_protocol" &&
      multiChapter &&
      sameTitle(chapterTitle, doc.title)
    ) {
      chapterTitle =
        llmTitle && !sameTitle(llmTitle, doc.title)
          ? llmTitle
          : `${doc.title} – Teil ${i + 1}`;
    }

    // Bei mehreren Kapiteln eindeutiger Slug pro Kapitel; bei einem Kapitel der
    // bisherige Summary-Slug (Rückwärtskompatibilität + sauberer Re-Import).
    const chapterSlug = multiChapter ? `${baseSlug}-k${i + 1}` : baseSlug;

    const page = await upsertPage(wikiId, chapterSlug, {
      title: chapterTitle,
      content: body,
      summary: summaryLine,
      page_type: "summary",
      source_document_id: docId,
      // Kapitel hängen an der Übersichtsseite (Basis-Slug), die weiter unten
      // erzeugt wird; bei nur einem Kapitel gibt es keine Übersicht.
      parent_slug: multiChapter ? baseSlug : null,
      sort_order: multiChapter ? i + 1 : 0,
    });
    chapterSlugs.push(chapterSlug);
    chapterLinks.push(`- Kapitel ${i + 1}: [[${chapterSlug}|${chapterTitle}]]`);
    if (!summaryPage) summaryPage = page;
    console.log(
      `[wiki-gen] ✅ Kapitel ${i + 1}/${chapters.length}: "${chapterTitle}" (${body.length} Zeichen)`,
    );
  }

  // Übersichtsseite mit Inhaltsverzeichnis (nur bei mehreren Kapiteln). Behält den
  // Basis-Slug, sodass Verlinkungen auf "das Dokument" auf die Übersicht zeigen.
  if (multiChapter) {
    const overviewContent =
      `# ${doc.title}\n\n` +
      `Dieses Dokument ist in ${chapters.length} Kapitel gegliedert.\n\n` +
      `## Kapitel\n\n${chapterLinks.join("\n")}`;
    summaryPage = await upsertPage(wikiId, baseSlug, {
      title: doc.title,
      content: overviewContent,
      summary: `Übersicht über ${chapters.length} Kapitel aus „${doc.title}".`,
      page_type: "summary",
      source_document_id: docId,
      parent_slug: null,
      sort_order: 0,
    });
  }

  // Brisanz-Marker auf der Artikelseite ablegen. page_metadata wurde von dieser
  // Pipeline bisher nie beschrieben; die Marker machen aus "irgendwo in 378
  // Protokollen" eine filterbare Liste auffälliger Sitzungen.
  if (protocolFlags && summaryPage) {
    const existingMeta = (summaryPage.page_metadata ?? {}) as Record<string, unknown>;
    await db
      .update(wikiPages)
      .set({
        page_metadata: {
          ...existingMeta,
          flags: protocolFlags.flags,
          flag_quotes: protocolFlags.quotes,
          session_date: (doc.source_metadata as any)?.session_date ?? null,
          committee: (doc.source_metadata as any)?.committee ?? null,
        },
      })
      .where(eq(wikiPages.id, summaryPage.id));
    console.log(
      `[wiki-gen] 🚩 Auffälligkeiten: ${protocolFlags.flags.join(", ") || "keine"}`,
    );
  }

  /**
   * Kapitelseiten aus einem früheren Lauf abräumen, die es jetzt nicht mehr
   * gibt.
   *
   * Die Slugs sind durchnummeriert (`…-k1`, `-k2`, …). Erzeugt ein zweiter
   * Lauf weniger Kapitel als der erste — etwa weil ein leeres Kapitel nicht
   * mehr entsteht oder das Transkript neu geholt wurde — bliebe das letzte
   * sonst als Waise in der Navigation stehen, mit Inhalt aus dem alten Stand.
   *
   * Von Hand bearbeitete Seiten bleiben: dort steckt Arbeit drin, die nicht
   * still verschwinden darf. Sie werden gemeldet statt gelöscht.
   */
  if (multiChapter || chapterSlugs.length > 0) {
    const alle = await db
      .select({ slug: wikiPages.slug, manuell: wikiPages.manually_edited })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.wiki_id, wikiId),
          eq(wikiPages.source_document_id, docId),
          eq(wikiPages.page_type, "summary"),
        ),
      );

    // Die Übersichtsseite trägt den Basis-Slug und steht deshalb nicht in
    // chapterSlugs (dort stehen `…-k1`, `-k2`, …). Ohne sie in der Sollmenge
    // löschte dieser Abräumer die gerade erzeugte Übersicht sofort wieder –
    // die Kapitel hingen dann an einem Elternteil, das es nicht mehr gab, und
    // die Trefferliste bündelte sie nicht mehr.
    const aktuell = new Set(chapterSlugs);
    if (multiChapter) aktuell.add(baseSlug);
    for (const p of alle) {
      if (aktuell.has(p.slug)) continue;
      if (p.manuell) {
        console.log(
          `[wiki-gen] ⚠️ Verwaistes Kapitel "${p.slug}" ist handbearbeitet – bleibt stehen`,
        );
        continue;
      }
      await wikiService.deletePage(wikiId, p.slug);
      console.log(`[wiki-gen] 🗑️ Verwaistes Kapitel entfernt: ${p.slug}`);
    }
  }

  // =========================================================================
  // SCHRITT 3: Chunk-Citation – ordne jedem Kandidaten seine Quell-Chunks zu
  // =========================================================================
  console.log(`[wiki-gen] 📎 Schritt 3: Chunk-Citation...`);

  // Quell-Chunks des Dokuments laden (chunk_index-Reihenfolge, globale [cNNN]-Labels)
  const sourceChunks = await loadSourceChunks(docId);
  const chunkByLabel = new Map<string, { id: string; content: string }>();
  sourceChunks.forEach((c) => chunkByLabel.set(c.label, c));

  // Aggregierte Zuordnung: slug -> Set<label>
  const citationsBySlug = new Map<string, Set<string>>();

  if (sourceChunks.length > 0 && allCandidates.length > 0) {
    const candidateList = allCandidates
      .map((c) => `- ${c.slug}: ${c.name}`)
      .join("\n");
    // Kein Batch-Deckel: alle Chunks des Dokuments werden zitiert, damit auch
    // Entitäten/Konzepte aus dem hinteren Teil des Dokuments echte Quell-Zitate
    // erhalten (früher nur die ersten 4 Batches ≈ 48k Zeichen).
    const batches = buildCitationBatches(
      sourceChunks,
      12000,
      Number.MAX_SAFE_INTEGER,
    );

    for (const batch of batches) {
      const chunksXml = batch
        .map((c) => `<c id="${c.label}">\n${c.content}\n</c>`)
        .join("\n");
      const citeJson = await callLLMJson<CitationResult>(
        provider,
        WIKI_CHUNK_CITATION_PROMPT.replace("{{candidateSlugs}}", candidateList)
          .replace("{{chunksXml}}", chunksXml)
          .replace(/\{\{language\}\}/g, language),
        { kind: USAGE.llmWikiGenerate, wikiId, refId: docId },
      );
      if (!citeJson) continue;

      // Zitate übernehmen
      for (const [slug, labels] of Object.entries(citeJson.citations || {})) {
        if (!Array.isArray(labels)) continue;
        const set = citationsBySlug.get(slug) || new Set<string>();
        labels.forEach((l) => {
          if (chunkByLabel.has(l)) set.add(l);
        });
        citationsBySlug.set(slug, set);
      }

      // Neu entdeckte Slugs aufnehmen (Nachentdeckung fehlender Konzepte)
      for (const ns of citeJson.new_slugs || []) {
        if (!ns?.slug || !ns?.name) continue;
        if (allCandidates.some((c) => c.slug === ns.slug)) continue;
        allCandidates.push({
          name: ns.name,
          slug: ns.slug,
          aliases: ns.aliases || [],
          description: ns.description || "",
          details: ns.details || "",
        });
        const set = citationsBySlug.get(ns.slug) || new Set<string>();
        (ns.source_chunks || []).forEach((l) => {
          if (chunkByLabel.has(l)) set.add(l);
        });
        citationsBySlug.set(ns.slug, set);
      }
    }
  }

  const citedCount = [...citationsBySlug.values()].filter(
    (s) => s.size > 0,
  ).length;
  console.log(
    `[wiki-gen] ✅ ${citedCount}/${allCandidates.length} Kandidaten mit Chunk-Zitaten`,
  );

  // =========================================================================
  // SCHRITT 4: Entity/Concept-Seiten kompilieren (Reduce, per LLM)
  // =========================================================================
  console.log(`[wiki-gen] 🔗 Schritt 4: Entity/Concept-Seiten kompilieren...`);

  let entityCount = 0;
  let conceptCount = 0;

  // Kandidaten mit den meisten Zitaten zuerst, auf maxPages begrenzen
  const prioritized = [...allCandidates].sort(
    (a, b) =>
      (citationsBySlug.get(b.slug)?.size || 0) -
      (citationsBySlug.get(a.slug)?.size || 0),
  );
  const toProcess = prioritized.slice(0, effectiveMaxPages);
  if (prioritized.length > effectiveMaxPages) {
    console.log(
      `[wiki-gen] ⚠️ ${prioritized.length} Kandidaten, begrenze auf ${effectiveMaxPages} (max_pages_per_ingest ${maxPages} × ${chapters.length} Kapitel)`,
    );
  }

  // Gültige Linkziele für diesen Import: die Seiten, die dieser Lauf anlegt oder
  // aktualisiert. Bewusst NICHT alle Slugs des Wikis. Diese Liste stand früher in
  // JEDEM Seiten-Prompt und machte die Kosten eines Imports proportional zur Größe
  // des Wikis: bei 3.600 Themenseiten rund 35k Tokens pro Seite, mal 30-40 Seiten.
  // Ab etwa 30.000 Seiten sprengt sie zusätzlich das Kontextfenster – der Anbieter
  // antwortet dann mit 400, callLLM gibt null zurück und die Seite wird stillschweigend
  // übersprungen. Für die Linkqualität leistet die volle Liste nichts, was nicht ohnehin
  // deterministisch passiert: Querverweise setzt injectCrossLinks per Textabgleich,
  // tote Links entfernt stripDeadLinks gegen das VOLLSTÄNDIGE Slug-Set aus der
  // Datenbank, und die Zusammenführung mit bestehenden Seiten macht
  // resolveSlugAgainstExisting – alles drei ohne Tokens.
  const linkZiele = [...new Set(toProcess.map((c) => c.slug))]
    .map((c) => `[[${c}]]`)
    .join("\n");

  for (const item of toProcess) {
    const existing = await wikiService.getPage(wikiId, item.slug);

    // <new_information> aus zitierten Chunks (wörtlich) bauen; Fallback: details
    const labels = [...(citationsBySlug.get(item.slug) || [])];
    const citedIds: string[] = [];
    let newInfo: string;
    if (labels.length > 0) {
      newInfo =
        `**${item.name}**: ${item.description}\n\n` +
        labels
          .map((l) => {
            const c = chunkByLabel.get(l)!;
            citedIds.push(c.id);
            return `[${l}] ${c.content}`;
          })
          .join("\n\n");
    } else {
      // Kein Zitat gefunden – Fallback auf Kurzbeschreibung + Details
      newInfo = `**${item.name}**: ${item.description}\n\n${item.details}`;
    }

    // Nur die Einleitung geht ins Modell; die Belegabschnitte früherer Quellen
    // bleiben unangetastet und werden unten wieder angehängt.
    const zerlegt = seiteZerlegen(existing?.content || "");

    const pagePrompt = buildPagePrompt({
      item,
      bisheriges: zerlegt.einleitung || "(Neue Seite)",
      newInformation: newInfo,
      language,
      linkZiele,
      docKind,
      sessionLabel: doc.title,
      zeitmarkenRegel: zeitmarken,
    });
    const raw = await callLLM(provider, pagePrompt, {
      kind: USAGE.llmWikiGenerate,
      wikiId,
      refId: docId,
    });
    if (!raw) continue;

    const sumMatch = raw.match(/SUMMARY:\s*(.+)/im);
    const body = raw.replace(/SUMMARY:\s*.+(\r?\n|$)/i, "").trim();
    const pageType = item.slug.startsWith("entity/") ? "entity" : "concept";

    // Antwort (Einleitung + Abschnitt dieser Quelle) mit dem Bestand verbinden.
    let content = seiteZusammenfügen({
      modellAusgabe: body,
      bestand: zerlegt.bestand,
      quelle: doc.title,
    });
    if (content === null) {
      // Antwort ohne Belege-Marker. Bei einer bereits umgestellten Seite dürfen
      // die Bestandsabschnitte deswegen nicht verloren gehen, also hier von Hand
      // wieder anhängen; bei einer Altseite ist die Antwort die ganze Seite.
      console.warn(
        `[wiki-gen] ⚠️ ${item.slug}: Antwort ohne "${zerlegt.marker || "Belege"}"-Marker`,
      );
      content = zerlegt.marker
        ? [body, zerlegt.marker, zerlegt.bestand].filter(Boolean).join("\n\n")
        : body;
    }

    if (existing) {
      await wikiService.updatePage(wikiId, item.slug, {
        title: existing.title,
        content,
        summary: sumMatch?.[1]?.trim() || item.description,
        page_type: pageType,
      });
      await mergeChunkRefs(existing.id, citedIds);
    } else {
      const page = await wikiService.createPage({
        wiki_id: wikiId,
        slug: item.slug,
        title: item.name,
        content,
        summary: sumMatch?.[1]?.trim() || item.description,
        page_type: pageType,
        source_document_id: docId,
      });
      const patch: Record<string, any> = {};
      if (item.aliases?.length > 0) patch.aliases = item.aliases;
      if (citedIds.length > 0) patch.chunk_refs = [...new Set(citedIds)];
      if (Object.keys(patch).length > 0) {
        await db.update(wikiPages).set(patch).where(eq(wikiPages.id, page.id));
      }
    }

    // Zählt erstellte UND aktualisierte Seiten (Slugs sind wiki-global,
    // bei Re-Import laufen bestehende Seiten über den Merge-Zweig)
    if (pageType === "entity") entityCount++;
    else conceptCount++;
  }

  // =========================================================================
  // SCHRITT 5: Cross-Links injizieren
  // =========================================================================
  console.log(`[wiki-gen] 🔄 Schritt 5: Injiziere Cross-Links...`);

  // Nur Seiten, die tatsächlich erstellt/aktualisiert wurden (verhindert tote Links).
  // Die Übersichtsseite (baseSlug bei mehreren Kapiteln) bleibt bewusst außen vor –
  // ihr Inhalt ist ein kontrolliertes Inhaltsverzeichnis, keine Fließtext-Seite.
  const affectedSlugs = [...chapterSlugs, ...toProcess.map((e) => e.slug)];

  // Gültige Ziel-Slugs (für Dead-Link-Bereinigung) einmalig laden.
  // Bewusst eine schlanke, UNBEGRENZTE Slug-Abfrage statt listPages({page_size:
  // 1000}): stripDeadLinks entfernt jeden [[Link]], dessen Ziel nicht in diesem
  // Set steht. Mit einem Fenster von 1000 Seiten löscht die Bereinigung in einem
  // größeren Wiki gültige Links – Datenverlust, der mit jedem Lauf wächst.
  // Nebeneffekt: listPages selektiert alle Spalten inkl. content, hier also
  // vorher bis zu 1000 vollständige Artikel im Heap.
  const validSlugSet = new Set(
    (
      await db
        .select({ slug: wikiPages.slug })
        .from(wikiPages)
        .where(eq(wikiPages.wiki_id, wikiId))
    ).map((r) => r.slug),
  );

  // Für jede betroffene Seite: Links von anderen Seiten einfügen + tote Links entfernen
  for (const slug of affectedSlugs) {
    const page = await wikiService.getPage(wikiId, slug);
    if (!page || !page.content) continue;

    const refs = toProcess
      .filter((c) => c.slug !== slug) // nicht auf sich selbst verlinken
      .map((c) => ({ slug: c.slug, matchText: c.name }));

    let newContent = injectCrossLinks(page.content, refs);
    newContent = stripDeadLinks(newContent, validSlugSet);

    if (newContent !== page.content) {
      await wikiService.updatePage(wikiId, slug, { content: newContent });
    }
  }

  // =========================================================================
  // SCHRITT 6: Index-Intro aktualisieren
  // =========================================================================
  console.log(`[wiki-gen] 📋 Schritt 6: Aktualisiere Index-Intro...`);

  const indexPage = await wikiService.getPage(wikiId, "index");
  if (!indexPage || !indexPage.content) {
    // Index neu erstellen
    const stats = await wikiService.getStats(wikiId);
    const indexIntro = `# Wiki Index\n\nDieses Wiki enthält ${stats.total_pages} Seiten aus importierten Dokumenten.`;
    await wikiService.createPage({
      wiki_id: wikiId,
      slug: "index",
      title: "Wiki Index",
      content: indexIntro,
      summary: indexIntro,
      page_type: "index",
    });
  }

  // Neu erzeugte Wiki-Chunks embedden, damit sie in der Vektorsuche (Chat-RAG)
  // auffindbar sind.
  //
  // Seit dem 21. August ein Job statt eines nicht abgewarteten `.then()`. Das
  // löst zwei Dinge auf einmal:
  //
  // 1. Ein Neustart verlor den Lauf, und weil `chunks.embedding` dabei `NULL`
  //    blieb, waren die Chunks für die Suche unsichtbar — ohne Fehlermeldung.
  // 2. `embedWorkspaceChunks` arbeitet wiki-weit, nicht dokumentbezogen. Bei
  //    hunderten Aufrufen liefen entsprechend viele Sweeps gleichzeitig über
  //    dieselben Zeilen (kein FOR UPDATE SKIP LOCKED), embedded Chunks doppelt
  //    und belegten dabei den DB-Pool. Der `singletonKey` je Wiki lässt davon
  //    einen übrig, der alles Offene mitnimmt (jobs/queue.ts).
  //
  // WIKI_EMBED_AFTER_GENERATE=0 schaltet es weiter ab. Für Massenläufe ist es
  // damit nicht mehr *zwingend* — ein `embed-backfill.ts` am Ende bleibt aber
  // der schnellere Weg, weil er die Warteschlange gar nicht erst anfasst.
  if (process.env.WIKI_EMBED_AFTER_GENERATE !== "0") {
    try {
      const { QUEUE, enqueue } = await import("../jobs/queue.ts");
      await enqueue(
        QUEUE.embed,
        { wikiId },
        { singletonKey: `embed:${wikiId}`, singletonSeconds: 60 },
      );
    } catch (e: any) {
      console.warn(`[wiki-gen] Embedding-Job nicht eingestellt:`, e?.message ?? e);
    }
  }

  // Auto-Themen-Klassifikation (Ebene 1): nur wenn der Wiki Themen hat und
  // das Dokument noch keine zugeordneten (überschreibt keine Handedits). Robust –
  // Fehler brechen die Wiki-Generierung nie ab.
  try {
    const classifyText =
      summaryPage?.summary || summaryPage?.content || doc.title;
    const topicIds = await topicService.classifyText(wikiId, classifyText);
    if (topicIds.length) {
      await topicService.assignAutoTopics(docId, topicIds);
      console.log(`[wiki-gen] 🏷️ ${topicIds.length} Themen zugeordnet`);
    }
  } catch (e: any) {
    console.warn(`[wiki-gen] Themen-Klassifikation übersprungen: ${e.message}`);
  }

  console.log(`[wiki-gen] ========== ENDE (${Date.now() - t0}ms) ==========`);

  // Ist kein einziger Artikel entstanden, ist der Lauf für dieses Dokument
  // gescheitert – auch wenn die Funktion sonst durchgelaufen ist. Vorher gab
  // sie ein Objekt mit summary: null zurück; jeder Aufrufer prüfte nur
  // "Objekt vorhanden" und meldete Erfolg. Bei einer Provider-Störung entstand
  // so eine Erfolgsmeldung für Dokumente, die keinen Artikel bekommen hatten.
  if (!summaryPage) {
    console.log(`[wiki-gen] ❌ Kein Artikel erzeugt (LLM lieferte nichts)`);
    return null;
  }

  return {
    summary: summaryPage,
    entities: entityCount,
    concepts: conceptCount,
  };
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Zerlegt langen Dokumenttext in Kapitel von je ~targetChars Zeichen. Bevorzugt
 * Schnitte an Markdown-Überschriften (# / ## / ###) und packt aufeinanderfolgende
 * Abschnitte bis zur Zielgröße; ohne Überschriften greift ein Größen-Fallback an
 * Absatzgrenzen. Kurze Dokumente ergeben genau EIN Kapitel (= bisheriges Verhalten).
 */
function splitIntoChapters(content: string, targetChars: number): Chapter[] {
  const text = content.trim();
  if (text.length <= targetChars) {
    return [{ title: "", text }];
  }

  const headingRe = /^#{1,3}\s+.+$/gm;
  const matches = [...text.matchAll(headingRe)];

  // Keine Überschriften: reiner Größen-Fallback an Absatzgrenzen. Titel bleibt leer
  // – der Kapitel-Titel wird später aus dem LLM-generierten Artikel abgeleitet.
  if (matches.length === 0) {
    return packBySize(text, targetChars).map((t) => ({
      title: "",
      text: t,
      titleIsFallback: true,
    }));
  }

  // In Abschnitte zerlegen (jede Überschrift startet einen neuen Abschnitt).
  const sections: { heading: string; body: string }[] = [];
  const firstIdx = matches[0].index!;
  if (firstIdx > 0) {
    const pre = text.slice(0, firstIdx).trim();
    if (pre) sections.push({ heading: "", body: pre });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    sections.push({
      heading: matches[i][0].replace(/^#{1,3}\s+/, "").trim(),
      body: text.slice(start, end),
    });
  }

  // Abschnitte in Kapitel bis targetChars packen.
  const chapters: Chapter[] = [];
  let curText = "";
  let curTitle = "";
  const flush = () => {
    if (curText.trim()) {
      // Leerer Titel = keine echte Überschrift gefunden; wird später aus dem
      // LLM-Artikel oder als "Titel – Teil N" abgeleitet.
      chapters.push({
        title: curTitle,
        text: curText.trim(),
        titleIsFallback: !curTitle,
      });
    }
    curText = "";
    curTitle = "";
  };

  for (const sec of sections) {
    // Einzelabschnitt größer als das Fenster: hart nach Größe splitten. Die
    // Überschrift beschreibt dann den GANZEN Abschnitt (z.B. „Transkript") und
    // nicht das einzelne Stück – deshalb sind alle Teil-Titel nur Fallback und
    // der inhaltliche Titel kommt später aus dem generierten Artikel.
    if (sec.body.length > targetChars) {
      flush();
      const parts = packBySize(sec.body, targetChars);
      parts.forEach((p, i) => {
        chapters.push({
          title: sec.heading
            ? i === 0
              ? sec.heading
              : `${sec.heading} (Teil ${i + 1})`
            : "",
          text: p.trim(),
          titleIsFallback: true,
        });
      });
      continue;
    }
    if (curText && curText.length + sec.body.length > targetChars) {
      flush();
    }
    if (!curTitle && sec.heading) curTitle = sec.heading;
    curText += (curText ? "\n\n" : "") + sec.body;
  }
  flush();
  return chapters;
}

/** Packt Text an Absatzgrenzen (\n\n) in Stücke ≤ maxChars; harte Notbremse bei Übergröße. */
/**
 * Kapitel ohne verwertbaren Inhalt aussortieren.
 *
 * Zweites Netz hinter der Korrektur in packBySize: auch andere Dokumente
 * können entartete Abschnitte hervorbringen — zwei Überschriften hintereinander,
 * eine Trennlinie, ein Abschnitt aus einem einzigen Aufzählungszeichen. Daraus
 * einen Artikel erzeugen zu lassen kostet Geld und liefert eine Seite, die
 * ihre eigene Leere beschreibt.
 *
 * Gemessen wird der Text ohne Überschriften, Aufzählungszeichen und
 * Zeichensetzung. Bleibt weniger als ein Satz übrig, ist es kein Kapitel.
 * Ein Dokument, das insgesamt nur aus einem solchen Abschnitt besteht, wird
 * nicht angetastet — dort ist die Leere die Aussage, und die vorhandene
 * „Leerer-Content-Regel" im Prompt fängt sie sauber ab.
 */
const KAPITEL_MINDESTZEICHEN = 120;

function verwertbareKapitel(chapters: Chapter[]): Chapter[] {
  if (chapters.length <= 1) return chapters;

  const substanz = (t: string) =>
    t
      .replace(/^#{1,6}\s+.*$/gm, "") // Überschriften
      .replace(/^[\s>*+-]+$/gm, "") // Trennlinien, leere Listenpunkte
      .replace(/\s+/g, " ")
      .trim().length;

  const behalten = chapters.filter((c) => substanz(c.text) >= KAPITEL_MINDESTZEICHEN);

  const verworfen = chapters.length - behalten.length;
  if (verworfen > 0) {
    console.log(
      `[wiki-gen] 🗑️ ${verworfen} Kapitel ohne Inhalt übersprungen (nur Überschrift o. ä.)`,
    );
  }
  // Wenn dabei alles wegfiele, lieber das Original behalten als gar nichts.
  return behalten.length > 0 ? behalten : chapters;
}

function packBySize(text: string, maxChars: number): string[] {
  const paras = text.split(/\n\n+/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (p.length > maxChars) {
      // Angesammeltes VOR das übergroße Stück hängen, statt es als eigenes
      // Teil abzulegen.
      //
      // Ein Transkript ist ein einziger, riesiger Absatz. Davor steht nur die
      // Zeile „## Transkript". Die wurde hier als eigenständiges Teil
      // ausgegeben und daraus entstand ein Kapitel „Transkript", das nichts
      // enthielt als seine eigene Überschrift — samt generiertem Artikel, der
      // wahrheitsgemäß meldete, das Dokument sei leer. Eine Überschrift gehört
      // zu dem Text, den sie ankündigt.
      const ganzes = cur ? `${cur}\n\n${p}` : p;
      cur = "";
      for (let i = 0; i < ganzes.length; i += maxChars) {
        out.push(ganzes.slice(i, i + maxChars));
      }
      continue;
    }
    if (cur && cur.length + p.length + 2 > maxChars) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + p;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Führt einen extrahierten Kandidaten dedupliziert (per Slug) in die Sammlung ein. */
function mergeCandidate(map: Map<string, ExtractedItem>, it: ExtractedItem) {
  if (!it?.slug || !it?.name) return;
  const ex = map.get(it.slug);
  if (!ex) {
    map.set(it.slug, {
      name: it.name,
      slug: it.slug,
      aliases: it.aliases || [],
      description: it.description || "",
      details: it.details || "",
    });
    return;
  }
  ex.aliases = [...new Set([...(ex.aliases || []), ...(it.aliases || [])])];
  // Längste Beschreibung/Details behalten (die Substanz kommt ohnehin aus den
  // zitierten Chunks; description/details sind nur Startpunkt/Fallback).
  if ((it.description || "").length > (ex.description || "").length) {
    ex.description = it.description;
  }
  if ((it.details || "").length > (ex.details || "").length) {
    ex.details = it.details;
  }
}

/** Vergleicht Titel tolerant (Groß-/Kleinschreibung, Whitespace, Satzzeichen-Rand). */
function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/^[\s"„“'*#-]+|[\s"„“'*.:-]+$/g, "")
      .trim();
  return !!a && !!b && norm(a) === norm(b);
}

/** Legt eine Wiki-Seite an oder aktualisiert sie, falls der Slug schon existiert. */
async function upsertPage(
  wikiId: string,
  slug: string,
  data: {
    title: string;
    content: string;
    summary: string;
    page_type: string;
    source_document_id?: string;
    parent_slug?: string | null;
    sort_order?: number;
  },
) {
  const existing = await wikiService.getPage(wikiId, slug);
  if (existing) {
    const page = await wikiService.updatePage(wikiId, slug, {
      title: data.title,
      content: data.content,
      summary: data.summary,
      page_type: data.page_type,
    });
    // Struktur getrennt schreiben: greift auch bei manuell editierten Seiten,
    // deren Inhalt der Lock in updatePage bewusst unangetastet lässt.
    if (data.parent_slug !== undefined || data.sort_order !== undefined) {
      return (
        (await wikiService.setPageHierarchy(wikiId, slug, {
          parent_slug: data.parent_slug ?? null,
          sort_order: data.sort_order ?? 0,
        })) || page
      );
    }
    return page;
  }
  return await wikiService.createPage({
    wiki_id: wikiId,
    slug,
    title: data.title,
    content: data.content,
    summary: data.summary,
    page_type: data.page_type,
    source_document_id: data.source_document_id,
    parent_slug: data.parent_slug ?? null,
    sort_order: data.sort_order ?? 0,
  });
}

function buildPagePrompt(opts: {
  item: ExtractedItem;
  /**
   * Einleitung der bestehenden Seite (bzw. bei noch nicht umgestellten Seiten
   * deren bisheriger Inhalt). Ausdrücklich NICHT die ganze Seite: die früheren
   * Belegabschnitte bleiben unangetastet und gehen nie wieder durch das Modell.
   */
  bisheriges: string;
  newInformation: string;
  language: string;
  /**
   * Fertig gerenderte Liste gültiger Linkziele. Vorgerendert und NICHT je Seite
   * gefiltert, damit sie innerhalb eines Imports Byte für Byte gleich bleibt –
   * sonst bricht das gemeinsame Prompt-Präfix und der Cache greift nicht mehr.
   * Dass eine Seite nicht auf sich selbst verlinkt, regelt der Prompt.
   */
  linkZiele: string;
  docKind?: "meeting_protocol" | "default";
  sessionLabel?: string;
  /** Leer, wenn das Quelldokument keine Zeitmarken trägt. */
  zeitmarkenRegel?: string;
}): string {
  const {
    item,
    bisheriges,
    newInformation,
    language,
    linkZiele,
    docKind = "default",
    sessionLabel = "",
    zeitmarkenRegel = "",
  } = opts;
  const pageType = item.slug.startsWith("entity/") ? "Entität" : "Konzept";

  // Reihenfolge der Ersetzungen ist beliebig – die Reihenfolge im Template
  // nicht: erst alles im Import Konstante, dann das Seitenspezifische.
  return pagePromptFor(docKind)
    .replace(/\{\{timestampRule\}\}/g, zeitmarkenRegel)
    .replace("{{availableSlugs}}", linkZiele || "Keine")
    .replace(/\{\{language\}\}/g, language)
    .replace(/\{\{sessionLabel\}\}/g, sessionLabel)
    .replace(/\{\{pageSlug\}\}/g, item.slug)
    .replace(/\{\{pageTitle\}\}/g, item.name)
    .replace(/\{\{pageType\}\}/g, pageType)
    .replace("{{pageAliases}}", (item.aliases || []).join(", "))
    .replace("{{bisheriges}}", bisheriges)
    .replace(
      "{{additionsSection}}",
      `<new_information>\n${newInformation}\n</new_information>`,
    );
}

// ---------------------------------------------------------------------------
// Chunk-Citation-Helfer
// ---------------------------------------------------------------------------

interface CitationNewSlug {
  type?: string;
  name: string;
  slug: string;
  aliases?: string[];
  description?: string;
  details?: string;
  source_chunks?: string[];
}

interface CitationResult {
  citations: Record<string, string[]>;
  new_slugs: CitationNewSlug[];
}

/** Lädt die Quell-Chunks eines Dokuments und vergibt stabile [cNNN]-Labels. */
async function loadSourceChunks(
  docId: string,
): Promise<{ id: string; content: string; label: string }[]> {
  const rows = await db
    .select({
      id: chunks.id,
      content: chunks.content,
      idx: chunks.chunk_index,
    })
    .from(chunks)
    .where(eq(chunks.document_id, docId))
    .orderBy(chunks.chunk_index);

  return rows.map((r, i) => ({
    id: r.id,
    content: r.content,
    label: `c${String(i + 1).padStart(3, "0")}`,
  }));
}

/** Packt Chunks in Batches (≤ maxChars), begrenzt auf maxBatches LLM-Aufrufe. */
function buildCitationBatches(
  chunkList: { id: string; content: string; label: string }[],
  maxChars: number,
  maxBatches = 4,
): { id: string; content: string; label: string }[][] {
  const batches: { id: string; content: string; label: string }[][] = [];
  let current: { id: string; content: string; label: string }[] = [];
  let size = 0;

  for (const c of chunkList) {
    if (current.length > 0 && size + c.content.length > maxChars) {
      batches.push(current);
      if (batches.length >= maxBatches) return batches;
      current = [];
      size = 0;
    }
    current.push(c);
    size += c.content.length;
  }
  if (current.length > 0 && batches.length < maxBatches) batches.push(current);
  return batches;
}

/** Führt neue Chunk-Referenzen dedupliziert in die bestehende Seite ein. */
async function mergeChunkRefs(pageId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const [row] = await db
    .select({ chunk_refs: wikiPages.chunk_refs })
    .from(wikiPages)
    .where(eq(wikiPages.id, pageId))
    .limit(1);
  const existing = (row?.chunk_refs as string[]) || [];
  const merged = [...new Set([...existing, ...ids])];
  await db
    .update(wikiPages)
    .set({ chunk_refs: merged })
    .where(eq(wikiPages.id, pageId));
}

// ---------------------------------------------------------------------------
// Seitenaufbau: fortgeschriebene Einleitung + Belegabschnitt je Quelle
//
// Eine Themenseite wird von vielen Dokumenten gespeist. Würde sie bei jedem
// Update komplett neu geschrieben, wüchse sowohl die Eingabe (die ganze Seite
// als Kontext) als auch die Ausgabe (die ganze Seite noch einmal) mit der Zahl
// der Quellen – bis die Ausgabe gegen max_tokens läuft und die Seite bei jedem
// weiteren Update Inhalt verliert.
//
// Stattdessen: das Modell sieht nur die Einleitung und schreibt nur die
// Einleitung plus GENAU EINEN Abschnitt für die neue Quelle. Alles davor wird
// hier wörtlich wieder angehängt. Ein Update kostet damit unabhängig davon,
// ob die Seite drei oder dreihundert Quellen hat.
// ---------------------------------------------------------------------------

/**
 * Trennt Einleitung von den Belegabschnitten. Zwei Schreibweisen, weil
 * Protokollseiten nach Sitzung gliedern und normale Seiten nach Quelle – für
 * den Code sind beide dasselbe.
 */
const BELEG_MARKER_RE = /^## Belege nach (?:Quelle|Sitzung)[ \t]*$/m;

/** Entfernt eine führende "# Titel"-Zeile. */
function ohneTitelzeile(text: string): string {
  return text.replace(/^#\s+.*(\r?\n|$)/, "").trim();
}

/**
 * Zerlegt den gespeicherten Seiteninhalt in den Teil, den das Modell
 * fortschreiben darf, und den Teil, der unangetastet bleibt.
 *
 * `marker` ist leer, solange die Seite noch nicht umgestellt ist – daran
 * erkennt der Aufrufer eine Altseite.
 */
function seiteZerlegen(content: string): {
  einleitung: string;
  bestand: string;
  marker: string;
} {
  const text = (content || "").trim();
  if (!text) return { einleitung: "", bestand: "", marker: "" };

  const m = text.match(BELEG_MARKER_RE);
  if (m && m.index !== undefined) {
    return {
      einleitung: text.slice(0, m.index).trim(),
      bestand: text.slice(m.index + m[0].length).trim(),
      marker: m[0].trim(),
    };
  }

  // Seite aus der Zeit vor der Umstellung: ihr Fließtext wird als erster
  // Belegabschnitt konserviert, damit beim Umstellen nichts verloren geht. Das
  // Modell sieht ihn einmalig als bisherigen Stand und zieht daraus die
  // Einleitung; ab dem nächsten Update wächst die Seite dann beschränkt.
  return {
    einleitung: text,
    bestand: `### Früherer Stand\n\n${ohneTitelzeile(text)}`,
    marker: "",
  };
}

/**
 * Entfernt den Abschnitt einer Quelle aus dem Bestand – nötig, wenn dasselbe
 * Dokument erneut importiert wird: sein Abschnitt wird ersetzt, nicht verdoppelt.
 */
function abschnittEntfernen(bestand: string, quelle: string): string {
  if (!bestand.trim()) return "";
  const ziel = quelle.trim();
  return bestand
    .split(/^(?=### )/m)
    .filter((teil) => {
      const kopf = teil.split("\n", 1)[0];
      // Text vor der ersten Überschrift bleibt immer stehen.
      if (!kopf.startsWith("### ")) return true;
      return kopf.slice(4).trim() !== ziel;
    })
    .join("")
    .trim();
}

/**
 * Setzt die Seite aus der Modellantwort (Einleitung + neuer Abschnitt) und dem
 * unveränderten Bestand zusammen.
 *
 * Gibt `null` zurück, wenn die Antwort den Marker nicht enthält – dann muss der
 * Aufrufer entscheiden, wie er den Bestand rettet.
 */
function seiteZusammenfügen(opts: {
  modellAusgabe: string;
  bestand: string;
  quelle: string;
}): string | null {
  const { modellAusgabe, bestand, quelle } = opts;
  const m = modellAusgabe.match(BELEG_MARKER_RE);
  if (!m || m.index === undefined) return null;

  const einleitung = modellAusgabe.slice(0, m.index).trim();
  let neuerAbschnitt = modellAusgabe.slice(m.index + m[0].length).trim();
  // Ohne Überschrift ließe sich der Abschnitt bei einem erneuten Import dieses
  // Dokuments nicht wiederfinden und würde sich verdoppeln.
  if (neuerAbschnitt && !neuerAbschnitt.startsWith("### ")) {
    neuerAbschnitt = `### ${quelle}\n\n${neuerAbschnitt}`;
  }

  return [einleitung, m[0].trim(), abschnittEntfernen(bestand, quelle), neuerAbschnitt]
    .filter((teil) => teil.length > 0)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Cross-Link-Helfer
// ---------------------------------------------------------------------------

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Injiziert [[slug|name]]-Links für das erste sichere Vorkommen jedes Kandidaten.
 * Sicher = nicht innerhalb eines bestehenden [[...]]-Links und an Wortgrenzen.
 * Ein Slug, der bereits (mit beliebigem Anzeigetext) verlinkt ist, wird
 * übersprungen – das verhindert verschachtelte/doppelte Links.
 */
function injectCrossLinks(
  content: string,
  refs: { slug: string; matchText: string }[],
): string {
  let out = content;

  for (const ref of refs) {
    if (!ref.matchText) continue;
    // Slug schon irgendwo verlinkt? (egal mit welchem Anzeigetext) -> überspringen
    if (out.includes(`[[${ref.slug}|`) || out.includes(`[[${ref.slug}]]`)) {
      continue;
    }

    // Geschützte Bereiche: bestehende [[...]]-Links
    const spans: Array<[number, number]> = [];
    const linkRe = /\[\[[^\]]*\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(out)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
    }

    // Erstes Vorkommen außerhalb geschützter Bereiche + an Wortgrenzen finden
    let from = 0;
    while (true) {
      const idx = out.indexOf(ref.matchText, from);
      if (idx < 0) break;
      const end = idx + ref.matchText.length;

      const inSpan = spans.some(([s, e]) => idx < e && end > s);
      const beforeChar = idx > 0 ? out[idx - 1] : "";
      const afterChar = end < out.length ? out[end] : "";
      const boundaryOk = !WORD_CHAR.test(beforeChar) && !WORD_CHAR.test(afterChar);

      if (!inSpan && boundaryOk) {
        out = out.slice(0, idx) + `[[${ref.slug}|${ref.matchText}]]` + out.slice(end);
        break;
      }
      from = idx + 1;
    }
  }

  return out;
}

/**
 * Entfernt [[slug|name]]- und [[slug]]-Links, deren Ziel-Seite nicht existiert,
 * und ersetzt sie durch den reinen Anzeigetext.
 */
export function stripDeadLinks(content: string, validSlugs: Set<string>): string {
  return content.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (match, slug: string, text?: string) => {
      if (validSlugs.has(slug.trim())) return match;
      return text || slug.split("/").pop() || slug;
    },
  );
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9äöüß\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 200);
}

// getActiveProvider / callLLM / callLLMJson sind nach service/llm.ts extrahiert
// (gemeinsam mit topic.ts genutzt) und werden oben importiert.

/**
 * Nur für Tests herausgereicht. Die drei Funktionen entscheiden, wie ein
 * Dokument in Kapitel zerfällt — dort entstand das Geisterkapitel „Transkript".
 * Sie sind rein und ohne Netzwerk, also einzeln prüfbar; sie gehören aber nicht
 * zur Schnittstelle dieses Moduls.
 */
export const __test__ = {
  splitIntoChapters,
  packBySize,
  verwertbareKapitel,
  seiteZerlegen,
  seiteZusammenfügen,
  abschnittEntfernen,
  buildPagePrompt,
};

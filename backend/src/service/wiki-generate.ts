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
  modelProviders,
  workspaces,
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
} from "./wiki-prompts.ts";
import * as wikiService from "./wiki.ts";
import * as topicService from "./topic.ts";
import { getActiveProvider, callLLM, callLLMJson } from "./llm.ts";
import { glossarForPrompt } from "../scripts/lib/rki-glossar.ts";

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

// ---------------------------------------------------------------------------
// Hauptfunktion
// ---------------------------------------------------------------------------

export async function generateWikiArticles(
  docId: string,
  workspaceId: string,
): Promise<{ summary: any; entities: number; concepts: number } | null> {
  const t0 = Date.now();
  console.log(`[wiki-gen] ========== START ==========`);
  console.log(`[wiki-gen] Dokument: ${docId}, Workspace: ${workspaceId}`);

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

  // 2. Aktiven Chat-Provider laden
  const provider = await getActiveProvider();
  if (!provider) {
    console.log(`[wiki-gen] ❌ Kein Chat-Provider konfiguriert`);
    return null;
  }

  // 3. Workspace-Konfiguration laden
  const [ws] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
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
  //    großen Workspace mit `summary-<uuid>`-Slugs. Die sind als Linkziel
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
        eq(wikiPages.workspace_id, workspaceId),
        inArray(wikiPages.page_type, ["entity", "concept"]),
      ),
    );
  const existingSlugs = existingTopicPages.map((p) => p.slug);

  // Dokument in Kapitel (~CHAPTER_CHARS) zerlegen, damit das GANZE Dokument
  // verarbeitet wird statt bei 32k Zeichen abgeschnitten. Kurze Dokumente ergeben
  // genau ein Kapitel = bisheriges Verhalten.
  const chapters = splitIntoChapters(doc.content, CHAPTER_CHARS);
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
        .replace(/\{\{language\}\}/g, language)
        .replace(/\{\{sessionLabel\}\}/g, doc.title)
        .replace("{{extractedSlugs}}", extractedSlugsText || "Keine")
        // Nur geprüfte Auflösungen. Kürzel, die nicht in dieser Liste stehen,
        // darf das Modell laut Prompt nicht auflösen – siehe rki-glossar.ts.
        .replace(
          "{{glossar}}",
          docKind === "meeting_protocol" ? glossarForPrompt() : "Keines",
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

    const page = await upsertPage(workspaceId, chapterSlug, {
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
    summaryPage = await upsertPage(workspaceId, baseSlug, {
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

  for (const item of toProcess) {
    const existing = await wikiService.getPage(workspaceId, item.slug);

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

    const pagePrompt = buildPagePrompt({
      item,
      existingContent: existing?.content || "(Neue Seite)",
      newInformation: newInfo,
      language,
      availableSlugs: existingSlugs,
      docKind,
      sessionLabel: doc.title,
    });
    const raw = await callLLM(provider, pagePrompt);
    if (!raw) continue;

    const sumMatch = raw.match(/SUMMARY:\s*(.+)/im);
    const body = raw.replace(/SUMMARY:\s*.+(\r?\n|$)/i, "").trim();
    const pageType = item.slug.startsWith("entity/") ? "entity" : "concept";

    if (existing) {
      await wikiService.updatePage(workspaceId, item.slug, {
        title: existing.title,
        content: body,
        summary: sumMatch?.[1]?.trim() || item.description,
        page_type: pageType,
      });
      await mergeChunkRefs(existing.id, citedIds);
    } else {
      const page = await wikiService.createPage({
        workspace_id: workspaceId,
        slug: item.slug,
        title: item.name,
        content: body,
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

    // Zählt erstellte UND aktualisierte Seiten (Slugs sind workspace-global,
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
        .where(eq(wikiPages.workspace_id, workspaceId))
    ).map((r) => r.slug),
  );

  // Für jede betroffene Seite: Links von anderen Seiten einfügen + tote Links entfernen
  for (const slug of affectedSlugs) {
    const page = await wikiService.getPage(workspaceId, slug);
    if (!page || !page.content) continue;

    const refs = toProcess
      .filter((c) => c.slug !== slug) // nicht auf sich selbst verlinken
      .map((c) => ({ slug: c.slug, matchText: c.name }));

    let newContent = injectCrossLinks(page.content, refs);
    newContent = stripDeadLinks(newContent, validSlugSet);

    if (newContent !== page.content) {
      await wikiService.updatePage(workspaceId, slug, { content: newContent });
    }
  }

  // =========================================================================
  // SCHRITT 6: Index-Intro aktualisieren
  // =========================================================================
  console.log(`[wiki-gen] 📋 Schritt 6: Aktualisiere Index-Intro...`);

  const indexPage = await wikiService.getPage(workspaceId, "index");
  if (!indexPage || !indexPage.content) {
    // Index neu erstellen
    const stats = await wikiService.getStats(workspaceId);
    const indexIntro = `# Wiki Index\n\nDieses Wiki enthält ${stats.total_pages} Seiten aus importierten Dokumenten.`;
    await wikiService.createPage({
      workspace_id: workspaceId,
      slug: "index",
      title: "Wiki Index",
      content: indexIntro,
      summary: indexIntro,
      page_type: "index",
    });
  }

  // Neu erzeugte Wiki-Chunks embedden, damit sie in der Vektorsuche (Chat-RAG)
  // auffindbar sind (nicht-blockierend – hält den Wiki-Gen-Response nicht auf).
  //
  // Mit WIKI_EMBED_AFTER_GENERATE=0 abschaltbar, und das ist bei Massenläufen
  // zwingend: embedWorkspaceChunks arbeitet workspace-weit, nicht
  // dokumentbezogen. Bei hunderten Aufrufen laufen entsprechend viele Sweeps
  // gleichzeitig über dieselben Zeilen (kein FOR UPDATE SKIP LOCKED), embedden
  // Chunks doppelt und belegen dabei den DB-Pool. Stattdessen einmal
  // embed-backfill.ts am Ende des Laufs.
  if (process.env.WIKI_EMBED_AFTER_GENERATE !== "0") {
    import("./embedding.ts")
      .then(({ embedWorkspaceChunks }) =>
        embedWorkspaceChunks(workspaceId).then((r) =>
          console.log(`[wiki-gen] 🧠 ${r.processed} Wiki-Chunks embedded`),
        ),
      )
      .catch((e) => console.warn(`[wiki-gen] Embedding-Trigger fehlgeschlagen:`, e));
  }

  // Auto-Themen-Klassifikation (Ebene 1): nur wenn der Workspace Themen hat und
  // das Dokument noch keine zugeordneten (überschreibt keine Handedits). Robust –
  // Fehler brechen die Wiki-Generierung nie ab.
  try {
    const classifyText =
      summaryPage?.summary || summaryPage?.content || doc.title;
    const topicIds = await topicService.classifyText(workspaceId, classifyText);
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
function packBySize(text: string, maxChars: number): string[] {
  const paras = text.split(/\n\n+/);
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (p.length > maxChars) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      for (let i = 0; i < p.length; i += maxChars) {
        out.push(p.slice(i, i + maxChars));
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
  workspaceId: string,
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
  const existing = await wikiService.getPage(workspaceId, slug);
  if (existing) {
    const page = await wikiService.updatePage(workspaceId, slug, {
      title: data.title,
      content: data.content,
      summary: data.summary,
      page_type: data.page_type,
    });
    // Struktur getrennt schreiben: greift auch bei manuell editierten Seiten,
    // deren Inhalt der Lock in updatePage bewusst unangetastet lässt.
    if (data.parent_slug !== undefined || data.sort_order !== undefined) {
      return (
        (await wikiService.setPageHierarchy(workspaceId, slug, {
          parent_slug: data.parent_slug ?? null,
          sort_order: data.sort_order ?? 0,
        })) || page
      );
    }
    return page;
  }
  return await wikiService.createPage({
    workspace_id: workspaceId,
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
  existingContent: string;
  newInformation: string;
  language: string;
  availableSlugs: string[];
  docKind?: "meeting_protocol" | "default";
  sessionLabel?: string;
}): string {
  const {
    item,
    existingContent,
    newInformation,
    language,
    availableSlugs,
    docKind = "default",
    sessionLabel = "",
  } = opts;
  const pageType = item.slug.startsWith("entity/") ? "Entität" : "Konzept";
  const validLinks = [...new Set(availableSlugs)]
    .filter((s) => s !== item.slug) // Seite verlinkt nicht auf sich selbst
    .map((s) => `[[${s}]]`)
    .join("\n");

  return pagePromptFor(docKind)
    .replace(/\{\{pageSlug\}\}/g, item.slug)
    .replace(/\{\{pageTitle\}\}/g, item.name)
    .replace(/\{\{pageType\}\}/g, pageType)
    .replace(/\{\{sessionLabel\}\}/g, sessionLabel)
    .replace("{{pageAliases}}", (item.aliases || []).join(", "))
    .replace("{{existingContent}}", existingContent)
    .replace("{{availableSlugs}}", validLinks || "Keine")
    .replace(/\{\{language\}\}/g, language)
    .replace(
      "{{additionsSection}}",
      `<new_information>\n${newInformation}\n</new_information>`,
    )
    .replace("{{retractionsSection}}", "")
    .replace("{{retractionInstructions}}", "")
    .replace(
      "{{additionInstructions}}",
      `2. KOMPILIERE die Fakten aus <new_information> zu einem vollständigen, gut gegliederten Artikel über ${item.name}. Verarbeite JEDEN [cNNN]-Chunk und behalte die [cNNN]-Zitate bei.\n3. Erhalte bestehende, weiterhin gültige Informationen über ${item.name}.`,
    )
    .replace("{{emptyPageInstruction}}", "");
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

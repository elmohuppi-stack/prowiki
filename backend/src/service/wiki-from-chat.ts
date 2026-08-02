// Chat → Wiki-Artikel-Verbund.
//
// Nimmt den Verlauf einer Chat-Session als Briefing und erzeugt daraus einen
// zusammenhängenden Verbund verlinkter Wiki-Artikel in der üblichen Taxonomie:
//   - 1 SUMMARY  (langer Übersichtsartikel, Hauptseite)
//   - n CONCEPTS (thematische Vertiefungen)
//   - m ENTITIES (Personen, Orte, Organisationen, Begriffe – kurz/definitorisch)
// Die Artikel werden als Entwürfe (status="draft") gespeichert, im Review
// geprüft/verfeinert und erst dann veröffentlicht.
//
// Zusätzlich wird das Gesprächstranskript als Quell-Dokument (type="chat")
// gespeichert; alle erzeugten Seiten verweisen per source_document_id darauf.
//
// Quelle: primär das Wissen des LLM, geformt durch das Gespräch; optional mit
// RAG-Kontext aus den Workspace-Dokumenten angereichert.

import { db } from "../db/index.ts";
import { chatMessages, chatSessions, wikiPages } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { getActiveProvider, callLLM, callLLMJson } from "./llm.ts";
import { hybridSearch } from "./search.ts";
import { logActivity, updateLog } from "./activity-log.ts";
import * as documentService from "./document.ts";
import * as wikiService from "./wiki.ts";

const MAX_TRANSCRIPT_CHARS = 14000;
const MAX_EXISTING_SLUGS = 200;
const DEFAULT_MAX_CONCEPTS = 5;
const DEFAULT_MAX_ENTITIES = 12;

export interface ClusterSpec {
  instructions?: string;
  audience?: string; // z.B. "Schüler der Mittelstufe"
  style?: string; // z.B. "einfache Sprache, anschaulich"
  length?: string; // z.B. "mittel"
  max_subpages?: number; // Deckel für Concepts
  max_entities?: number; // Deckel für Entities
  use_rag?: boolean;
}

type PageKind = "summary" | "concept" | "entity";

interface PlannedPage {
  title: string;
  angle: string;
  kind: PageKind;
}

interface ClusterPlanJson {
  summary: { title: string; angle: string };
  concepts?: { title: string; angle: string }[];
  entities?: { title: string; angle: string }[];
  audience?: string;
  style?: string;
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

/** SUMMARY-Zeile + # Titel + Body aus der LLM-Antwort herausparsen. */
function parseArticle(
  raw: string,
  fallbackTitle: string,
): { title: string; summary: string; content: string } {
  let text = raw.trim();
  let summary = "";

  const summaryMatch = text.match(/^\s*SUMMARY:\s*(.+)$/im);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
    text = text.replace(summaryMatch[0], "").trim();
  }

  let title = fallbackTitle;
  const h1Match = text.match(/^\s*#\s+(.+)$/m);
  if (h1Match) {
    title = h1Match[1].trim();
    text = text.replace(h1Match[0], "").trim();
  }

  return { title, summary, content: text };
}

/** Session-Verlauf als lesbares Transkript (gedeckelt). */
async function loadTranscript(sessionId: string): Promise<string> {
  const rows = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.session_id, sessionId))
    .orderBy(chatMessages.created_at);

  const lines = rows
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "NUTZER" : "ASSISTENT"}: ${m.content}`);

  let transcript = lines.join("\n\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript =
      "[…Anfang gekürzt…]\n\n" +
      transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS);
  }
  return transcript;
}

async function loadSessionTitle(sessionId: string): Promise<string> {
  const [s] = await db
    .select({ title: chatSessions.title })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  return s?.title || "Chat-Gespräch";
}

/** Existierende (veröffentlichte) Seiten als Link-Ziele. */
async function loadExistingPages(
  workspaceId: string,
): Promise<{ slug: string; title: string }[]> {
  const rows = await db
    .select({ slug: wikiPages.slug, title: wikiPages.title })
    .from(wikiPages)
    .where(eq(wikiPages.workspace_id, workspaceId))
    .limit(MAX_EXISTING_SLUGS);
  return rows;
}

function buildPlanPrompt(
  transcript: string,
  spec: ClusterSpec,
  existing: { slug: string; title: string }[],
  ragContext: string,
): string {
  const maxConcepts = spec.max_subpages ?? DEFAULT_MAX_CONCEPTS;
  const maxEntities = spec.max_entities ?? DEFAULT_MAX_ENTITIES;
  const existingList =
    existing.length > 0
      ? existing.map((p) => `- ${p.title} (slug: ${p.slug})`).join("\n")
      : "(keine)";

  return `Du bist ein Wiki-Redakteur. Aus dem folgenden GESPRÄCH sollst du einen zusammenhängenden Verbund von Wiki-Artikeln planen.

ZIELGRUPPE: ${spec.audience || "Interessierter Laie (kein Experte)"}
STIL: ${spec.style || "anschauliche, verständliche Sprache in Prosa, keine Stichpunkte"}
${spec.instructions ? `ZUSÄTZLICHE ANWEISUNGEN: ${spec.instructions}\n` : ""}
Plane:
1. GENAU EINEN Übersichtsartikel (summary) zum übergreifenden Thema – der rote Faden.
2. Bis zu ${maxConcepts} CONCEPT-Artikel zu wichtigen Teilaspekten/Themen (Ursachen, Folgen, Ereignisse, Prozesse).
3. Bis zu ${maxEntities} ENTITY-Artikel zu konkreten Personen, Orten, Organisationen oder Schlüsselbegriffen, die im Gespräch vorkommen (z.B. handelnde Personen, Institutionen, Fachbegriffe).

Concepts erklären Zusammenhänge; Entities sind kurze, definitorische Einträge zu einer konkreten Sache/Person.

BEREITS EXISTIERENDE WIKI-SEITEN (nutze diese als Themen, statt sie zu duplizieren):
${existingList}
${ragContext ? `\nKONTEXT AUS DER WISSENSDATENBANK (nur als Hintergrund):\n${ragContext}\n` : ""}
GESPRÄCH:
${transcript}

Antworte AUSSCHLIESSLICH mit JSON in exakt diesem Format:
{
  "summary": { "title": "Titel des Übersichtsartikels", "angle": "worum es geht, 1 Satz" },
  "concepts": [ { "title": "Titel", "angle": "Fokus, 1 Satz" } ],
  "entities": [ { "title": "Name der Person/des Begriffs", "angle": "was/wer das ist, 1 Satz" } ],
  "audience": "abgeleitete Zielgruppe",
  "style": "abgeleiteter Stil"
}`;
}

function buildArticlePrompt(opts: {
  page: PlannedPage;
  spec: ClusterSpec;
  audience: string;
  style: string;
  transcript: string;
  ragContext: string;
  linkMenu: { slug: string; title: string }[];
}): string {
  const { page, spec, audience, style, transcript, ragContext, linkMenu } =
    opts;
  const linkList =
    linkMenu.length > 0
      ? linkMenu.map((p) => `- ${p.title}: [[${p.slug}|${p.title}]]`).join("\n")
      : "(keine)";

  // Art-spezifische Vorgaben.
  let kindGuide = "";
  if (page.kind === "summary") {
    kindGuide = `Dies ist der ÜBERSICHTSARTIKEL. Schreibe ausführlich und gut strukturiert mit ## Zwischenüberschriften, die den roten Faden abbilden. Er soll das Thema als Ganzes erklären und auf die vertiefenden Artikel (Concepts) und die beteiligten Personen/Begriffe (Entities) per [[slug]] verweisen.`;
  } else if (page.kind === "concept") {
    kindGuide = `Dies ist ein CONCEPT-Artikel (Vertiefung eines Teilaspekts). Erkläre den Zusammenhang verständlich, mittlere Länge, mit ## Zwischenüberschriften wo sinnvoll. Verlinke verwandte Personen/Begriffe und den Übersichtsartikel per [[slug]].`;
  } else {
    kindGuide = `Dies ist ein ENTITY-Artikel zu einer konkreten Person/einem Ort/einer Organisation/einem Begriff. Halte ihn KURZ und definitorisch (ca. 150-300 Wörter): Wer/was ist das, welche Rolle spielt es im Thema. Verlinke verwandte Artikel per [[slug]].`;
  }

  return `Du bist ein Wiki-Autor. Schreibe EINEN Wiki-Artikel auf Deutsch.

THEMA DIESES ARTIKELS: ${page.title}
FOKUS: ${page.angle}
ART: ${page.kind.toUpperCase()}
${kindGuide}

ZIELGRUPPE: ${audience}
STIL: ${style}. Erkläre Zusammenhänge so, dass die Zielgruppe sie versteht. Keine erfundenen Fakten.
${spec.instructions ? `ZUSÄTZLICHE ANWEISUNGEN: ${spec.instructions}\n` : ""}
INTERNE LINKS: Wenn im Text eines der folgenden Themen vorkommt, verlinke es im Format
[[slug|Anzeigetext]] – der Anzeigetext ist der natürliche Wortlaut im Satz (z.B. [[karl-i-von-england|König Karl I.]]).
Verwende NUR diese Slugs (nicht erfinden) und schreibe IMMER einen lesbaren Anzeigetext, nie den rohen Slug:
${linkList}

Nutze das folgende GESPRÄCH als inhaltliche Vorgabe (Umfang, Schwerpunkte, Stil):
${transcript}
${ragContext ? `\nZUSÄTZLICHER KONTEXT AUS DER WISSENSDATENBANK:\n${ragContext}\n` : ""}
FORMAT (genau einhalten):
SUMMARY: {ein Satz, 15-40 Wörter}
# ${page.title}
{Artikeltext als Markdown mit [[slug]]-Links}`;
}

/**
 * Erzeugt den Artikel-Verbund. Wird asynchron aufgerufen; clusterId wird vom
 * Router vergeben, damit dieser sofort antworten und das Frontend pollen kann.
 */
export async function generateClusterFromChat(opts: {
  workspaceId: string;
  sessionId: string;
  clusterId: string;
  spec: ClusterSpec;
  userId?: number;
}): Promise<void> {
  const { workspaceId, sessionId, clusterId, spec, userId } = opts;
  const t0 = Date.now();
  const logId = await logActivity({
    action: "chat_wiki",
    status: "started",
    message: "Erzeuge Wiki-Verbund aus Gespräch …",
    details: { cluster_id: clusterId, session_id: sessionId },
    workspace_id: workspaceId,
    user_id: userId,
  });

  try {
    const provider = await getActiveProvider();
    if (!provider) {
      await updateLog(logId, {
        status: "failed",
        message: "Kein Chat-Provider konfiguriert.",
      });
      return;
    }

    const transcript = await loadTranscript(sessionId);
    if (!transcript.trim()) {
      await updateLog(logId, {
        status: "failed",
        message: "Leeres Gespräch – nichts zu generieren.",
      });
      return;
    }

    // Optionaler RAG-Kontext aus Workspace-Dokumenten.
    let ragContext = "";
    if (spec.use_rag) {
      try {
        const query = transcript.slice(0, 500);
        const results = await hybridSearch(workspaceId, query, 6);
        ragContext = results
          .map((r: any) => `[${r.document_title}]: ${r.content}`)
          .join("\n\n")
          .slice(0, 6000);
      } catch (e: any) {
        console.warn(`[chat-wiki] RAG-Suche fehlgeschlagen: ${e.message}`);
      }
    }

    const existing = await loadExistingPages(workspaceId);
    const existingSlugSet = new Set(existing.map((p) => p.slug));

    // 1. Plan
    const plan = await callLLMJson<ClusterPlanJson>(
      provider,
      buildPlanPrompt(transcript, spec, existing, ragContext),
    );
    if (!plan || !plan.summary?.title) {
      await updateLog(logId, {
        status: "failed",
        message: "Konnte keinen Artikel-Plan erzeugen.",
      });
      return;
    }

    const maxConcepts = spec.max_subpages ?? DEFAULT_MAX_CONCEPTS;
    const maxEntities = spec.max_entities ?? DEFAULT_MAX_ENTITIES;
    const audience =
      spec.audience || plan.audience || "Interessierter Laie (kein Experte)";
    const style =
      spec.style ||
      plan.style ||
      "anschauliche, verständliche Sprache in Prosa, keine Stichpunkte";

    // Geplante Seiten in fester Reihenfolge: Summary → Concepts → Entities.
    const planned: PlannedPage[] = [
      { ...plan.summary, kind: "summary" },
      ...(plan.concepts || [])
        .slice(0, maxConcepts)
        .map((c) => ({ ...c, kind: "concept" as PageKind })),
      ...(plan.entities || [])
        .slice(0, maxEntities)
        .map((e) => ({ ...e, kind: "entity" as PageKind })),
    ];

    // 2. Quell-Dokument (Transkript) anlegen – Herkunft des Verbunds.
    //    Nur bei Erfolg als source_document_id setzen (FK auf documents.id).
    let sourceDocId: string | undefined;
    try {
      const docId = crypto.randomUUID();
      const sessionTitle = await loadSessionTitle(sessionId);
      await documentService.createDocument({
        id: docId,
        workspace_id: workspaceId,
        title: `Chat: ${sessionTitle}`,
        type: "chat",
        source: `chat:${sessionId}`,
        content: transcript,
        source_metadata: { chat_session_id: sessionId, cluster_id: clusterId },
        created_by: userId ?? 0,
      });
      await documentService.updateDocumentStatus(docId, "completed");
      sourceDocId = docId;
    } catch (e: any) {
      console.warn(
        `[chat-wiki] Quell-Dokument anlegen fehlgeschlagen: ${e.message}`,
      );
    }

    // 3. Slugs vergeben. Kollidiert ein Titel mit einer existierenden Seite,
    //    wird darauf verlinkt statt neu erzeugt.
    const usedSlugs = new Set<string>();
    const toCreate: { page: PlannedPage; slug: string }[] = [];
    const linkMenu: { slug: string; title: string }[] = [];

    const uniqueSlug = (base: string): string => {
      let s = base || "artikel";
      let i = 2;
      while (usedSlugs.has(s) || existingSlugSet.has(s)) {
        s = `${base}-${i++}`;
      }
      usedSlugs.add(s);
      return s;
    };

    for (const p of planned) {
      const base = slugify(p.title);
      if (p.kind !== "summary" && existingSlugSet.has(base)) {
        // Existierende Seite: nur als Link-Ziel aufnehmen, nicht neu erzeugen.
        const existingPage = existing.find((x) => x.slug === base);
        linkMenu.push({ slug: base, title: existingPage?.title || p.title });
        continue;
      }
      const slug = uniqueSlug(base);
      toCreate.push({ page: p, slug });
      linkMenu.push({ slug, title: p.title });
    }

    // 4. Inhalte generieren + als Draft anlegen.
    let created = 0;
    for (const item of toCreate) {
      const raw = await callLLM(
        provider,
        buildArticlePrompt({
          page: item.page,
          spec,
          audience,
          style,
          transcript,
          ragContext,
          linkMenu: linkMenu.filter((l) => l.slug !== item.slug),
        }),
      );
      if (!raw) {
        console.warn(`[chat-wiki] Leere Antwort für "${item.page.title}"`);
        continue;
      }
      const parsed = parseArticle(raw, item.page.title);

      await wikiService.createPage({
        workspace_id: workspaceId,
        slug: item.slug,
        title: parsed.title,
        summary: parsed.summary,
        content: parsed.content,
        page_type: item.page.kind,
        status: "draft",
        source_document_id: sourceDocId,
        created_by: userId,
        page_metadata: {
          origin: "chat",
          chat_session_id: sessionId,
          cluster_id: clusterId,
          is_main: item.page.kind === "summary",
          ai_generated: true,
          audience,
          style,
        },
      });
      created++;
    }

    // 5. Links auflösen – jetzt existieren alle Cluster-Seiten, intra-Cluster
    //    [[links]] greifen. updateIncomingLinks pflegt in_links der Ziele.
    for (const item of toCreate) {
      const page = await wikiService.getPage(workspaceId, item.slug);
      if (!page?.content) continue;
      const { out_links } = await wikiService.resolveLinks(
        workspaceId,
        page.content,
      );
      if (out_links.length > 0) {
        await wikiService.updatePage(workspaceId, item.slug, { out_links });
        await wikiService.updateIncomingLinks(workspaceId, item.slug, out_links);
      }
    }

    await updateLog(logId, {
      status: "completed",
      message: `Wiki-Verbund erzeugt: ${created} Artikel (Entwurf).`,
      details: {
        cluster_id: clusterId,
        session_id: sessionId,
        document_id: sourceDocId,
        pages: created,
      },
      duration_ms: Date.now() - t0,
    });
  } catch (e: any) {
    console.error(`[chat-wiki] Fehler:`, e);
    await updateLog(logId, {
      status: "failed",
      message: `Fehler: ${e.message}`,
      duration_ms: Date.now() - t0,
    });
  }
}

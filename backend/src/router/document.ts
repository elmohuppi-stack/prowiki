import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { sessionMiddleware } from "../middleware/auth.ts";
import {
  requireWikiCapability,
  requireDocumentCapability,
} from "../middleware/access.ts";
import * as documentService from "../service/document.ts";
import * as documentMove from "../service/document-move.ts";
import {
  extractVideoId,
  fetchYouTubeInfo,
  buildDocumentText,
  buildDocumentMetadata,
} from "../service/youtube.ts";
import type { DocumentSort } from "../service/document.ts";
import { logActivity, updateLog } from "../service/activity-log.ts";
import { QUEUE, enqueue } from "../jobs/queue.ts";
import { spoolSchreiben } from "../jobs/spool.ts";
import { LIMITS } from "../middleware/rate-limit.ts";
import { AUDIT, protokolliere, herkunft } from "../service/audit.ts";
import * as topicService from "../service/topic.ts";
import { wählbareProvider } from "../service/provider.ts";

const documentRouter = new Hono();
documentRouter.use("*", sessionMiddleware);

const urlSchema = z.object({
  wiki_id: z.string().uuid(),
  url: z.string().url(),
  title: z.string().optional(),
  /**
   * Womit die Wiki-Artikel erzeugt werden sollen. Freiwillig — ohne Angabe
   * gilt die übliche Auswahl. Geprüft wird die ID nicht hier, sondern erst
   * beim Auflösen (service/provider.ts): dort steht auch die Prüfung, dass
   * sie zur Organisation des Wiki gehört, und dort allein gehört sie hin.
   */
  provider_id: z.string().uuid().optional(),
});

/**
 * Die Modelle, unter denen beim Import gewählt werden kann.
 *
 * Hängt an `wiki.write` und nicht an `settings.manage`: importieren darf auch,
 * wer die Schlüssel nicht verwalten kann — und muss dann trotzdem sehen, womit
 * erzeugt wird. Herausgegeben werden nur Name und Modellname, keine Schlüssel
 * und keine Vorschau darauf.
 */
documentRouter.get("/:wikiId/providers", async (c) => {
  const wikiId = c.req.param("wikiId");
  await requireWikiCapability(c.get("principal"), wikiId, "wiki.write");
  return c.json({ providers: await wählbareProvider(wikiId, "chat") });
});

// Distinct-Kanäle eines Wiki (für das Kanal-Filter-Dropdown)
documentRouter.get("/:wikiId/channels", async (c) => {
  const wikiId = c.req.param("wikiId");
  await requireWikiCapability(c.get("principal"), wikiId, "wiki.read");
  const channels = await documentService.listChannels(wikiId);
  return c.json({ channels });
});

// Dokumente eines Wiki auflisten (mit Filter/Sortierung, Ebene 2)
documentRouter.get("/:wikiId", async (c) => {
  const wikiId = c.req.param("wikiId");
  await requireWikiCapability(c.get("principal"), wikiId, "wiki.read");
  const q = c.req.query();
  const parseDate = (v?: string) => {
    if (!v) return undefined;
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  };
  const allowedSorts: DocumentSort[] = [
    "created_desc",
    "created_asc",
    "published_desc",
    "published_asc",
    "title_asc",
    "title_desc",
  ];
  const list = await documentService.listDocuments(wikiId, {
    type: q.type || undefined,
    channel: q.channel || undefined,
    query: q.q || undefined,
    dateFrom: parseDate(q.from),
    dateTo: parseDate(q.to),
    topicIds: q.topics ? q.topics.split(",").filter(Boolean) : undefined,
    sort: allowedSorts.includes(q.sort as DocumentSort)
      ? (q.sort as DocumentSort)
      : undefined,
  });
  return c.json({ documents: list });
});

// Themen eines Dokuments abrufen (topic_ids)
documentRouter.get("/:id/topics", async (c) => {
  await requireDocumentCapability(c.get("principal"), c.req.param("id"), "wiki.read");
  const ids = await topicService.getDocumentTopicIds(c.req.param("id"));
  return c.json({ topic_ids: ids });
});

// Themen eines Dokuments setzen (manuelle Korrektur, ersetzt alle Zuordnungen)
const docTopicsSchema = z.object({ topic_ids: z.array(z.string()) });
documentRouter.patch(
  "/:id/topics",
  zValidator("json", docTopicsSchema),
  async (c) => {
    await requireDocumentCapability(c.get("principal"), c.req.param("id"), "wiki.write");
    const { topic_ids } = c.req.valid("json");
    await topicService.setDocumentTopics(c.req.param("id"), topic_ids);
    return c.json({ topic_ids });
  },
);

// Einzelnes Dokument abrufen
documentRouter.get("/detail/:id", async (c) => {
  const id = c.req.param("id");
  await requireDocumentCapability(c.get("principal"), id, "wiki.read");
  const doc = await documentService.getDocument(id);
  if (!doc) return c.json({ error: "Document not found" }, 404);
  return c.json({ document: doc });
});

// Datei-Upload
documentRouter.post("/upload/:wikiId", LIMITS.ingest, async (c) => {
  const wikiId = c.req.param("wikiId");
  const principal = c.get("principal");
  await requireWikiCapability(principal, wikiId, "wiki.write");

  const body = await c.req.parseBody();
  const file = body["file"] as File | undefined;
  // Multipart kennt keine Typen: alles kommt als Zeichenkette an, ein nicht
  // gesetztes Feld als undefined oder leer.
  const providerId =
    typeof body["provider_id"] === "string" && body["provider_id"].trim()
      ? (body["provider_id"] as string)
      : undefined;

  if (!file) {
    return c.json({ error: "No file provided" }, 400);
  }

  const fileName = file.name || "unnamed";
  const fileType = fileName.split(".").pop()?.toLowerCase() || "txt";
  const fileSize = file.size;

  // Erlaubte Typen
  const allowedTypes = ["pdf", "docx", "md", "txt", "html", "csv"];
  if (!allowedTypes.includes(fileType)) {
    return c.json(
      {
        error: `File type .${fileType} not supported. Allowed: ${allowedTypes.join(", ")}`,
      },
      400,
    );
  }

  // Dokument in DB anlegen
  const doc = await documentService.createDocument({
    id: crypto.randomUUID(),
    wiki_id: wikiId,
    title: fileName,
    type: fileType,
    source: fileName,
    file_size: fileSize,
    created_by: principal.userId!,
  });

  // Datei-Bytes im Request-Kontext lesen — `file` gilt nur hier — und in den
  // Spool legen, damit der Worker sie nach einem Neustart noch findet
  // (jobs/spool.ts erklärt, warum nicht in die Job-Nutzlast).
  const buffer = await file.arrayBuffer();
  const spoolPath = await spoolSchreiben(doc.id, fileType, buffer);
  await enqueue(QUEUE.fileImport, {
    docId: doc.id,
    wikiId,
    userId: principal.userId!,
    fileName,
    fileType,
    spoolPath,
    providerId,
  });

  return c.json({ document: doc }, 201);
});

// URL importieren
documentRouter.post(
  "/import-url",
  LIMITS.ingest,
  zValidator("json", urlSchema),
  async (c) => {
    const principal = c.get("principal");
    const { wiki_id, url, title, provider_id } = c.req.valid("json");
    await requireWikiCapability(principal, wiki_id, "wiki.write");

    const doc = await documentService.createDocument({
      id: crypto.randomUUID(),
      wiki_id,
      title: title || url,
      type: "url",
      source: url,
      source_url: url,
      created_by: principal.userId!,
    });

    // Laden, Chunking und Generierung übernimmt der Worker.
    await enqueue(QUEUE.urlImport, {
      docId: doc.id,
      wikiId: wiki_id,
      userId: principal.userId!,
      url,
      providerId: provider_id,
    });

    return c.json({ document: doc }, 201);
  },
);

// YouTube-Video importieren
const youTubeSchema = z.object({
  wiki_id: z.string().uuid(),
  url: z.string(),
  provider_id: z.string().uuid().optional(),
});

documentRouter.post(
  "/import-youtube",
  LIMITS.ingest,
  zValidator("json", youTubeSchema),
  async (c) => {
    const principal = c.get("principal");
    const { wiki_id, url, provider_id } = c.req.valid("json");
    await requireWikiCapability(principal, wiki_id, "wiki.write");

    const t0 = Date.now();
    console.log(`[doc] ========== YouTube-Import gestartet ==========`);
    console.log(`[doc] URL: ${url}`);
    console.log(`[doc] Wiki: ${wiki_id}`);
    console.log(`[doc] User: ${principal.userId!} (${principal.email})`);

    const videoId = extractVideoId(url);
    if (!videoId) {
      console.log(`[doc] ❌ Ungültige YouTube-URL: ${url}`);
      return c.json({ error: "Invalid YouTube URL" }, 400);
    }
    console.log(`[doc] Video-ID: ${videoId}`);

    const logId = await logActivity({
      action: "youtube_import",
      status: "started",
      message: `Importiere YouTube-Video: ${url}`,
      details: { url, videoId },
      wiki_id,
      user_id: principal.userId!,
    });

    // Die Dokument-ID wird **vor** dem Abruf gezogen, obwohl das Dokument erst
    // danach entsteht: der Transkriptabruf ist der teuerste Einzelposten des
    // Imports, und er soll in der Kostenübersicht an derselben Zeile hängen wie
    // die Generierung. Ohne das stünde er unter der Video-ID und ließe sich
    // keinem Dokument zuordnen.
    const docId = crypto.randomUUID();

    console.log(`[doc] Rufe YouTube-Info ab (fetchYouTubeInfo)...`);
    // wiki_id mitgeben: der Abruf kostet Apify-Guthaben je Video und wird
    // gezählt (service/usage.ts).
    const info = await fetchYouTubeInfo(videoId, wiki_id, docId);

    if (!info) {
      console.log(`[doc] ❌ Konnte keine Video-Informationen abrufen`);
      await updateLog(logId, {
        status: "failed",
        message: "Keine Video-Informationen abrufbar",
        duration_ms: Date.now() - t0,
      });
      return c.json({ error: "Could not fetch video information" }, 400);
    }

    console.log(`[doc] ✅ Video-Titel: "${info.title}"`);
    console.log(`[doc] ✅ Kanal: ${info.channelName}`);
    console.log(`[doc] ✅ Dauer: ${info.duration}s`);
    console.log(
      `[doc] ✅ Transkript: ${info.transcript.length} Zeichen (${info.transcriptLanguage})`,
    );

    const { content, timeline } = buildDocumentText(info);
    console.log(`[doc] Dokument-Content: ${content.length} Zeichen`);
    console.log(
      `[doc] Zeitmarken: ${info.segments.length} Segmente → ${timeline.length} Blöcke im Text`,
    );

    const meta = buildDocumentMetadata(info);
    const doc = await documentService.createDocument({
      id: docId,
      wiki_id,
      title: info.title,
      type: "youtube",
      source: url,
      source_url: `https://www.youtube.com/watch?v=${videoId}`,
      content,
      channel: meta.channel,
      published_at: meta.published_at,
      duration: meta.duration,
      source_metadata: meta.source_metadata,
      created_by: principal.userId!,
    });
    console.log(`[doc] ✅ Dokument erstellt: ${doc.id}`);

    // Segmente speichern, bevor gechunkt wird: die Zeitmarken sind das teuer
    // beschaffte Gut (ein erneuter Abruf kostet Apify-Guthaben), das Chunking
    // ist daraus jederzeit wiederholbar.
    if (info.segments.length > 0) {
      try {
        await documentService.replaceTranscriptSegments(
          doc.id,
          wiki_id,
          info.segments,
        );
        console.log(`[doc] ✅ ${info.segments.length} Segmente gespeichert`);
      } catch (e: any) {
        console.warn(`[doc] ⚠️ Segmente nicht gespeichert:`, e.message);
      }
    }

    await updateLog(logId, {
      status: "completed",
      message: `„${info.title}” importiert (${info.transcript.length} Zeichen${
        info.segments.length > 0
          ? `, ${info.segments.length} Zeitmarken`
          : ", ohne Zeitmarken"
      })`,
      details: {
        title: info.title,
        channel: info.channelName,
        transcript_len: info.transcript.length,
        segments: info.segments.length,
        doc_id: doc.id,
      },
      duration_ms: Date.now() - t0,
    });

    // Chunking und Generierung als Jobs. Der Text steht bereits in
    // `documents.content` (createDocument oben), der Chunk-Job liest ihn von
    // dort — mitgegeben wird nur die Zeitleiste, die sich aus dem Text nicht
    // verlustfrei zurückrechnen lässt (jobs/queue.ts).
    console.log(`[doc] Stelle Chunking für ${doc.id} ein...`);
    await enqueue(QUEUE.chunk, { docId: doc.id, wikiId: wiki_id, timeline });
    await enqueue(QUEUE.wikiGenerate, {
      docId: doc.id,
      wikiId: wiki_id,
      userId: principal.userId!,
      providerId: provider_id,
    });

    console.log(
      `[doc] ========== YouTube-Import abgeschlossen (${Date.now() - t0}ms) ==========`,
    );
    return c.json({ document: doc }, 201);
  },
);

// YouTube-Metadaten eines einzelnen Dokuments neu abrufen (Ebene 2).
// Für Altbestand, bei dem published_at/duration/tags nie gespeichert wurden,
// oder um veraltete Metadaten zu aktualisieren. Content/Transkript bleibt.
documentRouter.post("/:id/refresh-metadata", LIMITS.ingest, async (c) => {
  const id = c.req.param("id");
  await requireDocumentCapability(c.get("principal"), id, "wiki.write");
  const doc = await documentService.getDocument(id);
  if (!doc) return c.json({ error: "Document not found" }, 404);
  if (doc.type !== "youtube") {
    return c.json(
      { error: "Metadata refresh is only supported for YouTube documents" },
      400,
    );
  }

  const videoId = extractVideoId(doc.source_url || doc.source);
  if (!videoId) {
    return c.json({ error: "Could not extract video ID from document" }, 400);
  }

  const info = await fetchYouTubeInfo(videoId, doc.wiki_id, doc.id);
  if (!info) {
    return c.json({ error: "Could not fetch video information" }, 502);
  }

  const meta = buildDocumentMetadata(info);
  const updated = await documentService.updateDocumentMetadata(id, {
    channel: meta.channel,
    published_at: meta.published_at,
    duration: meta.duration,
    source_metadata: meta.source_metadata,
  });
  return c.json({ document: updated });
});

/**
 * Transkript eines einzelnen Videos neu holen — der Weg, ein vor der
 * Zeitmarken-Umstellung importiertes Video nachzurüsten.
 *
 * Bewusst je Video von Hand auszulösen und nicht als Sammellauf: jeder Aufruf
 * kostet Apify-Guthaben. Aus demselben Grund bleibt das Dokument unverändert,
 * wenn der Abruf keine Zeitmarken liefert — ein Rückfall auf Fließtext würde
 * bezahlte Daten gegen schlechtere eintauschen.
 *
 * Die Wiki-Artikel werden *nicht* neu erzeugt; das ist ein eigener, teurer
 * Schritt und bleibt eine bewusste Entscheidung des Nutzers.
 */
// Der einzige Aufruf, der unmittelbar Apify-Guthaben kostet – engstes Limit.
documentRouter.post("/:id/refresh-transcript", LIMITS.transcript, async (c) => {
  const id = c.req.param("id");
  await requireDocumentCapability(c.get("principal"), id, "wiki.write");
  const doc = await documentService.getDocument(id);
  if (!doc) return c.json({ error: "Document not found" }, 404);
  if (doc.type !== "youtube") {
    return c.json(
      { error: "Ein Transkript gibt es nur für YouTube-Dokumente" },
      400,
    );
  }

  const videoId = extractVideoId(doc.source_url || doc.source);
  if (!videoId) {
    return c.json({ error: "Keine Video-ID im Dokument gefunden" }, 400);
  }

  const t0 = Date.now();
  const logId = await logActivity({
    action: "transcript_refresh",
    status: "started",
    message: `Hole Transkript neu: „${doc.title}”`,
    details: { videoId },
    wiki_id: doc.wiki_id,
    document_id: id,
    user_id: c.get("principal").userId!,
  });

  const info = await fetchYouTubeInfo(videoId, doc.wiki_id, doc.id);
  if (!info) {
    await updateLog(logId, {
      status: "failed",
      message: "Provider lieferte keine Daten",
      duration_ms: Date.now() - t0,
    });
    return c.json({ error: "Video konnte nicht abgerufen werden" }, 502);
  }

  if (info.segments.length === 0) {
    await updateLog(logId, {
      status: "failed",
      message: "Abruf ohne Zeitmarken – Dokument unverändert",
      duration_ms: Date.now() - t0,
    });
    return c.json(
      {
        error:
          "Der Provider hat für dieses Video keine Zeitmarken geliefert. Das Dokument wurde nicht verändert.",
      },
      422,
    );
  }

  await documentService.replaceTranscriptSegments(
    id,
    doc.wiki_id,
    info.segments,
  );

  // Dokumenttext neu aufbauen, damit die Zeitmarken auch im Text stehen —
  // sonst kämen sie weder in die Chunks noch in eine spätere Generierung.
  const { content, timeline } = buildDocumentText(info);
  await documentService.updateDocumentContent(id, content);

  await updateLog(logId, {
    status: "completed",
    message: `Transkript neu geholt: ${info.segments.length} Zeitmarken`,
    details: { segments: info.segments.length, videoId },
    duration_ms: Date.now() - t0,
  });

  /**
   * Chunking und Einbettung laufen entkoppelt weiter — wie beim Import.
   *
   * Vorher hing beides im Request. Bei einem vierstündigen Video sind das
   * achttausend Segmente und knapp siebenhundert Chunks: nginx gab nach
   * seinem Lesetimeout auf und schickte dem Browser eine 502, obwohl im
   * Hintergrund alles sauber durchlief. Der Nutzer sah einen Fehler, wo
   * keiner war.
   *
   * Die Segmente stehen zu diesem Zeitpunkt bereits in der Datenbank, die
   * Transkriptansicht ist also sofort vollständig. Die alten Chunks löscht
   * der Job (`replace`), nicht diese Route — damit das Dokument nicht die
   * ganze Wartezeit ohne Chunks dasteht.
   */
  await enqueue(QUEUE.chunk, {
    docId: id,
    wikiId: doc.wiki_id,
    timeline,
    replace: true,
  });

  return c.json({
    success: true,
    segments: info.segments.length,
    transcript_language: info.transcriptLanguage,
    transcript_source: info.transcriptSource,
    hinweis:
      "Chunks und Einbettungen werden im Hintergrund erneuert. Wiki-Artikel bleiben unverändert – sie müssen bei Bedarf getrennt neu erzeugt werden.",
  });
});

/** Transkriptsegmente eines Dokuments — Grundlage der Transkriptansicht. */
documentRouter.get("/:id/segments", async (c) => {
  const id = c.req.param("id");
  await requireDocumentCapability(c.get("principal"), id, "wiki.read");
  const segments = await documentService.listTranscriptSegments(id);
  return c.json({ segments });
});

// Vorschau: was würde ein Verschieben bewirken? Verlangt Schreibrecht in Quelle
// UND Ziel – verschieben heißt in beiden Wikis ändern.
documentRouter.get("/:id/move-preview", async (c) => {
  const principal = c.get("principal");
  const id = c.req.param("id");
  const target = c.req.query("target");
  if (!target) return c.json({ error: "target is required" }, 400);

  await requireDocumentCapability(principal, id, "wiki.write");
  await requireWikiCapability(principal, target, "wiki.write");

  const preview = await documentMove.previewMove(id, target);
  if ("error" in preview) return c.json(preview, 400);
  return c.json({ preview });
});

// Dokument samt zugehöriger Wiki-Artikel in einen anderen Wiki verschieben
documentRouter.post(
  "/:id/move",
  zValidator("json", z.object({ target_wiki_id: z.string().uuid() })),
  async (c) => {
    const principal = c.get("principal");
    const id = c.req.param("id");
    const { target_wiki_id } = c.req.valid("json");

    await requireDocumentCapability(principal, id, "wiki.write");
    await requireWikiCapability(principal, target_wiki_id, "wiki.write");

    try {
      const result = await documentMove.moveDocument(id, target_wiki_id);
      return c.json(result);
    } catch (e: any) {
      console.error("[doc] Verschieben fehlgeschlagen:", e);
      return c.json({ error: e.message }, 400);
    }
  },
);

// Dokument löschen
documentRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const principal = c.get("principal");
  const { access, wikiId } = await requireDocumentCapability(
    principal,
    id,
    "wiki.write",
  );
  // Titel vor dem Löschen lesen — mit dem Dokument gehen Chunks, Embeddings
  // und Transkriptsegmente, und eine UUID allein sagt hinterher nicht, was weg ist.
  const dokument = await documentService.getDocument(id);
  await documentService.deleteDocument(id);
  await protokolliere({
    action: AUDIT.dokumentGelöscht,
    organizationId: access.organizationId,
    actorId: principal?.userId ?? null,
    actorEmail: principal?.email ?? null,
    targetType: "document",
    targetId: id,
    details: { wiki_id: wikiId, titel: dokument?.title ?? null },
    ...herkunft(c.req),
  });
  return c.json({ success: true });
});

export { documentRouter };

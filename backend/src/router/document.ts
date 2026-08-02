import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { authMiddleware } from "../middleware/auth.ts";
import {
  assertWorkspaceAccess,
  assertDocumentAccess,
} from "../middleware/workspace-access.ts";
import * as documentService from "../service/document.ts";
import * as documentMove from "../service/document-move.ts";
import {
  extractVideoId,
  fetchYouTubeInfo,
  buildDocumentContent,
  buildDocumentMetadata,
} from "../service/youtube.ts";
import type { DocumentSort } from "../service/document.ts";
import { logActivity, updateLog } from "../service/activity-log.ts";
import * as topicService from "../service/topic.ts";
import { db } from "../db/index.ts";
import { workspaces } from "../db/schema.ts";
import { eq } from "drizzle-orm";

const documentRouter = new Hono();
documentRouter.use("*", authMiddleware);

const urlSchema = z.object({
  workspace_id: z.string().uuid(),
  url: z.string().url(),
  title: z.string().optional(),
});

// Distinct-Kanäle eines Workspace (für das Kanal-Filter-Dropdown)
documentRouter.get("/:workspaceId/channels", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  await assertWorkspaceAccess(c.get("user"), workspaceId, "read");
  const channels = await documentService.listChannels(workspaceId);
  return c.json({ channels });
});

// Dokumente eines Workspace auflisten (mit Filter/Sortierung, Ebene 2)
documentRouter.get("/:workspaceId", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  await assertWorkspaceAccess(c.get("user"), workspaceId, "read");
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
  const list = await documentService.listDocuments(workspaceId, {
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
  await assertDocumentAccess(c.get("user"), c.req.param("id"), "read");
  const ids = await topicService.getDocumentTopicIds(c.req.param("id"));
  return c.json({ topic_ids: ids });
});

// Themen eines Dokuments setzen (manuelle Korrektur, ersetzt alle Zuordnungen)
const docTopicsSchema = z.object({ topic_ids: z.array(z.string()) });
documentRouter.patch(
  "/:id/topics",
  zValidator("json", docTopicsSchema),
  async (c) => {
    await assertDocumentAccess(c.get("user"), c.req.param("id"), "write");
    const { topic_ids } = c.req.valid("json");
    await topicService.setDocumentTopics(c.req.param("id"), topic_ids);
    return c.json({ topic_ids });
  },
);

// Einzelnes Dokument abrufen
documentRouter.get("/detail/:id", async (c) => {
  const id = c.req.param("id");
  await assertDocumentAccess(c.get("user"), id, "read");
  const doc = await documentService.getDocument(id);
  if (!doc) return c.json({ error: "Document not found" }, 404);
  return c.json({ document: doc });
});

// Datei-Upload
documentRouter.post("/upload/:workspaceId", async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const user = c.get("user");
  await assertWorkspaceAccess(user, workspaceId, "write");

  const body = await c.req.parseBody();
  const file = body["file"] as File | undefined;

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
    workspace_id: workspaceId,
    title: fileName,
    type: fileType,
    source: fileName,
    file_size: fileSize,
    created_by: user.id,
  });

  // Datei-Bytes im Request-Kontext lesen (File ist nur hier gültig),
  // die eigentliche Verarbeitung läuft entkoppelt vom HTTP-Response.
  const buffer = await file.arrayBuffer();
  setTimeout(() => {
    processUploadedFile(
      doc.id,
      workspaceId,
      user.id,
      fileName,
      fileType,
      buffer,
    ).catch((e: any) =>
      console.error(`[doc] Upload-Verarbeitung fehlgeschlagen:`, e.message),
    );
  }, 100);

  return c.json({ document: doc }, 201);
});

/**
 * Extrahiert Text aus einer hochgeladenen Datei, speichert ihn und startet
 * Chunking + Wiki-Generierung. Läuft entkoppelt vom HTTP-Response.
 */
async function processUploadedFile(
  docId: string,
  workspaceId: string,
  userId: number,
  fileName: string,
  fileType: string,
  buffer: ArrayBuffer,
) {
  const t0 = Date.now();
  const logId = await logActivity({
    action: "file_import",
    status: "started",
    message: `Verarbeite Datei: ${fileName}`,
    details: { fileName, fileType },
    workspace_id: workspaceId,
    document_id: docId,
    user_id: userId,
  });

  try {
    await documentService.updateDocumentStatus(docId, "processing");

    let text = "";
    const isPlainText =
      fileType === "txt" || fileType === "md" || fileType === "csv";

    if (isPlainText) {
      text = new TextDecoder().decode(buffer);
    } else {
      // PDF, DOCX, HTML: Parser-Microservice (MarkItDown) verwenden
      const parserUrl = process.env.PARSER_URL || "http://localhost:8001/parse";
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([buffer]),
        fileName,
      );
      // 60 s reichen für kleine Dateien, aber ein PDF mit tausenden Seiten braucht im
      // Parser (MarkItDown) deutlich länger. Über PARSER_TIMEOUT_MS konfigurierbar,
      // Default 30 min – muss ≤ dem gunicorn --timeout im Parser (parser/Dockerfile) liegen.
      const parserTimeoutMs = parseInt(process.env.PARSER_TIMEOUT_MS || "1800000");
      const resp = await fetch(parserUrl, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(parserTimeoutMs),
      });
      if (!resp.ok) {
        throw new Error(
          `Parser nicht erreichbar (HTTP ${resp.status}) – .${fileType} kann nicht ohne Parser-Service gelesen werden`,
        );
      }
      const result = await resp.json();
      // HTML-Fallback: falls Parser nichts liefert, eigene Extraktion
      text = result.content || "";
      if ((!text || text.trim().length === 0) && fileType === "html") {
        text = htmlToText(new TextDecoder().decode(buffer));
      }
    }

    if (!text || text.trim().length === 0) {
      throw new Error("Kein Textinhalt aus der Datei extrahierbar");
    }

    // Content speichern (Wiki-Generierung liest doc.content) + chunken
    await documentService.updateDocumentContent(docId, text);
    await scheduleChunking(docId, workspaceId, text);

    await updateLog(logId, {
      status: "completed",
      message: `„${fileName}” verarbeitet (${text.length} Zeichen)`,
      details: { fileName, chars: text.length, doc_id: docId },
      duration_ms: Date.now() - t0,
    });

    // Wiki-Artikel asynchron generieren
    setTimeout(() => scheduleWikiGeneration(docId, workspaceId, userId), 1000);
  } catch (e: any) {
    console.error(`[doc] Datei-Verarbeitung fehlgeschlagen ${docId}:`, e.message);
    try {
      await documentService.updateDocumentStatus(docId, "failed", e.message);
    } catch {}
    await updateLog(logId, {
      status: "failed",
      message: `Fehler: ${e.message}`,
      duration_ms: Date.now() - t0,
    });
  }
}

// URL importieren
documentRouter.post("/import-url", zValidator("json", urlSchema), async (c) => {
  const user = c.get("user");
  const { workspace_id, url, title } = c.req.valid("json");
  await assertWorkspaceAccess(user, workspace_id, "write");

  const doc = await documentService.createDocument({
    id: crypto.randomUUID(),
    workspace_id,
    title: title || url,
    type: "url",
    source: url,
    source_url: url,
    created_by: user.id,
  });

  // Asynchron URL laden (entkoppelt vom Request-Kontext)
  setTimeout(() => {
    fetchAndParseUrl(doc.id, url, workspace_id, user.id).catch((e: any) =>
      console.error(`[doc] URL-Import fehlgeschlagen:`, e.message),
    );
  }, 100);

  return c.json({ document: doc }, 201);
});

// YouTube-Video importieren
const youTubeSchema = z.object({
  workspace_id: z.string().uuid(),
  url: z.string(),
});

documentRouter.post(
  "/import-youtube",
  zValidator("json", youTubeSchema),
  async (c) => {
    const user = c.get("user");
    const { workspace_id, url } = c.req.valid("json");
    await assertWorkspaceAccess(user, workspace_id, "write");

    const t0 = Date.now();
    console.log(`[doc] ========== YouTube-Import gestartet ==========`);
    console.log(`[doc] URL: ${url}`);
    console.log(`[doc] Workspace: ${workspace_id}`);
    console.log(`[doc] User: ${user.id} (${user.email})`);

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
      workspace_id,
      user_id: user.id,
    });

    console.log(`[doc] Rufe YouTube-Info ab (fetchYouTubeInfo)...`);
    const info = await fetchYouTubeInfo(videoId);

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

    const content = buildDocumentContent(info);
    console.log(`[doc] Dokument-Content: ${content.length} Zeichen`);

    const meta = buildDocumentMetadata(info);
    const doc = await documentService.createDocument({
      id: crypto.randomUUID(),
      workspace_id,
      title: info.title,
      type: "youtube",
      source: url,
      source_url: `https://www.youtube.com/watch?v=${videoId}`,
      content,
      channel: meta.channel,
      published_at: meta.published_at,
      duration: meta.duration,
      source_metadata: meta.source_metadata,
      created_by: user.id,
    });
    console.log(`[doc] ✅ Dokument erstellt: ${doc.id}`);

    await updateLog(logId, {
      status: "completed",
      message: `„${info.title}” importiert (${info.transcript.length} Zeichen)`,
      details: {
        title: info.title,
        channel: info.channelName,
        transcript_len: info.transcript.length,
        doc_id: doc.id,
      },
      duration_ms: Date.now() - t0,
    });

    // Chunking starten (async – entkoppelt vom Request-Kontext)
    console.log(`[doc] Starte Chunking für ${doc.id}...`);
    setTimeout(() => {
      scheduleChunking(doc.id, workspace_id, content).catch((e: any) =>
        console.error(`[doc] Chunking fehlgeschlagen:`, e.message),
      );
    }, 100);

    // Wiki-Artikel asynchron generieren
    setTimeout(
      () => scheduleWikiGeneration(doc.id, workspace_id, user.id),
      1000,
    );

    console.log(
      `[doc] ========== YouTube-Import abgeschlossen (${Date.now() - t0}ms) ==========`,
    );
    return c.json({ document: doc }, 201);
  },
);

// YouTube-Metadaten eines einzelnen Dokuments neu abrufen (Ebene 2).
// Für Altbestand, bei dem published_at/duration/tags nie gespeichert wurden,
// oder um veraltete Metadaten zu aktualisieren. Content/Transkript bleibt.
documentRouter.post("/:id/refresh-metadata", async (c) => {
  const id = c.req.param("id");
  await assertDocumentAccess(c.get("user"), id, "write");
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

  const info = await fetchYouTubeInfo(videoId);
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

// Vorschau: was würde ein Verschieben bewirken? Verlangt Schreibrecht in Quelle
// UND Ziel – verschieben heißt in beiden Workspaces ändern.
documentRouter.get("/:id/move-preview", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const target = c.req.query("target");
  if (!target) return c.json({ error: "target is required" }, 400);

  await assertDocumentAccess(user, id, "write");
  await assertWorkspaceAccess(user, target, "write");

  const preview = await documentMove.previewMove(id, target);
  if ("error" in preview) return c.json(preview, 400);
  return c.json({ preview });
});

// Dokument samt zugehöriger Wiki-Artikel in einen anderen Workspace verschieben
documentRouter.post(
  "/:id/move",
  zValidator("json", z.object({ target_workspace_id: z.string().uuid() })),
  async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const { target_workspace_id } = c.req.valid("json");

    await assertDocumentAccess(user, id, "write");
    await assertWorkspaceAccess(user, target_workspace_id, "write");

    try {
      const result = await documentMove.moveDocument(id, target_workspace_id);
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
  await assertDocumentAccess(c.get("user"), id, "write");
  await documentService.deleteDocument(id);
  return c.json({ success: true });
});

// --- Hintergrund-Verarbeitung ---

async function scheduleChunking(
  docId: string,
  workspaceId: string,
  text: string,
) {
  try {
    await documentService.updateDocumentStatus(docId, "processing");

    if (!text || text.trim().length === 0) {
      await documentService.updateDocumentStatus(
        docId,
        "failed",
        "No text could be extracted",
      );
      return;
    }

    // Chunkgröße aus dem Workspace übernehmen. Vorher wurde splitIntoChunks
    // ohne Argumente aufgerufen, wodurch workspaces.chunk_size/chunk_overlap
    // für Dokumente wirkungslos waren (immer 512/50) – in einem Workspace mit
    // größer gechunkten Dokumenten hätte ein UI-Upload sonst eine abweichende
    // Chunk-Größe und damit einen inkonsistenten Vektorindex.
    const [ws] = await db
      .select({
        chunk_size: workspaces.chunk_size,
        chunk_overlap: workspaces.chunk_overlap,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    const chunkList = documentService.splitIntoChunks(
      text,
      ws?.chunk_size ?? 512,
      ws?.chunk_overlap ?? 50,
    );
    if (chunkList.length > 0) {
      await documentService.saveChunks(docId, workspaceId, chunkList);
    }

    await documentService.updateDocumentStatus(
      docId,
      "completed",
      undefined,
      chunkList.length,
    );
    console.log(`[doc] Parsed ${docId}: ${chunkList.length} chunks`);

    // Embedding im Hintergrund starten (nicht-blockierend)
    try {
      const { embedWorkspaceChunks } = await import("../service/embedding.ts");
      embedWorkspaceChunks(workspaceId).then((r) =>
        console.log(`[doc] Embedded ${r.processed} chunks for doc ${docId}`),
      );
    } catch (e: any) {
      console.warn(`[doc] Embedding trigger failed:`, e.message);
    }
  } catch (e: any) {
    console.error(`[doc] Parse error ${docId}:`, e.message);
    try {
      await documentService.updateDocumentStatus(docId, "failed", e.message);
    } catch {}
  }
}

/** Wiki-Artikel asynchron generieren (Blockiert nicht den HTTP-Response) */
async function scheduleWikiGeneration(
  docId: string,
  workspaceId: string,
  userId: number,
) {
  const t0 = Date.now();
  const logId = await logActivity({
    action: "wiki_generate",
    status: "started",
    message: `Generiere Wiki-Artikel aus Dokument ${docId.slice(0, 8)}...`,
    details: { document_id: docId },
    workspace_id: workspaceId,
    document_id: docId,
    user_id: userId,
  });

  console.log(`[doc] ========== scheduleWikiGeneration START ==========`);
  console.log(`[doc] Erstelle Wiki-Artikel für Dokument ${docId}...`);

  try {
    const { generateWikiArticles } =
      await import("../service/wiki-generate.ts");

    const result = await generateWikiArticles(docId, workspaceId);

    if (result) {
      await updateLog(logId, {
        status: "completed",
        message: `Wiki-Seiten erstellt/aktualisiert: Summary + ${result.entities} Entities + ${result.concepts} Concepts`,
        details: {
          document_id: docId,
          summary_id: result.summary?.id,
          entities: result.entities,
          concepts: result.concepts,
        },
        duration_ms: Date.now() - t0,
      });
      console.log(
        `[doc] ✅ Wiki-Generierung abgeschlossen: ${result.entities} Entities, ${result.concepts} Concepts`,
      );
    } else {
      await updateLog(logId, {
        status: "failed",
        message: "Wiki-Generierung ergab kein Ergebnis (kein LLM-Provider?)",
        duration_ms: Date.now() - t0,
      });
      console.log(`[doc] ⚠️ Wiki-Generierung ergab kein Ergebnis`);
    }
  } catch (e: any) {
    await updateLog(logId, {
      status: "failed",
      message: `Fehler: ${e.message}`,
      duration_ms: Date.now() - t0,
    });
    console.warn(`[doc] ❌ Wiki-Generierung fehlgeschlagen:`, e.message);
  }

  console.log(`[doc] ========== scheduleWikiGeneration ENDE ==========`);
}

/**
 * Lädt eine Webseite, extrahiert den Textinhalt, speichert ihn und startet
 * Chunking + Wiki-Generierung. Läuft entkoppelt vom HTTP-Response (fire-and-forget).
 */
async function fetchAndParseUrl(
  docId: string,
  url: string,
  workspaceId: string,
  userId: number,
) {
  const t0 = Date.now();
  const logId = await logActivity({
    action: "url_import",
    status: "started",
    message: `Importiere URL: ${url}`,
    details: { url },
    workspace_id: workspaceId,
    document_id: docId,
    user_id: userId,
  });

  try {
    await documentService.updateDocumentStatus(docId, "processing");

    // Webseite mit Browser-ähnlichen Headern laden (reduziert 403-Rejections)
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} beim Laden der URL`);
    }
    const html = await resp.text();

    // Bevorzugt: Parser-Microservice (MarkItDown → sauberes Markdown)
    let text = "";
    const parserUrl = process.env.PARSER_URL || "http://localhost:8001/parse";
    try {
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([html], { type: "text/html" }),
        "page.html",
      );
      const parserResp = await fetch(parserUrl, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(30000),
      });
      if (parserResp.ok) {
        const result = await parserResp.json();
        text = result.content || "";
      }
    } catch (e: any) {
      console.warn(`[doc] Parser für URL nicht erreichbar:`, e.message);
    }

    // Fallback: eigene HTML→Text-Extraktion (kein Parser nötig)
    if (!text || text.trim().length === 0) {
      text = htmlToText(html);
    }

    if (!text || text.trim().length === 0) {
      throw new Error("Kein Textinhalt aus der URL extrahierbar");
    }

    // Content speichern (Wiki-Generierung liest doc.content) + chunken
    await documentService.updateDocumentContent(docId, text);
    await scheduleChunking(docId, workspaceId, text);

    await updateLog(logId, {
      status: "completed",
      message: `URL importiert (${text.length} Zeichen)`,
      details: { url, chars: text.length, doc_id: docId },
      duration_ms: Date.now() - t0,
    });

    // Wiki-Artikel asynchron generieren
    setTimeout(() => scheduleWikiGeneration(docId, workspaceId, userId), 1000);
  } catch (e: any) {
    console.error(`[doc] URL-Import fehlgeschlagen ${docId}:`, e.message);
    try {
      await documentService.updateDocumentStatus(docId, "failed", e.message);
    } catch {}
    await updateLog(logId, {
      status: "failed",
      message: `Fehler: ${e.message}`,
      duration_ms: Date.now() - t0,
    });
  }
}

/** Extrahiert sauberen Text aus HTML: entfernt Skripte/Styles/Navigation. */
function htmlToText(html: string): string {
  const text = html
    // Nicht-inhaltliche Blöcke komplett entfernen
    .replace(
      /<(script|style|nav|footer|header|iframe|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    )
    // Kommentare entfernen
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Blockelemente in Zeilenumbrüche wandeln
    .replace(/<\/(p|div|li|h[1-6]|tr|br)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Restliche Tags strippen
    .replace(/<[^>]+>/g, " ")
    // Numerische HTML-Entities dekodieren (&#8211; usw.)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    // Benannte HTML-Entities (häufigste)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Whitespace normalisieren: Leerzeilen zusammenfassen
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l !== "")
    .join("\n");
}

export { documentRouter };

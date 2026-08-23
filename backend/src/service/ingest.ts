/**
 * Die eigentliche Arbeit hinter den Importen: Text gewinnen, chunken, einbetten,
 * Artikel erzeugen.
 *
 * Diese Funktionen standen bis zum 21. August 2026 in `router/document.ts` und
 * wurden dort per `setTimeout` angestoßen. Sie liegen jetzt hier, weil zwei
 * Aufrufer sie brauchen und keiner von beiden den anderen importieren soll:
 * der Router **stellt Jobs ein** (`jobs/queue.ts`), der Worker **arbeitet sie
 * ab** (`jobs/worker.ts`). Läge die Arbeit weiter im Router, müsste der Worker
 * die Hono-Routen mitladen, um an sie zu kommen.
 *
 * Die Funktionen selbst sind bewusst unverändert geblieben, bis auf eine
 * Änderung mit Folgen: **sie stoßen Folgearbeiten nicht mehr selbst an.** Wo
 * früher `setTimeout(() => scheduleWikiGeneration(...), 1000)` stand, wird jetzt
 * ein Job eingestellt. Das eine Sekunde lange Warten war ohnehin nur ein
 * Notbehelf, damit die Datenbank mit dem Speichern fertig ist — die
 * Warteschlange braucht ihn nicht, weil der Job erst nach dem Commit sichtbar
 * wird.
 */
import * as documentService from "./document.ts";
import { logActivity, updateLog } from "./activity-log.ts";
import { zeitfensterFür, type ZeitAbschnitt } from "./youtube.ts";
import { db } from "../db/index.ts";
import { wikis } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { QUEUE, enqueue } from "../jobs/queue.ts";

/**
 * Extrahiert Text aus einer hochgeladenen Datei, speichert ihn und stellt
 * Chunking und Wiki-Generierung ein.
 */
export async function verarbeiteDatei(
  docId: string,
  wikiId: string,
  userId: string,
  fileName: string,
  fileType: string,
  buffer: ArrayBuffer | Uint8Array,
  /** Beim Import gewählter Chat-Anbieter; ohne ihn gilt die übliche Auswahl. */
  providerId?: string,
) {
  const t0 = Date.now();
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const logId = await logActivity({
    action: "file_import",
    status: "started",
    message: `Verarbeite Datei: ${fileName}`,
    details: { fileName, fileType },
    wiki_id: wikiId,
    document_id: docId,
    user_id: userId,
  });

  try {
    await documentService.updateDocumentStatus(docId, "processing");

    let text = "";
    const isPlainText =
      fileType === "txt" || fileType === "md" || fileType === "csv";

    if (isPlainText) {
      text = new TextDecoder().decode(bytes);
    } else {
      // PDF, DOCX, HTML: Parser-Microservice (MarkItDown) verwenden
      const parserUrl = process.env.PARSER_URL || "http://localhost:8001/parse";
      const formData = new FormData();
      formData.append("file", new Blob([bytes]), fileName);
      // 60 s reichen für kleine Dateien, aber ein PDF mit tausenden Seiten braucht im
      // Parser (MarkItDown) deutlich länger. Über PARSER_TIMEOUT_MS konfigurierbar,
      // Default 30 min – muss ≤ dem gunicorn --timeout im Parser (parser/Dockerfile)
      // und < expireInSeconds der Warteschlange liegen (jobs/queue.ts).
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
        text = htmlToText(new TextDecoder().decode(bytes));
      }
    }

    if (!text || text.trim().length === 0) {
      throw new Error("Kein Textinhalt aus der Datei extrahierbar");
    }

    // Content speichern, *bevor* der Chunk-Job eingestellt wird: der liest den
    // Text aus der Datenbank und nicht aus der Nutzlast (jobs/queue.ts).
    await documentService.updateDocumentContent(docId, text);

    await updateLog(logId, {
      status: "completed",
      message: `„${fileName}” verarbeitet (${text.length} Zeichen)`,
      details: { fileName, chars: text.length, doc_id: docId },
      duration_ms: Date.now() - t0,
    });

    await enqueue(QUEUE.chunk, { docId, wikiId });
    await enqueue(QUEUE.wikiGenerate, { docId, wikiId, userId, providerId });
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
    // Weitergeben, damit die Warteschlange den Job als gescheitert führt und
    // ihn nach `retryDelay` wiederholt. Vorher wurde der Fehler hier
    // verschluckt und der Import war lautlos zu Ende.
    throw e;
  }
}

/**
 * Schneidet den gespeicherten Dokumenttext in Chunks.
 *
 * Der Text kommt aus `documents.content` und nicht aus einem Argument. Das ist
 * die Bedingung dafür, dass dieser Schritt ein eigener, wiederholbarer Job sein
 * kann: eine Wiederholung nach einem Neustart hat sonst keine Daten mehr.
 */
export async function chunkeDokument(
  docId: string,
  wikiId: string,
  /** Nur bei YouTube-Importen mit Zeitmarken belegt. */
  timeline: ZeitAbschnitt[] = [],
  /** Vorhandene Chunks vorher löschen (erneuter Transkript-Abruf). */
  replace = false,
) {
  try {
    await documentService.updateDocumentStatus(docId, "processing");

    const doc = await documentService.getDocument(docId);
    const text = doc?.content ?? "";

    if (!text || text.trim().length === 0) {
      await documentService.updateDocumentStatus(
        docId,
        "failed",
        "No text could be extracted",
      );
      return;
    }

    // Erst hier löschen, nicht beim Einstellen des Jobs: so steht das Dokument
    // nicht die ganze Wartezeit ohne Chunks da.
    if (replace) {
      await documentService.deleteChunks(docId);
    }

    // Chunkgröße aus dem Wiki übernehmen. Vorher wurde splitIntoChunks
    // ohne Argumente aufgerufen, wodurch wikis.chunk_size/chunk_overlap
    // für Dokumente wirkungslos waren (immer 512/50) – in einem Wiki mit
    // größer gechunkten Dokumenten hätte ein UI-Upload sonst eine abweichende
    // Chunk-Größe und damit einen inkonsistenten Vektorindex.
    const [ws] = await db
      .select({
        chunk_size: wikis.chunk_size,
        chunk_overlap: wikis.chunk_overlap,
      })
      .from(wikis)
      .where(eq(wikis.id, wikiId))
      .limit(1);

    const chunkList = documentService.splitIntoChunks(
      text,
      ws?.chunk_size ?? 512,
      ws?.chunk_overlap ?? 50,
    );

    // Jedem Chunk das Zeitfenster mitgeben, aus dem sein Text stammt. Damit
    // kann eine Chat-Antwort später nicht nur das Video, sondern die Stelle
    // belegen (chunks.start_ms, schema/content.ts).
    const mitZeit = chunkList.map((c) => {
      const fenster =
        timeline.length > 0
          ? zeitfensterFür(timeline, c.char_start, c.char_end)
          : null;
      return {
        ...c,
        start_ms: fenster?.start_ms ?? null,
        end_ms: fenster?.end_ms ?? null,
      };
    });

    if (mitZeit.length > 0) {
      await documentService.saveChunks(docId, wikiId, mitZeit);
      const verzeitet = mitZeit.filter((c) => c.start_ms !== null).length;
      if (timeline.length > 0) {
        console.log(`[doc] ${verzeitet}/${mitZeit.length} Chunks mit Zeitfenster`);
      }
    }

    await documentService.updateDocumentStatus(
      docId,
      "completed",
      undefined,
      chunkList.length,
    );
    console.log(`[doc] Parsed ${docId}: ${chunkList.length} chunks`);

    // Einbetten als eigener Job. Vorher hing es als nicht abgewartetes
    // `.then()` am Chunking: ein Neustart verlor es, und weil `chunks.embedding`
    // dabei `NULL` blieb, waren die betroffenen Chunks für die Suche unsichtbar,
    // ohne dass irgendwo ein Fehler stand. Der Restore-Test vom 21. August fand
    // 1.387 solche Chunks.
    //
    // `singletonKey` je Wiki: mehrere Importe hintereinander brauchen keine
    // mehrfachen Nachziehläufe, einer holt alles Offene.
    await enqueue(
      QUEUE.embed,
      { wikiId },
      { singletonKey: `embed:${wikiId}`, singletonSeconds: 60 },
    );
  } catch (e: any) {
    console.error(`[doc] Parse error ${docId}:`, e.message);
    try {
      await documentService.updateDocumentStatus(docId, "failed", e.message);
    } catch {}
    throw e;
  }
}

/** Fehlende Embeddings eines Wiki nachziehen. */
export async function betteWikiEin(wikiId: string) {
  const { embedWorkspaceChunks } = await import("./embedding.ts");
  const r = await embedWorkspaceChunks(wikiId);
  console.log(`[doc] Embedded ${r.processed} chunks for wiki ${wikiId}`);
  return r;
}

/** Wiki-Artikel aus einem Dokument erzeugen. */
export async function generiereWikiArtikel(
  docId: string,
  wikiId: string,
  userId: string,
  providerId?: string,
) {
  const t0 = Date.now();
  const logId = await logActivity({
    action: "wiki_generate",
    status: "started",
    message: `Generiere Wiki-Artikel aus Dokument ${docId.slice(0, 8)}...`,
    details: { document_id: docId },
    wiki_id: wikiId,
    document_id: docId,
    user_id: userId,
  });

  console.log(`[doc] ========== Wiki-Generierung START ==========`);
  console.log(`[doc] Erstelle Wiki-Artikel für Dokument ${docId}...`);

  try {
    const { generateWikiArticles } = await import("./wiki-generate.ts");

    const result = await generateWikiArticles(docId, wikiId, providerId);

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
      // Kein `throw`: ohne Anbieter hilft keine Wiederholung, und der Job
      // würde sonst sein Guthaben in Versuchen verbrennen, die alle dasselbe
      // Ergebnis haben. Der Log-Eintrag ist der Befund.
    }
    return result;
  } catch (e: any) {
    await updateLog(logId, {
      status: "failed",
      message: `Fehler: ${e.message}`,
      duration_ms: Date.now() - t0,
    });
    console.warn(`[doc] ❌ Wiki-Generierung fehlgeschlagen:`, e.message);
    throw e;
  }
}

/**
 * Lädt eine Webseite, extrahiert den Textinhalt, speichert ihn und stellt
 * Chunking und Wiki-Generierung ein.
 */
export async function importiereUrl(
  docId: string,
  url: string,
  wikiId: string,
  userId: string,
  providerId?: string,
) {
  const t0 = Date.now();
  const logId = await logActivity({
    action: "url_import",
    status: "started",
    message: `Importiere URL: ${url}`,
    details: { url },
    wiki_id: wikiId,
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

    await documentService.updateDocumentContent(docId, text);

    await updateLog(logId, {
      status: "completed",
      message: `URL importiert (${text.length} Zeichen)`,
      details: { url, chars: text.length, doc_id: docId },
      duration_ms: Date.now() - t0,
    });

    await enqueue(QUEUE.chunk, { docId, wikiId });
    await enqueue(QUEUE.wikiGenerate, { docId, wikiId, userId, providerId });
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
    throw e;
  }
}

/** Extrahiert sauberen Text aus HTML: entfernt Skripte/Styles/Navigation. */
export function htmlToText(html: string): string {
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

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { sessionMiddleware } from "../middleware/auth.ts";
import { wikiParamAccess } from "../middleware/access.ts";
import * as wikiService from "../service/wiki.ts";
import * as activityLog from "../service/activity-log.ts";
import { QUEUE, enqueue } from "../jobs/queue.ts";
import { LIMITS } from "../middleware/rate-limit.ts";

const pageRouter = new Hono();
pageRouter.use("*", sessionMiddleware);
// Alle Wiki-Routen liegen unter /:wikiId/… – GET = lesen, alles andere
// schreiben.
pageRouter.use("/:wikiId/*", wikiParamAccess());

const createSchema = z.object({
  slug: z.string().min(1).max(255),
  title: z.string().min(1).max(512),
  content: z.string().optional(),
  summary: z.string().optional(),
  page_type: z.enum(["article", "entity", "concept"]).optional(),
  source_document_id: z.string().uuid().optional(),
});

const updateSchema = z.object({
  title: z.string().min(1).max(512).optional(),
  content: z.string().optional(),
  summary: z.string().optional(),
  page_type: z.enum(["article", "entity", "concept"]).optional(),
  status: z.enum(["published", "draft", "archived"]).optional(),
});

const WIKI_SORTS = [
  "updated_desc",
  "updated_asc",
  "title_asc",
  "title_desc",
  "published_desc",
  "published_asc",
  "connections_desc",
] as const;
type WikiSortT = (typeof WIKI_SORTS)[number];

// Wiki-Seiten eines Wiki auflisten (mit Filter/Sortierung, Ebene 2)
pageRouter.get("/:wikiId/pages", async (c) => {
  const wikiId = c.req.param("wikiId");
  const q = c.req.query();
  const parseDate = (v?: string) => {
    if (!v) return undefined;
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d;
  };

  const result = await wikiService.listPages(wikiId, {
    page_type: q.page_type || undefined,
    // Standardmäßig nur veröffentlichte Seiten; Entwürfe (Chat-Verbund) bleiben
    // dem Review-Endpoint vorbehalten. Explizites ?status=… überschreibt das.
    status: q.status || "published",
    query: q.query || undefined,
    source_document_id: q.source_document_id || undefined,
    channel: q.channel || undefined,
    dateFrom: parseDate(q.from),
    dateTo: parseDate(q.to),
    topicIds: q.topics ? q.topics.split(",").filter(Boolean) : undefined,
    references: q.references || undefined,
    flags: q.flags ? q.flags.split(",").filter(Boolean) : undefined,
    sort: WIKI_SORTS.includes(q.sort as WikiSortT)
      ? (q.sort as WikiSortT)
      : undefined,
    // NaN-sicher: ?page=abc ergab vorher offset NaN und damit einen DB-Fehler.
    page: Math.max(1, parseInt(q.page || "1") || 1),
    page_size: q.page_size ? parseInt(q.page_size) || undefined : undefined,
  });
  return c.json(result);
});

/**
 * Zeitleiste: Treffer je Monat, gruppiert über das Sitzungsdatum.
 *
 * Macht aus mehreren hundert flachen Karten eine navigierbare Struktur. Ohne das
 * gibt es keinen Weg, einen Zeitraum anzusteuern – der Datumsfilter allein
 * verlangt, dass man den gesuchten Zeitraum schon kennt.
 */
pageRouter.get("/:wikiId/facets/months", async (c) => {
  const wikiId = c.req.param("wikiId");
  const q = c.req.query();
  const months = await wikiService.monthFacets(wikiId, {
    page_type: q.page_type || undefined,
    channel: q.channel || undefined,
  });
  return c.json({ months });
});

/** Auffälligkeiten: Treffer je Marker aus page_metadata.flags. */
pageRouter.get("/:wikiId/facets/flags", async (c) => {
  const flags = await wikiService.flagFacets(c.req.param("wikiId"));
  return c.json({ flags });
});

// Graph-Daten (Fokus-Subgraph oder Top-Konzepte-Wolke)
pageRouter.get("/:wikiId/graph", async (c) => {
  const wikiId = c.req.param("wikiId");
  const q = c.req.query();
  const graph = await wikiService.getGraph(wikiId, {
    focus: q.focus || undefined,
    types: q.types ? q.types.split(",").filter(Boolean) : undefined,
    limit: q.limit ? parseInt(q.limit) : undefined,
  });
  return c.json(graph);
});

// Ebene 3: meistverlinkte Konzepte (Backlink-Einstiegspunkte)
pageRouter.get("/:wikiId/concepts/top", async (c) => {
  const wikiId = c.req.param("wikiId");
  const limit = parseInt(c.req.query("limit") || "20");
  const concepts = await wikiService.topConcepts(wikiId, limit);
  return c.json({ concepts });
});

// --- Chat → Wiki-Artikel-Verbund ---

const fromChatSchema = z.object({
  session_id: z.string().uuid(),
  instructions: z.string().max(2000).optional(),
  audience: z.string().max(200).optional(),
  style: z.string().max(200).optional(),
  length: z.string().max(50).optional(),
  max_subpages: z.number().int().min(0).max(12).optional(),
  max_entities: z.number().int().min(0).max(30).optional(),
  use_rag: z.boolean().optional(),
});

// Verbund aus einem Gespräch erzeugen (asynchron). Ersetzt vorhandene, noch
// nicht veröffentlichte Entwürfe derselben Session ("Regenerieren = ersetzen").
pageRouter.post(
  "/:wikiId/from-chat",
  LIMITS.generate,
  zValidator("json", fromChatSchema),
  async (c) => {
    const wikiId = c.req.param("wikiId");
    const principal = c.get("principal");
    const data = c.req.valid("json");

    await wikiService.deleteSessionDrafts(wikiId, data.session_id);

    const clusterId = crypto.randomUUID();
    // Fortschritt via Activity-Log, Ergebnis via /drafts-Poll. Der Lauf selbst
    // gehört in die Warteschlange und nicht in ein `setTimeout`: er dauert
    // Minuten und kostet LLM-Guthaben, und beides zweimal zu bezahlen, weil ein
    // Deployment dazwischenkam, ist der teuerste Weg, nichts zu bekommen.
    await enqueue(QUEUE.chatCluster, {
      wikiId,
      sessionId: data.session_id,
      clusterId,
      spec: {
        instructions: data.instructions,
        audience: data.audience,
        style: data.style,
        length: data.length,
        max_subpages: data.max_subpages,
        max_entities: data.max_entities,
        use_rag: data.use_rag,
      },
      userId: principal.userId ?? undefined,
    });

    return c.json({ cluster_id: clusterId }, 202);
  },
);

// Offene Entwurfs-Verbünde eines Wiki (Hinweis im Wiki-Browser).
pageRouter.get("/:wikiId/draft-clusters", async (c) => {
  const wikiId = c.req.param("wikiId");
  const clusters = await wikiService.listDraftClusters(wikiId);
  return c.json({ clusters });
});

// Entwurfsseiten eines Verbunds abrufen (Review/Polling) inkl. Generierungs-Status.
pageRouter.get("/:wikiId/clusters/:clusterId/pages", async (c) => {
  const wikiId = c.req.param("wikiId");
  const clusterId = c.req.param("clusterId");
  const [pages, status] = await Promise.all([
    wikiService.listClusterDrafts(wikiId, clusterId),
    activityLog.getChatWikiStatus(clusterId),
  ]);
  return c.json({ pages, status });
});

// Verbund veröffentlichen (alle Entwürfe → published).
pageRouter.post("/:wikiId/clusters/:clusterId/publish", async (c) => {
  const wikiId = c.req.param("wikiId");
  const clusterId = c.req.param("clusterId");
  const count = await wikiService.publishCluster(wikiId, clusterId);
  return c.json({ published: count });
});

// Einzelne Wiki-Seite abrufen (per Slug)
pageRouter.get("/:wikiId/pages/:slug", async (c) => {
  const wikiId = c.req.param("wikiId");
  const slug = decodeURIComponent(c.req.param("slug"));
  const page = await wikiService.getPage(wikiId, slug);
  if (!page) return c.json({ error: "Page not found" }, 404);
  return c.json({ page });
});

// Wiki-Seite erstellen
pageRouter.post(
  "/:wikiId/pages",
  zValidator("json", createSchema),
  async (c) => {
    const wikiId = c.req.param("wikiId");
    const principal = c.get("principal");
    const data = c.req.valid("json");

    // Prüfen ob Slug bereits existiert
    const existing = await wikiService.getPage(wikiId, data.slug);
    if (existing) {
      return c.json({ error: "Slug already exists" }, 409);
    }

    const page = await wikiService.createPage({
      ...data,
      wiki_id: wikiId,
      created_by: principal.userId!,
    });

    // Links auflösen
    if (page.content) {
      const { out_links } = await wikiService.resolveLinks(
        wikiId,
        page.content,
      );
      if (out_links.length > 0) {
        await wikiService.updatePage(wikiId, page.slug, { out_links });
        await wikiService.updateIncomingLinks(
          wikiId,
          page.slug,
          out_links,
        );
      }
    }

    return c.json({ page }, 201);
  },
);

// Wiki-Seite aktualisieren
pageRouter.put(
  "/:wikiId/pages/:slug",
  zValidator("json", updateSchema),
  async (c) => {
    const wikiId = c.req.param("wikiId");
    const slug = decodeURIComponent(c.req.param("slug"));
    const data = c.req.valid("json");
    const principal = c.get("principal");
    // Manueller Edit (Ebene 4): Snapshot + Lock setzen.
    const opts = { manual: true, editedBy: principal.userId ?? undefined };

    const page = await wikiService.updatePage(wikiId, slug, data, opts);
    if (!page) return c.json({ error: "Page not found" }, 404);

    // Bei Content-Änderung: Links neu auflösen (ebenfalls als manual, sonst
    // blockt der frisch gesetzte Lock das out_links-Update).
    if (data.content) {
      const { out_links } = await wikiService.resolveLinks(
        wikiId,
        data.content,
      );
      if (out_links.length > 0) {
        await wikiService.updatePage(wikiId, slug, { out_links }, opts);
        await wikiService.updateIncomingLinks(wikiId, slug, out_links);
      }
    }

    return c.json({ page });
  },
);

// Ebene 4: Versionshistorie einer Seite
pageRouter.get("/:wikiId/pages/:slug/revisions", async (c) => {
  const wikiId = c.req.param("wikiId");
  const slug = decodeURIComponent(c.req.param("slug"));
  const revisions = await wikiService.listRevisions(wikiId, slug);
  return c.json({ revisions });
});

// Ebene 4: frühere Fassung wiederherstellen
pageRouter.post(
  "/:wikiId/pages/:slug/revisions/:revId/restore",
  async (c) => {
    const wikiId = c.req.param("wikiId");
    const slug = decodeURIComponent(c.req.param("slug"));
    const revId = parseInt(c.req.param("revId"));
    const principal = c.get("principal");
    const page = await wikiService.restoreRevision(
      wikiId,
      slug,
      revId,
      principal.userId ?? undefined,
    );
    if (!page) return c.json({ error: "Revision not found" }, 404);
    return c.json({ page });
  },
);

// Wiki-Seite löschen
pageRouter.delete("/:wikiId/pages/:slug", async (c) => {
  const wikiId = c.req.param("wikiId");
  const slug = decodeURIComponent(c.req.param("slug"));
  await wikiService.deletePage(wikiId, slug);
  return c.json({ success: true });
});

// Wiki-Seite aus Dokument generieren (neue Pipeline)
pageRouter.post("/:wikiId/generate/:documentId", LIMITS.generate, async (c) => {
  const wikiId = c.req.param("wikiId");
  const documentId = c.req.param("documentId");

  try {
    const { generateWikiArticles } =
      await import("../service/wiki-generate.ts");
    const result = await generateWikiArticles(documentId, wikiId);

    if (!result) {
      return c.json(
        {
          error:
            "Generation failed - no chat provider configured or document empty",
        },
        400,
      );
    }

    return c.json(
      {
        summary: result.summary,
        entities: result.entities,
        concepts: result.concepts,
      },
      201,
    );
  } catch (e: any) {
    console.error("[wiki] Generation error:", e.message);
    return c.json({ error: `Generation failed: ${e.message}` }, 500);
  }
});

// Wiki-Statistiken
pageRouter.get("/:wikiId/stats", async (c) => {
  const wikiId = c.req.param("wikiId");
  const stats = await wikiService.getStats(wikiId);
  return c.json(stats);
});

// Strukturierte Index-Ansicht (Intro + getypte Paginierung)
pageRouter.get("/:wikiId/index", async (c) => {
  const wikiId = c.req.param("wikiId");
  const types = c.req.query("types")?.split(",") || [
    "summary",
    "entity",
    "concept",
  ];
  const limit = parseInt(c.req.query("limit") || "50");
  const cursor = c.req.query("cursor") || "";

  // Index-Seite (Intro) laden
  const indexPage = await wikiService.getPage(wikiId, "index");

  // Pro Type die ersten Seiten laden
  const groups: Record<string, { total: number; pages: any[] }> = {};
  for (const type of types) {
    const result = await wikiService.listPages(wikiId, {
      page_type: type,
      page_size: limit,
      page: 1,
    });
    groups[type] = { total: result.total, pages: result.pages };
  }

  return c.json({
    intro: indexPage?.summary || "",
    groups,
    total_pages: Object.values(groups).reduce((s, g) => s + g.total, 0),
  });
});

// Seiten nach Typ (paginierte Liste für Tab-Bar)
pageRouter.get("/:wikiId/pages-by-type", async (c) => {
  const wikiId = c.req.param("wikiId");
  const type = c.req.query("type") || "";
  const page = parseInt(c.req.query("page") || "1");
  const pageSize = parseInt(c.req.query("page_size") || "50");

  const result = await wikiService.listPages(wikiId, {
    page_type: type || undefined,
    page,
    page_size: pageSize,
  });

  return c.json(result);
});


// Slug-Vorschläge (für Auto-Complete im Editor)
pageRouter.get("/:wikiId/suggestions", async (c) => {
  const wikiId = c.req.param("wikiId");
  const query = c.req.query("q") || "";

  const result = await wikiService.listPages(wikiId, {
    query,
    page_size: 20,
  });
  return c.json({
    suggestions: result.pages.map((p) => ({
      slug: p.slug,
      title: p.title,
      page_type: p.page_type,
    })),
  });
});

export { pageRouter };

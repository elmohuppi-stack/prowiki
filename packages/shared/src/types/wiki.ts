import { z } from "zod";

export const WikiPageTypeEnum = z.enum([
  "article",
  "entity",
  "concept",
  "index",
  "log",
  "synthesis",
  "comparison",
  "youtube_transcript",
]);
export type WikiPageType = z.infer<typeof WikiPageTypeEnum>;
export type WikiPageStatus = "published" | "draft" | "archived";

export const WikiPageSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  slug: z.string().max(255),
  title: z.string().max(512),
  summary: z.string().default(""),
  content: z.string().default(""),
  page_type: WikiPageTypeEnum.default("article"),
  status: z.enum(["published", "draft", "archived"]).default("published"),
  source_document_id: z.string().uuid().nullable(),
  out_links: z.array(z.string()).default([]),
  in_links: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  source_refs: z.array(z.string()).default([]),
  page_metadata: z.record(z.any()).default({}),
  version: z.number().default(1),
  created_by: z.number().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type WikiPage = z.infer<typeof WikiPageSchema>;

export const WikiPageListSchema = z.object({
  pages: z.array(WikiPageSchema),
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
});

export type WikiPageList = z.infer<typeof WikiPageListSchema>;

export const WikiGraphNodeSchema = z.object({
  slug: z.string(),
  title: z.string(),
  page_type: z.string(),
  link_count: z.number(),
});

export type WikiGraphNode = z.infer<typeof WikiGraphNodeSchema>;

export const WikiGraphEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
});

export type WikiGraphEdge = z.infer<typeof WikiGraphEdgeSchema>;

export const WikiGraphDataSchema = z.object({
  nodes: z.array(WikiGraphNodeSchema),
  edges: z.array(WikiGraphEdgeSchema),
});

export type WikiGraphData = z.infer<typeof WikiGraphDataSchema>;

export const WikiStatsSchema = z.object({
  total_pages: z.number(),
  pages_by_type: z.record(z.string(), z.number()),
  total_links: z.number(),
  recent_updates: z.array(WikiPageSchema),
});

export type WikiStats = z.infer<typeof WikiStatsSchema>;

// Type für Slug-Vorschläge beim Editieren
export const WikiSlugSuggestionSchema = z.object({
  slug: z.string(),
  title: z.string(),
  page_type: z.string(),
});

export type WikiSlugSuggestion = z.infer<typeof WikiSlugSuggestionSchema>;

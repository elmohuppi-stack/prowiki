import { z } from "zod";

export const ChunkSchema = z.object({
  id: z.string().uuid(),
  document_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  content: z.string(),
  chunk_index: z.number(),
  token_count: z.number().default(0),
  created_at: z.string().datetime(),
});

export type Chunk = z.infer<typeof ChunkSchema>;

export const SearchResultSchema = z.object({
  chunk_id: z.string().uuid(),
  document_id: z.string().uuid(),
  document_title: z.string(),
  content: z.string(),
  score: z.number(),
  search_type: z.enum(["vector", "keyword", "hybrid"]),
});

export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchQuerySchema = z.object({
  workspace_id: z.string().uuid(),
  query: z.string().min(1),
  top_k: z.number().default(10),
  search_type: z.enum(["vector", "keyword", "hybrid"]).default("hybrid"),
});

export type SearchQuery = z.infer<typeof SearchQuerySchema>;

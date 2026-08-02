import { z } from "zod";

export type DocumentType =
  | "pdf"
  | "docx"
  | "md"
  | "html"
  | "youtube"
  | "url"
  | "txt";
export type ParseStatus = "pending" | "processing" | "completed" | "failed";

export const DocumentSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  title: z.string().max(512),
  type: z.enum(["pdf", "docx", "md", "html", "youtube", "url", "txt"]),
  source: z.string(),
  source_url: z.string().nullable(),
  content: z.string().nullable(),
  file_path: z.string().nullable(),
  file_size: z.number().nullable(),
  file_hash: z.string().nullable(),
  parse_status: z.enum(["pending", "processing", "completed", "failed"]),
  parse_error: z.string().nullable(),
  chunk_count: z.number().default(0),
  // Herkunfts-Metadaten (v.a. YouTube), beim Import befüllt, sonst null.
  channel: z.string().nullable().optional(),
  published_at: z.string().datetime().nullable().optional(),
  duration: z.number().nullable().optional(),
  source_metadata: z
    .object({
      channelUrl: z.string().optional(),
      thumbnailUrl: z.string().optional(),
      youtube_tags: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
  created_by: z.number(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  processed_at: z.string().datetime().nullable(),
});

export type Document = z.infer<typeof DocumentSchema>;

export const DocumentListSchema = z.object({
  documents: z.array(DocumentSchema),
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
});

export type DocumentList = z.infer<typeof DocumentListSchema>;

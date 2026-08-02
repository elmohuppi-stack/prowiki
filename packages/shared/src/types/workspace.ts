import { z } from "zod";

export const IndexingStrategySchema = z.object({
  vector_enabled: z.boolean().default(true),
  keyword_enabled: z.boolean().default(true),
  wiki_enabled: z.boolean().default(false),
  graph_enabled: z.boolean().default(false),
});

export type IndexingStrategy = z.infer<typeof IndexingStrategySchema>;

export const WikiConfigSchema = z.object({
  auto_ingest: z.boolean().default(false),
  synthesis_model_id: z.string().nullable().default(null),
  wiki_language: z.string().default("de"),
  max_pages_per_ingest: z.number().default(10),
});

export type WikiConfig = z.infer<typeof WikiConfigSchema>;

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().nullable(),
  created_by: z.number(),
  chunk_size: z.number().default(512),
  chunk_overlap: z.number().default(50),
  embedding_model_id: z.string().uuid().nullable(),
  chat_model_id: z.string().uuid().nullable(),
  indexing_strategy: IndexingStrategySchema,
  wiki_config: WikiConfigSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  chunk_size: z.number().default(512),
  chunk_overlap: z.number().default(50),
  indexing_strategy: IndexingStrategySchema.optional(),
  wiki_config: WikiConfigSchema.optional(),
});

export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceSchema>;

export const WorkspaceMemberSchema = z.object({
  id: z.number(),
  workspace_id: z.string().uuid(),
  user_id: z.number(),
  role: z.enum(["admin", "editor", "viewer"]),
  created_at: z.string().datetime(),
});

export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;

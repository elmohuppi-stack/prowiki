import { z } from "zod";

export const ChatSessionSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid().nullable(),
  user_id: z.number(),
  title: z.string().nullable(),
  model_id: z.string().uuid().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type ChatSession = z.infer<typeof ChatSessionSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string().uuid(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  knowledge_refs: z.array(z.any()).default([]),
  created_at: z.string().datetime(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  session_id: z.string().uuid().optional(),
  workspace_id: z.string().uuid().optional(),
  message: z.string().min(1),
  model_id: z.string().uuid().optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

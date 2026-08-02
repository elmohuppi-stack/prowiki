import { z } from "zod";

export type ProviderType = "chat" | "embedding" | "both";

export const ModelProviderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(255),
  provider_type: z.enum(["chat", "embedding", "both"]),
  api_base_url: z.string().max(512),
  api_key_preview: z.string().max(20), // Nur letzten 4 Zeichen
  default_model: z.string().max(255),
  is_active: z.boolean().default(true),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const CreateModelProviderSchema = z.object({
  name: z.string().min(1).max(255),
  provider_type: z.enum(["chat", "embedding", "both"]),
  api_base_url: z.string().max(512),
  api_key: z.string().min(1),
  default_model: z.string().min(1).max(255),
  is_active: z.boolean().default(true),
});

export type CreateModelProviderInput = z.infer<
  typeof CreateModelProviderSchema
>;

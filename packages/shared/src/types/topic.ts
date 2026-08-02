import { z } from "zod";

// Thema pro Workspace (Ebene 1). First-Class, editierbar.
export const TopicSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  slug: z.string(),
  label: z.string(),
  description: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  sort_order: z.number().default(0),
  created_at: z.string().datetime(),
  // Optional angereichert: Anzahl zugeordneter Dokumente (für die Verwaltung/Chips).
  doc_count: z.number().optional(),
});

export type Topic = z.infer<typeof TopicSchema>;

// Ein vom LLM vorgeschlagenes Thema (noch nicht persistiert).
export const TopicSuggestionSchema = z.object({
  label: z.string(),
  slug: z.string(),
  description: z.string().optional(),
});

export type TopicSuggestion = z.infer<typeof TopicSuggestionSchema>;

export const TopicAssignmentSource = z.enum(["auto", "manual"]);
export type TopicAssignmentSource = z.infer<typeof TopicAssignmentSource>;

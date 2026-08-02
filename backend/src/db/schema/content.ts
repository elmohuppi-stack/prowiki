/**
 * Inhalte: Quellen, Chunks, Wiki-Seiten, Chat. Übernommen aus knora mit drei
 * durchgehenden Änderungen:
 *
 *   1. `workspace_id` → `wiki_id` (die Ebene heißt jetzt Wiki, siehe tenancy.ts)
 *   2. Nutzer-IDs sind `text` statt `serial`, weil Better Auth so vergibt
 *   3. neu: `documents.external_id` (Deduplizierung) und `transcript_segments`
 *      (Zeitmarken, Entscheidung 2 in docs/KONZEPT.md)
 */
import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  vector,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { wikis, modelProviders } from "./tenancy.ts";

export const documents = pgTable(
  "documents",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    wiki_id: varchar("wiki_id", { length: 36 })
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 512 }).notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    source: text("source").notNull(),
    source_url: text("source_url"),
    /**
     * Stabile Kennung beim Anbieter — bei YouTube die elfstellige Video-ID.
     * Der Unique-Index darauf ist der Grund, warum ein zweiter Import desselben
     * Kanals nichts kostet: in knora hatte `source_url` keinen Index, ein
     * doppelter Import erzeugte Duplikate samt doppelter Embedding- und
     * LLM-Kosten (Befund 3.4).
     */
    external_id: varchar("external_id", { length: 128 }),
    content: text("content"),
    file_path: text("file_path"),
    file_size: integer("file_size"),
    file_hash: varchar("file_hash", { length: 64 }),
    parse_status: varchar("parse_status", { length: 20 })
      .default("pending")
      .notNull(),
    parse_error: text("parse_error"),
    chunk_count: integer("chunk_count").default(0).notNull(),
    channel: varchar("channel", { length: 255 }),
    published_at: timestamp("published_at"),
    duration: integer("duration"),
    source_metadata: jsonb("source_metadata").default({}).notNull(),
    created_by: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
    processed_at: timestamp("processed_at"),
  },
  (t) => [
    uniqueIndex("documents_wiki_external_unique").on(t.wiki_id, t.external_id),
    index("documents_wiki_idx").on(t.wiki_id),
    index("documents_channel_idx").on(t.channel),
  ],
);

/**
 * Transkript in Segmenten mit Zeitmarken — die Grundlage für tiefe Video-Links
 * (`?t=1234`) aus jedem Artikelabsatz heraus.
 *
 * knora verwarf diese Daten: `buildDocumentContent()` plattete das Transkript zu
 * Fließtext und die Segmentzeiten der Provider gingen verloren (Befund 3.5).
 * Nachrüsten hätte bedeutet, alle Transkripte erneut zu holen — bei Apify mit
 * erneuten Kosten. Deshalb steht die Tabelle vor dem ersten großen Import.
 */
export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: serial("id").primaryKey(),
    document_id: varchar("document_id", { length: 36 })
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    wiki_id: varchar("wiki_id", { length: 36 })
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    segment_index: integer("segment_index").notNull(),
    start_ms: integer("start_ms").notNull(),
    end_ms: integer("end_ms"),
    text: text("text").notNull(),
    // Für Interview-Formate, sobald ein Provider Diarisierung liefert.
    speaker: varchar("speaker", { length: 255 }),
  },
  (t) => [
    uniqueIndex("transcript_segments_doc_index_unique").on(
      t.document_id,
      t.segment_index,
    ),
    index("transcript_segments_doc_time_idx").on(t.document_id, t.start_ms),
  ],
);

export const topics = pgTable(
  "topics",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    wiki_id: varchar("wiki_id", { length: 36 })
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 255 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    description: text("description"),
    color: varchar("color", { length: 20 }),
    sort_order: integer("sort_order").default(0).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("topics_wiki_slug_unique").on(t.wiki_id, t.slug)],
);

export const documentTopics = pgTable(
  "document_topics",
  {
    id: serial("id").primaryKey(),
    document_id: varchar("document_id", { length: 36 })
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    topic_id: varchar("topic_id", { length: 36 })
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    source: varchar("source", { length: 20 }).default("auto").notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("document_topics_unique").on(t.document_id, t.topic_id)],
);

export const chunks = pgTable(
  "chunks",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    // 64 statt 36: Wiki-Chunks nutzen ein "wiki--<uuid>"-Präfix.
    document_id: varchar("document_id", { length: 64 }),
    wiki_id: varchar("wiki_id", { length: 36 })
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    chunk_index: integer("chunk_index").notNull(),
    token_count: integer("token_count").default(0).notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    // Zeitfenster im Quellvideo, aus dem dieser Chunk stammt — damit eine
    // Chat-Antwort nicht nur das Video, sondern die Stelle belegen kann.
    start_ms: integer("start_ms"),
    end_ms: integer("end_ms"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("chunks_wiki_idx").on(t.wiki_id)],
);

export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    wiki_id: varchar("wiki_id", { length: 36 })
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 255 }).notNull(),
    title: varchar("title", { length: 512 }).notNull(),
    summary: text("summary").notNull().default(""),
    content: text("content").notNull().default(""),
    page_type: varchar("page_type", { length: 20 })
      .default("article")
      .notNull(),
    // draft | review | published — der Freigabe-Workflow aus KONZEPT 5.2.
    status: varchar("status", { length: 20 }).default("published").notNull(),
    source_document_id: varchar("source_document_id", {
      length: 36,
    }).references(() => documents.id, { onDelete: "set null" }),
    parent_slug: varchar("parent_slug", { length: 255 }),
    sort_order: integer("sort_order").default(0).notNull(),
    out_links: jsonb("out_links").default([]).notNull(),
    in_links: jsonb("in_links").default([]).notNull(),
    aliases: jsonb("aliases").default([]).notNull(),
    source_refs: jsonb("source_refs").default([]).notNull(),
    chunk_refs: jsonb("chunk_refs").default([]).notNull(),
    page_metadata: jsonb("page_metadata").default({}).notNull(),
    // Kennzeichnung generierter Inhalte (KONZEPT 5.5, Punkt 19).
    generated_by_ai: boolean("generated_by_ai").default(false).notNull(),
    generated_at: timestamp("generated_at"),
    version: integer("version").default(1).notNull(),
    created_by: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    updated_by: text("updated_by").references(() => user.id, {
      onDelete: "set null",
    }),
    manually_edited: boolean("manually_edited").default(false).notNull(),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("wiki_pages_wiki_slug_unique").on(t.wiki_id, t.slug),
    index("wiki_pages_parent_idx").on(t.wiki_id, t.parent_slug),
    index("wiki_pages_status_idx").on(t.wiki_id, t.status),
  ],
);

export const wikiPageRevisions = pgTable("wiki_page_revisions", {
  id: serial("id").primaryKey(),
  page_id: varchar("page_id", { length: 36 })
    .notNull()
    .references(() => wikiPages.id, { onDelete: "cascade" }),
  wiki_id: varchar("wiki_id", { length: 36 })
    .notNull()
    .references(() => wikis.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  title: varchar("title", { length: 512 }).notNull(),
  summary: text("summary").notNull().default(""),
  content: text("content").notNull().default(""),
  edited_by: text("edited_by").references(() => user.id, {
    onDelete: "set null",
  }),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

export const chatSessions = pgTable("chat_sessions", {
  id: varchar("id", { length: 36 }).primaryKey(),
  wiki_id: varchar("wiki_id", { length: 36 }).references(() => wikis.id, {
    onDelete: "cascade",
  }),
  // Null bei anonymem Chat auf einem öffentlichen Wiki. Dann greift statt der
  // Nutzerbindung die Kostengrenze aus usage_events.
  user_id: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  anonymous_id: varchar("anonymous_id", { length: 64 }),
  title: varchar("title", { length: 255 }),
  model_id: varchar("model_id", { length: 36 }).references(
    () => modelProviders.id,
  ),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

export const chatMessages = pgTable("chat_messages", {
  id: varchar("id", { length: 36 }).primaryKey(),
  session_id: varchar("session_id", { length: 36 })
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 20 }).notNull(),
  content: text("content").notNull(),
  knowledge_refs: jsonb("knowledge_refs").default([]).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

/** Fachliches Ereignisprotokoll (Importe, Wiki-Läufe). Sicherheitsereignisse
 *  stehen getrennt in `audit_events`. */
export const activityLogs = pgTable("activity_logs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  action: varchar("action", { length: 100 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("started"),
  message: text("message").notNull().default(""),
  details: jsonb("details").default({}).notNull(),
  wiki_id: varchar("wiki_id", { length: 36 }).references(() => wikis.id, {
    onDelete: "cascade",
  }),
  document_id: varchar("document_id", { length: 36 }).references(
    () => documents.id,
    { onDelete: "set null" },
  ),
  user_id: text("user_id").references(() => user.id, { onDelete: "set null" }),
  duration_ms: integer("duration_ms"),
  created_at: timestamp("created_at").defaultNow().notNull(),
});

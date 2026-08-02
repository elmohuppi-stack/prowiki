/**
 * Mandantenfähigkeit: Wikis unter Organisationen, Sichtbarkeit, Zählung, Audit.
 *
 * Die Ebene `organization` liegt in schema/auth.ts, weil Better Auth sie
 * verwaltet. Alles hier darunter ist prowiki-eigen.
 *
 *   organization  Abrechnungs- und Vertrauensgrenze   (auth.ts)
 *     └─ wiki     was in knora "workspace" hieß
 *          └─ page   wiki_pages, siehe content.ts
 */
import {
  pgTable,
  text,
  varchar,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.ts";

/** private = nur Mitglieder · link = wer die URL hat · public = indexierbar */
export const WIKI_VISIBILITIES = ["private", "link", "public"] as const;
export type WikiVisibility = (typeof WIKI_VISIBILITIES)[number];

/**
 * Wiki-Tiefe: steuert das Verhältnis von Kosten zu Detailtiefe bei der
 * Generierung. `capped` ist der Default — Entity/Concept-Seiten gedeckelt.
 */
export const WIKI_DEPTHS = ["full", "capped", "summary", "off"] as const;
export type WikiDepth = (typeof WIKI_DEPTHS)[number];

export interface WikiConfig {
  auto_ingest: boolean;
  synthesis_model_id: string | null;
  wiki_language: string;
  max_pages_per_ingest: number;
  extraction_granularity: string;
  wiki_depth: WikiDepth;
}

export interface IndexingStrategy {
  vector_enabled: boolean;
  keyword_enabled: boolean;
  wiki_enabled: boolean;
  graph_enabled: boolean;
}

export const modelProviders = pgTable("model_providers", {
  id: varchar("id", { length: 36 }).primaryKey(),
  // null = Plattform-Provider (von uns gestellt), sonst der eigene Schlüssel
  // der Organisation ("bring your own key", Tarifmerkmal aus KONZEPT 5.4).
  organization_id: text("organization_id").references(() => organization.id, {
    onDelete: "cascade",
  }),
  name: varchar("name", { length: 255 }).notNull(),
  provider_type: varchar("provider_type", { length: 20 }).notNull(),
  api_base_url: varchar("api_base_url", { length: 512 }).notNull(),
  api_key_encrypted: text("api_key_encrypted").notNull(),
  default_model: varchar("default_model", { length: 255 }).notNull(),
  is_active: boolean("is_active").default(true).notNull(),
  created_at: timestamp("created_at").defaultNow().notNull(),
  updated_at: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Ein Wiki — in knora `workspaces`. Neu sind `organization_id` (Mandant),
 * `visibility` und `anonymous_chat_enabled`.
 */
export const wikis = pgTable(
  "wikis",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    organization_id: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Adressraum: /<org-slug>/<wiki-slug>/<page-slug>. Eindeutig je Organisation,
    // nicht global — zwei Kunden dürfen beide ein Wiki "archiv" haben.
    slug: varchar("slug", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),

    visibility: varchar("visibility", { length: 20 })
      .notNull()
      .default("private"),
    // Anonymer Chat auf öffentlichen Wikis kostet echtes Geld pro Frage und ist
    // deshalb nicht Teil von `public`, sondern einzeln zu schalten (siehe
    // ANONYMOUS_CAPABILITIES in auth/permissions.ts).
    anonymous_chat_enabled: boolean("anonymous_chat_enabled")
      .default(false)
      .notNull(),
    custom_domain: varchar("custom_domain", { length: 255 }),

    chunk_size: integer("chunk_size").default(512).notNull(),
    chunk_overlap: integer("chunk_overlap").default(50).notNull(),
    embedding_model_id: varchar("embedding_model_id", { length: 36 }).references(
      () => modelProviders.id,
    ),
    chat_model_id: varchar("chat_model_id", { length: 36 }).references(
      () => modelProviders.id,
    ),
    indexing_strategy: jsonb("indexing_strategy").$type<IndexingStrategy>().notNull().default({
      vector_enabled: true,
      keyword_enabled: true,
      wiki_enabled: false,
      graph_enabled: false,
    }),
    wiki_config: jsonb("wiki_config").$type<WikiConfig>().default({
      auto_ingest: false,
      synthesis_model_id: null,
      wiki_language: "de",
      max_pages_per_ingest: 10,
      extraction_granularity: "standard",
      wiki_depth: "capped",
    }),

    created_by: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    created_at: timestamp("created_at").defaultNow().notNull(),
    updated_at: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("wikis_org_slug_unique").on(t.organization_id, t.slug),
    uniqueIndex("wikis_custom_domain_unique").on(t.custom_domain),
    index("wikis_visibility_idx").on(t.visibility),
  ],
);

/**
 * Override der Organisationsrolle für ein einzelnes Wiki. Ohne Zeile hier gilt
 * die Rolle aus `member`. Erlaubt beides: jemandem in genau einem Wiki mehr
 * Rechte geben (Gastautor) oder weniger (Praktikant sieht nur ein Wiki).
 */
export const wikiMembers = pgTable(
  "wiki_members",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    wiki_id: varchar("wiki_id", { length: 36 })
      .notNull()
      .references(() => wikis.id, { onDelete: "cascade" }),
    user_id: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 20 }).notNull().default("viewer"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("wiki_members_unique").on(t.wiki_id, t.user_id),
    index("wiki_members_user_idx").on(t.user_id),
  ],
);

/**
 * Kostenzählung je Organisation (KONZEPT 4.5). knora protokollierte nur
 * `duration_ms` — niemand konnte sagen, was ein Import gekostet hat. Ohne diese
 * Tabelle ist kein Tarif und kein anonymer Chat kalkulierbar.
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    organization_id: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    wiki_id: varchar("wiki_id", { length: 36 }).references(() => wikis.id, {
      onDelete: "set null",
    }),
    // llm_chat | llm_wiki_generate | embedding | transcript_fetch | …
    kind: varchar("kind", { length: 50 }).notNull(),
    model: varchar("model", { length: 255 }),
    tokens_in: integer("tokens_in").default(0).notNull(),
    tokens_out: integer("tokens_out").default(0).notNull(),
    // Millionstel Euro als Ganzzahl — Gleitkomma für Geld führt beim Aufsummieren
    // über Zehntausende Zeilen zu Rundungsdrift.
    cost_micros: bigint("cost_micros", { mode: "number" }).default(0).notNull(),
    ref_id: varchar("ref_id", { length: 64 }),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("usage_events_org_time_idx").on(t.organization_id, t.created_at),
    index("usage_events_kind_idx").on(t.kind),
  ],
);

/**
 * Sicherheitsrelevante Ereignisse — getrennt von `activity_logs`, das Importe
 * und Wiki-Läufe protokolliert. Hier stehen Anmeldungen, Rollenwechsel,
 * Freigaben, Löschungen (Befund 2.8). Wird nie aus der Anwendung heraus
 * gelöscht.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    organization_id: text("organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
    actor_id: text("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Auch bei gelöschtem Nutzer nachvollziehbar, wer gehandelt hat.
    actor_email: varchar("actor_email", { length: 255 }),
    action: varchar("action", { length: 100 }).notNull(),
    target_type: varchar("target_type", { length: 50 }),
    target_id: varchar("target_id", { length: 64 }),
    details: jsonb("details").default({}).notNull(),
    ip_address: varchar("ip_address", { length: 64 }),
    user_agent: text("user_agent"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("audit_events_org_time_idx").on(t.organization_id, t.created_at),
    index("audit_events_actor_idx").on(t.actor_id),
    index("audit_events_action_idx").on(t.action),
  ],
);

/**
 * API-Schlüssel je Organisation (KONZEPT 5.2, Punkt 12). Gespeichert wird nur
 * der Hash — ein Klartextschlüssel in der Datenbank wäre bei einem Dump-Leck
 * sofort verwertbar.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    organization_id: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    key_hash: varchar("key_hash", { length: 128 }).notNull().unique(),
    // Nur zum Wiedererkennen in der Oberfläche ("pk_live_…a3f9").
    key_prefix: varchar("key_prefix", { length: 16 }).notNull(),
    scopes: jsonb("scopes").default([]).notNull(),
    created_by: text("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    last_used_at: timestamp("last_used_at"),
    expires_at: timestamp("expires_at"),
    revoked_at: timestamp("revoked_at"),
    created_at: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("api_keys_org_idx").on(t.organization_id)],
);

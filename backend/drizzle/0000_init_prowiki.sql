-- HANDGRIFF AN EINER GENERIERTEN DATEI — bitte beim nächsten `drizzle-kit
-- generate` nicht wegräumen.
--
-- Drizzle erzeugt für die Spalte `chunks.embedding` den Typ `vector(1536)`,
-- legt die Extension aber nicht an. Auf einer frischen Datenbank scheitert die
-- Migration deshalb mit „type vector does not exist". Auf einer gewachsenen
-- Instanz fällt das nie auf, weil die Extension dort längst steht — genau das
-- Muster, das in knora dazu führte, dass der HNSW-Index monatelang nur als
-- Kommentar existierte (optimize-hetzner/ARCHITEKTUR.md 7.1).
--
-- `pg_trgm` wird in 0001 für den Trigramm-Index auf Titeln gebraucht.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"key_hash" varchar(128) NOT NULL,
	"key_prefix" varchar(16) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"last_used_at" timestamp,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"organization_id" text,
	"actor_id" text,
	"actor_email" varchar(255),
	"action" varchar(100) NOT NULL,
	"target_type" varchar(50),
	"target_id" varchar(64),
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" varchar(64),
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"organization_id" text,
	"name" varchar(255) NOT NULL,
	"provider_type" varchar(20) NOT NULL,
	"api_base_url" varchar(512) NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"default_model" varchar(255) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"wiki_id" varchar(36),
	"kind" varchar(50) NOT NULL,
	"model" varchar(255),
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"ref_id" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_members" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"wiki_id" varchar(36) NOT NULL,
	"user_id" text NOT NULL,
	"role" varchar(20) DEFAULT 'viewer' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wikis" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"slug" varchar(255) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"visibility" varchar(20) DEFAULT 'private' NOT NULL,
	"anonymous_chat_enabled" boolean DEFAULT false NOT NULL,
	"custom_domain" varchar(255),
	"chunk_size" integer DEFAULT 512 NOT NULL,
	"chunk_overlap" integer DEFAULT 50 NOT NULL,
	"embedding_model_id" varchar(36),
	"chat_model_id" varchar(36),
	"indexing_strategy" jsonb DEFAULT '{"vector_enabled":true,"keyword_enabled":true,"wiki_enabled":false,"graph_enabled":false}'::jsonb NOT NULL,
	"wiki_config" jsonb DEFAULT '{"auto_ingest":false,"synthesis_model_id":null,"wiki_language":"de","max_pages_per_ingest":10,"extraction_granularity":"standard","wiki_depth":"capped"}'::jsonb,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"action" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'started' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"wiki_id" varchar(36),
	"document_id" varchar(36),
	"user_id" text,
	"duration_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"role" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"knowledge_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"wiki_id" varchar(36),
	"user_id" text,
	"anonymous_id" varchar(64),
	"title" varchar(255),
	"model_id" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"document_id" varchar(64),
	"wiki_id" varchar(36) NOT NULL,
	"content" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"embedding" vector(1536),
	"start_ms" integer,
	"end_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" varchar(36) NOT NULL,
	"topic_id" varchar(36) NOT NULL,
	"source" varchar(20) DEFAULT 'auto' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"wiki_id" varchar(36) NOT NULL,
	"title" varchar(512) NOT NULL,
	"type" varchar(50) NOT NULL,
	"source" text NOT NULL,
	"source_url" text,
	"external_id" varchar(128),
	"content" text,
	"file_path" text,
	"file_size" integer,
	"file_hash" varchar(64),
	"parse_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"parse_error" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"channel" varchar(255),
	"published_at" timestamp,
	"duration" integer,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"wiki_id" varchar(36) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"label" varchar(255) NOT NULL,
	"description" text,
	"color" varchar(20),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" varchar(36) NOT NULL,
	"wiki_id" varchar(36) NOT NULL,
	"segment_index" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer,
	"text" text NOT NULL,
	"speaker" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "wiki_page_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" varchar(36) NOT NULL,
	"wiki_id" varchar(36) NOT NULL,
	"version" integer NOT NULL,
	"title" varchar(512) NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"edited_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wiki_pages" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"wiki_id" varchar(36) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"title" varchar(512) NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"page_type" varchar(20) DEFAULT 'article' NOT NULL,
	"status" varchar(20) DEFAULT 'published' NOT NULL,
	"source_document_id" varchar(36),
	"parent_slug" varchar(255),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"out_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"in_links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chunk_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"page_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_by_ai" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"manually_edited" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_members" ADD CONSTRAINT "wiki_members_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_members" ADD CONSTRAINT "wiki_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wikis" ADD CONSTRAINT "wikis_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wikis" ADD CONSTRAINT "wikis_embedding_model_id_model_providers_id_fk" FOREIGN KEY ("embedding_model_id") REFERENCES "public"."model_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wikis" ADD CONSTRAINT "wikis_chat_model_id_model_providers_id_fk" FOREIGN KEY ("chat_model_id") REFERENCES "public"."model_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wikis" ADD CONSTRAINT "wikis_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_model_id_model_providers_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_topics" ADD CONSTRAINT "document_topics_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_topics" ADD CONSTRAINT "document_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_revisions" ADD CONSTRAINT "wiki_page_revisions_page_id_wiki_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_revisions" ADD CONSTRAINT "wiki_page_revisions_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_page_revisions" ADD CONSTRAINT "wiki_page_revisions_edited_by_user_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD CONSTRAINT "wiki_pages_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "member_org_user_unique" ON "member" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "member_user_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "audit_events_org_time_idx" ON "audit_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_events_action_idx" ON "audit_events" USING btree ("action");--> statement-breakpoint
CREATE INDEX "usage_events_org_time_idx" ON "usage_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_kind_idx" ON "usage_events" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_members_unique" ON "wiki_members" USING btree ("wiki_id","user_id");--> statement-breakpoint
CREATE INDEX "wiki_members_user_idx" ON "wiki_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wikis_org_slug_unique" ON "wikis" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "wikis_custom_domain_unique" ON "wikis" USING btree ("custom_domain");--> statement-breakpoint
CREATE INDEX "wikis_visibility_idx" ON "wikis" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "chunks_wiki_idx" ON "chunks" USING btree ("wiki_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_topics_unique" ON "document_topics" USING btree ("document_id","topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_wiki_external_unique" ON "documents" USING btree ("wiki_id","external_id");--> statement-breakpoint
CREATE INDEX "documents_wiki_idx" ON "documents" USING btree ("wiki_id");--> statement-breakpoint
CREATE INDEX "documents_channel_idx" ON "documents" USING btree ("channel");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_wiki_slug_unique" ON "topics" USING btree ("wiki_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segments_doc_index_unique" ON "transcript_segments" USING btree ("document_id","segment_index");--> statement-breakpoint
CREATE INDEX "transcript_segments_doc_time_idx" ON "transcript_segments" USING btree ("document_id","start_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "wiki_pages_wiki_slug_unique" ON "wiki_pages" USING btree ("wiki_id","slug");--> statement-breakpoint
CREATE INDEX "wiki_pages_parent_idx" ON "wiki_pages" USING btree ("wiki_id","parent_slug");--> statement-breakpoint
CREATE INDEX "wiki_pages_status_idx" ON "wiki_pages" USING btree ("wiki_id","status");
ALTER TABLE "workspaces" ALTER COLUMN "wiki_config" SET DEFAULT '{"auto_ingest":false,"synthesis_model_id":null,"wiki_language":"de","max_pages_per_ingest":10,"extraction_granularity":"standard","wiki_depth":"capped"}'::jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "channel" varchar(255);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "published_at" timestamp;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "duration" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_channel_idx" ON "documents" USING btree ("channel");
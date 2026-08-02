CREATE TABLE "document_topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" varchar(36) NOT NULL,
	"topic_id" varchar(36) NOT NULL,
	"source" varchar(20) DEFAULT 'auto' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(36) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"label" varchar(255) NOT NULL,
	"description" text,
	"color" varchar(20),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_topics" ADD CONSTRAINT "document_topics_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_topics" ADD CONSTRAINT "document_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "unique_document_topic" ON "document_topics" USING btree ("document_id","topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "unique_workspace_topic_slug" ON "topics" USING btree ("workspace_id","slug");
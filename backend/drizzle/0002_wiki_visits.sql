-- Handgeschriebene Migration (wie 0001): `drizzle-kit generate` ist in diesem
-- Repo nicht benutzbar, weil 0000 und 0001 auf denselben Vorgänger-Snapshot
-- zeigen. `drizzle-kit migrate` liest nur Journal und SQL und ist davon nicht
-- betroffen.
--
-- Zweck: „zuletzt verwendet" als Vorgabesortierung der Wiki-Übersicht.
-- Eine Zeile je (Nutzer, Wiki), per Upsert überschrieben — kein Verlauf,
-- damit die Tabelle nicht mit jedem Seitenaufruf wächst.

CREATE TABLE "wiki_visits" (
	"user_id" text NOT NULL,
	"wiki_id" varchar(36) NOT NULL,
	"last_opened_at" timestamp DEFAULT now() NOT NULL,
	"visit_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_visits" ADD CONSTRAINT "wiki_visits_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wiki_visits" ADD CONSTRAINT "wiki_visits_wiki_id_wikis_id_fk" FOREIGN KEY ("wiki_id") REFERENCES "public"."wikis"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Ziel des ON CONFLICT in touchWiki – ohne diesen Index schlüge der Upsert fehl.
CREATE UNIQUE INDEX "wiki_visits_user_wiki_unique" ON "wiki_visits" USING btree ("user_id","wiki_id");--> statement-breakpoint
CREATE INDEX "wiki_visits_user_time_idx" ON "wiki_visits" USING btree ("user_id","last_opened_at");

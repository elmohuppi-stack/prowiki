ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "parent_slug" varchar(255);--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wiki_pages_parent_idx" ON "wiki_pages" USING btree ("workspace_id","parent_slug");--> statement-breakpoint
-- Backfill: bereits generierte Kapitel-Artikel tragen ihre Herkunft im Slug
-- ("<basis>-k<N>"). Daraus die Hierarchie ableiten, damit bestehende Wikis die
-- neue Baum-Darstellung ohne Neu-Generierung bekommen. Nur Kapitel, deren
-- Übersichtsseite (Basis-Slug) tatsächlich existiert.
UPDATE "wiki_pages" AS c
SET "parent_slug" = regexp_replace(c."slug", '-k[0-9]+$', ''),
    "sort_order" = (regexp_match(c."slug", '-k([0-9]+)$'))[1]::int
WHERE c."slug" ~ '-k[0-9]+$'
  AND c."page_type" = 'summary'
  AND c."parent_slug" IS NULL
  AND EXISTS (
    SELECT 1 FROM "wiki_pages" AS p
    WHERE p."workspace_id" = c."workspace_id"
      AND p."slug" = regexp_replace(c."slug", '-k[0-9]+$', '')
  );

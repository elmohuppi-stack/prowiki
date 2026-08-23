-- Handgeschriebene Migration (wie 0001 und 0002): `drizzle-kit generate` ist in
-- diesem Repo nicht benutzbar, weil 0000 und 0001 auf denselben Vorgänger-
-- Snapshot zeigen. `drizzle-kit migrate` liest nur Journal und SQL.
--
-- Zweck: die Kostenzählung genauer machen und auswertbar.
--
-- 1. `tokens_cached` — DeepSeek berechnet Eingabetokens, die im Prompt-Cache
--    lagen, mit rund einem Dreißigstel des Preises. Bei der Wiki-Generierung
--    geht dasselbe Transkript mehrfach an das Modell; ohne diese Spalte wird
--    jeder dieser Läufe zum vollen Preis angesetzt und die Summe ist um ein
--    Vielfaches zu hoch. Das Feld steht in der Antwort (`prompt_cache_hit_tokens`),
--    es war nur nie gelesen worden.
--
-- 2. `price_version` — welcher Stand der Preistabelle einen Posten bewertet hat.
--    Ohne das lässt sich nach einer Preisänderung nicht mehr sagen, ob eine alte
--    Zeile mit den damaligen oder den heutigen Zahlen gerechnet wurde.
--
-- 3. Zwei Indizes für die Auswertung: die Kosten je Eingangsdokument gehen über
--    `ref_id`, die Wiki-Übersicht über `(wiki_id, created_at)`. Beides gab es
--    bisher nicht — vorhanden waren nur `(organization_id, created_at)` und `kind`.

ALTER TABLE "usage_events" ADD COLUMN "tokens_cached" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "price_version" varchar(20);--> statement-breakpoint
CREATE INDEX "usage_events_ref_idx" ON "usage_events" USING btree ("ref_id");--> statement-breakpoint
CREATE INDEX "usage_events_wiki_time_idx" ON "usage_events" USING btree ("wiki_id","created_at");

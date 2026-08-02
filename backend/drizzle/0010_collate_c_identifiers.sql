-- ---------------------------------------------------------------------------
-- Technische Identifikatoren auf COLLATE "C"
-- ---------------------------------------------------------------------------
--
-- Hintergrund: Ein Wechsel der glibc-Version ändert die Sortierreihenfolge von
-- Text. Ein B-Tree, der unter der alten Ordnung gebaut wurde, ist danach falsch
-- sortiert – spätere INSERTs suchen unter der neuen Ordnung, laufen am
-- vorhandenen Schlüssel vorbei und legen Duplikate an, TROTZ gültigem
-- UNIQUE-Constraint. Genau das ist in der Nachbar-App mediathek auf diesem
-- Server passiert (zwei beschädigte Indexe, vier Duplikate), ausgelöst durch
-- ein Postgres-Image-Update.
--
-- COLLATE "C" bedeutet byteweisen Vergleich. Der ist von der Systembibliothek
-- unabhängig und damit gegen diesen Fehler immun. Bei einem Slug, einem
-- Session-Token oder einer E-Mail-Adresse als Schlüssel ist sprachabhängige
-- Sortierung ohnehin bedeutungslos.
--
-- Geprüft: Im Code wird nach title, created_at und sort_order sortiert, nicht
-- nach diesen Spalten – die geänderte Sortierreihenfolge (Großbuchstaben vor
-- Kleinbuchstaben) wirkt sich daher nicht auf Ausgaben aus.
--
-- BEWUSST NICHT umgestellt sind die varchar(36)-Id-Spalten (id, workspace_id,
-- document_id …). Sie tragen dasselbe theoretische Risiko, aber eine
-- Typänderung schreibt die Tabelle komplett neu – bei chunks wären das 1,2 GB
-- unter einem ACCESS EXCLUSIVE-Lock auf einem Host mit 3,7 GB RAM. Der Aufwand
-- lohnt nicht: die Indexe auf chunks sind klein (1,5 MB btree, der 541-MB-HNSW
-- ist ein Vektorindex und nicht collation-abhängig), ein REINDEX nach einem
-- glibc-Wechsel ist dort also billig. Für diese Spalten gilt Heilung
-- (amcheck + REINDEX) statt Vorbeugung.
--
-- Postgres baut die abhängigen Indexe bei ALTER COLUMN TYPE selbst neu.

ALTER TABLE wiki_pages ALTER COLUMN slug        TYPE varchar(255) COLLATE "C";
ALTER TABLE wiki_pages ALTER COLUMN parent_slug TYPE varchar(255) COLLATE "C";
ALTER TABLE topics     ALTER COLUMN slug        TYPE varchar(255) COLLATE "C";
ALTER TABLE users      ALTER COLUMN email       TYPE varchar(255) COLLATE "C";
ALTER TABLE sessions   ALTER COLUMN token       TYPE varchar(255) COLLATE "C";

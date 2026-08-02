-- Handgeschriebene Migration. Zwei Dinge, die Drizzle nicht aus dem Schema
-- ableiten kann und die deshalb in knora erst nachträglich entstanden sind —
-- hier von Anfang an dabei.
--
-- Die Tabellen sind an dieser Stelle leer, alle Operationen laufen daher sofort.

-- ---------------------------------------------------------------------------
-- 1. COLLATE "C" für technische Identifikatoren
-- ---------------------------------------------------------------------------
--
-- Warum: In der Nachbar-App mediathek hat ein Postgres-Image-Wechsel die
-- glibc-Version mitgezogen und damit die Sortierordnung geändert. Zwei B-Tree-
-- Indexe waren unter der alten Ordnung gebaut, spätere INSERTs suchten unter der
-- neuen, liefen am vorhandenen Schlüssel vorbei und legten Duplikate an —
-- **trotz gültigem UNIQUE-Constraint**. Unbemerkt blieb es, weil
-- `datcollversion` leer war und Postgres nicht warnen konnte.
--
-- `COLLATE "C"` heißt byteweiser Vergleich: unabhängig von der Systembibliothek
-- und damit immun gegen genau diesen Fehler. Bei einem Slug, einem Token oder
-- einer E-Mail-Adresse als Schlüssel ist sprachabhängige Sortierung ohnehin
-- bedeutungslos.
--
-- Auslöser ist der Wechsel des **Images**, nicht ein glibc-Update auf dem Host:
-- Postgres benutzt die glibc des Containers.
-- Siehe optimize-hetzner/ARCHITEKTUR.md 7.3.

-- Better-Auth-Schlüssel
ALTER TABLE "user"    ALTER COLUMN "email" TYPE text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "session" ALTER COLUMN "token" TYPE text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "organization" ALTER COLUMN "slug" TYPE text COLLATE "C";
--> statement-breakpoint
ALTER TABLE "invitation"   ALTER COLUMN "email" TYPE text COLLATE "C";
--> statement-breakpoint

-- Adressraum: /<org-slug>/<wiki-slug>/<page-slug>
ALTER TABLE "wikis"      ALTER COLUMN "slug" TYPE varchar(255) COLLATE "C";
--> statement-breakpoint
ALTER TABLE "wiki_pages" ALTER COLUMN "slug" TYPE varchar(255) COLLATE "C";
--> statement-breakpoint
ALTER TABLE "wiki_pages" ALTER COLUMN "parent_slug" TYPE varchar(255) COLLATE "C";
--> statement-breakpoint
ALTER TABLE "topics"     ALTER COLUMN "slug" TYPE varchar(255) COLLATE "C";
--> statement-breakpoint

-- Deduplizierungsschlüssel und Kundendomäne
ALTER TABLE "documents" ALTER COLUMN "external_id" TYPE varchar(128) COLLATE "C";
--> statement-breakpoint
ALTER TABLE "wikis"     ALTER COLUMN "custom_domain" TYPE varchar(255) COLLATE "C";
--> statement-breakpoint
ALTER TABLE "api_keys"  ALTER COLUMN "key_hash" TYPE varchar(128) COLLATE "C";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Such- und Vektorindexe
-- ---------------------------------------------------------------------------
--
-- Diese Indexe gehören in die Migrationskette und nicht in einen Kommentar. In
-- knora stand der HNSW-Index auskommentiert in `0007_search_indexes.sql` mit dem
-- sachlich richtigen Hinweis, ihn nach dem Embedding-Lauf anzulegen — nur
-- geschah das nie. Jede semantische Suche las daraufhin 670 MB sequenziell:
-- 741 ms statt 12,4 ms, monatelang unbemerkt, weil nichts fehlschlug.
--
-- Ein aufgeschobener Schritt braucht einen Ort, an dem er sichtbar bleibt. Ein
-- SQL-Kommentar ist kein solcher Ort.

-- Volltext über Titel und Inhalt.
CREATE INDEX IF NOT EXISTS "wiki_pages_fts_idx" ON "wiki_pages"
  USING gin (to_tsvector('german', coalesce(title, '') || ' ' || coalesce(content, '')));
--> statement-breakpoint

-- Trigramm auf dem Titel. Ohne diesen Index fällt eine OR-Bedingung aus
-- Volltext und `ilike '%…%'` **komplett** auf einen Filter zurück, weil ein
-- führendes % nicht indexierbar ist — der Volltextindex greift dann nie. Genau
-- daran hing in knora eine Wiki-Suche mit 1.200 ms statt 1,45 ms.
CREATE INDEX IF NOT EXISTS "wiki_pages_title_trgm_idx" ON "wiki_pages"
  USING gin (title gin_trgm_ops);
--> statement-breakpoint

-- Auffälligkeiten-Facette. Abgefragt wird `page_metadata @> '{"flags":[…]}'`,
-- nicht `page_metadata -> 'flags' @> '[…]'`: eine ->-Extraktion links vom
-- Operator passt nicht zu einem Index über der ganzen Spalte und erzwingt einen
-- Seq Scan.
CREATE INDEX IF NOT EXISTS "wiki_pages_metadata_gin_idx" ON "wiki_pages"
  USING gin (page_metadata jsonb_path_ops);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "wiki_pages_out_links_gin_idx" ON "wiki_pages"
  USING gin (out_links jsonb_path_ops);
--> statement-breakpoint

-- Vektorindex. Die Ops-Klasse muss zum Distanzoperator der Anwendung passen:
-- `vector_cosine_ops` zu `<=>`. Ein Index mit falscher Klasse wird schlicht
-- nicht benutzt und fällt nur durch schlechte Laufzeiten auf.
--
-- Bewusst OHNE `CONCURRENTLY`: drizzle-kit führt jede Migration in einer
-- Transaktion aus, und `CREATE INDEX CONCURRENTLY` ist darin nicht erlaubt. Auf
-- einer leeren Tabelle ist das folgenlos. Wer den Index später auf einer
-- gefüllten Tabelle neu aufbauen muss, legt ihn vorher von Hand mit
-- CONCURRENTLY an — dank IF NOT EXISTS wird die Migration dann übersprungen.
--
-- Braucht `/dev/shm` > 64 MB (Docker-Default), sonst „could not resize shared
-- memory segment". Deshalb `shm_size: 1g` am Postgres-Container.
CREATE INDEX IF NOT EXISTS "chunks_embedding_hnsw_idx" ON "chunks"
  USING hnsw (embedding vector_cosine_ops);

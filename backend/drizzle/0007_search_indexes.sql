-- Indizes für Suche und Filterung.
--
-- Ausgangslage: die Tabelle `chunks` hatte AUSSER dem Primary Key keinen einzigen
-- Index. Das fällt erst bei größeren Beständen auf, dann aber hart:
--
--  * keywordSearch (service/search.ts) berechnet `to_tsvector('german', content)`
--    bei JEDER Chat-Nachricht für JEDEN Chunk des Workspace und scannt dabei die
--    ganze Tabelle. Bei einigen tausend Chunks sind das Megabytes Text pro Frage.
--  * vectorSearch berechnet ebenso alle Cosinus-Distanzen sequenziell.
--
-- Alle Anweisungen sind rein additiv (IF NOT EXISTS), alter Code läuft
-- unverändert weiter. Die Migration darf deshalb VOR dem Deploy laufen.

-- ---------------------------------------------------------------------------
-- chunks
-- ---------------------------------------------------------------------------

-- Jede Suche filtert zuerst auf den Workspace.
CREATE INDEX IF NOT EXISTS chunks_workspace_idx ON chunks USING btree (workspace_id);

-- Für das Auflösen von Zitaten und das Löschen/Neuschreiben je Dokument.
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks USING btree (document_id);

-- Volltextsuche. Der Ausdruck muss ZEICHENGLEICH dem in search.ts verwendeten
-- sein, sonst benutzt Postgres den Index nicht (Ausdrucksindex).
CREATE INDEX IF NOT EXISTS chunks_content_fts_idx
  ON chunks USING gin (to_tsvector('german', content));

-- Findet Chunks ohne Embedding – das ist die Kernabfrage von embed-backfill.ts
-- und embedWorkspaceChunks(), bisher ein Full Scan.
CREATE INDEX IF NOT EXISTS chunks_pending_embedding_idx
  ON chunks USING btree (workspace_id)
  WHERE embedding IS NULL;

-- ---------------------------------------------------------------------------
-- wiki_pages
-- ---------------------------------------------------------------------------

-- Deutsche Volltextsuche über Titel und Inhalt (ersetzt das frühere
-- case-sensitive LIKE '%…%' ohne Index in service/wiki.ts).
CREATE INDEX IF NOT EXISTS wiki_pages_fts_idx
  ON wiki_pages USING gin (
    to_tsvector('german', coalesce(title, '') || ' ' || coalesce(content, ''))
  );

-- Der Wiki-Browser filtert praktisch immer auf diese drei Spalten zusammen.
CREATE INDEX IF NOT EXISTS wiki_pages_type_status_idx
  ON wiki_pages USING btree (workspace_id, page_type, status);

-- Auffälligkeiten-Facette: page_metadata->'flags' @> '["…"]'
CREATE INDEX IF NOT EXISTS wiki_pages_metadata_gin_idx
  ON wiki_pages USING gin (page_metadata jsonb_path_ops);

-- Für die Backlink-Facette (out_links @> '["slug"]').
CREATE INDEX IF NOT EXISTS wiki_pages_out_links_gin_idx
  ON wiki_pages USING gin (out_links jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------

-- Sortierung und Zeitraumfilter laufen jetzt über das Sitzungs-/
-- Veröffentlichungsdatum statt über die Import-Zeit.
CREATE INDEX IF NOT EXISTS documents_workspace_published_idx
  ON documents USING btree (workspace_id, published_at);

-- HINWEIS zum Vektorindex:
-- Ein HNSW-Index auf `embedding` beschleunigt die Vektorsuche erheblich, wird
-- aber bewusst NICHT hier angelegt. Er müsste nach dem Füllen der Embeddings
-- gebaut werden – auf überwiegend NULL-Vektoren ist der Aufbau langsam und das
-- Ergebnis schlechter. Nach dem Embedding-Lauf separat ausführen:
--
--   CREATE INDEX CONCURRENTLY chunks_embedding_hnsw_idx
--     ON chunks USING hnsw (embedding vector_cosine_ops);
--
-- (CONCURRENTLY, damit der laufende Betrieb nicht blockiert wird; das geht
--  nicht innerhalb einer Migrations-Transaktion, daher als Einzelschritt.)

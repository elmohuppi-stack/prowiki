-- ---------------------------------------------------------------------------
-- Wiki-Suche: den vorhandenen Volltextindex überhaupt nutzbar machen
-- ---------------------------------------------------------------------------
--
-- Ausgangslage: `wiki_pages_fts_idx` aus 0007 stand auf idx_scan = 0, obwohl
-- die Suche ihn adressiert. Grund ist das OR in service/wiki.ts:
--
--   to_tsvector(...) @@ websearch_to_tsquery(...)   OR   title ILIKE '%q%'
--
-- Ein ILIKE mit führendem % ist ohne Trigramm-Index nicht indexierbar. Sobald
-- ein Zweig einer OR-Bedingung keinen Index hat, kann Postgres die GESAMTE
-- Bedingung nur noch als Filter auswerten – der Volltextindex bleibt liegen.
-- Gemessen auf Produktivdaten (5.703 Seiten, Suchwort "Maske"):
--
--   mit OR-ILIKE   Index Scan + Filter, 3.159 Zeilen verworfen   1.200 ms
--   nur FTS-Zweig  BitmapAnd über wiki_pages_fts_idx                4,3 ms
--
-- Mit einem Trigramm-Index auf title sind beide Zweige indexierbar und der
-- Planner kann sie zu einem BitmapOr verbinden.
--
-- Der ILIKE-Zweig wird bewusst NICHT entfernt: websearch_to_tsquery findet
-- keine Teilwörter, Kürzel wie "FG36" und Slug-Fragmente sucht man aber genau
-- so.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS wiki_pages_title_trgm_idx
  ON wiki_pages USING gin (title gin_trgm_ops);

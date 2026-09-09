import { sql } from "drizzle-orm";

/**
 * Eine Liste von Strings als echtes Postgres-`text[]`.
 *
 * Nötig, weil ein JS-Array direkt in einem `sql`-Template etwas anderes ergibt
 * als es aussieht: drizzle setzt daraus die Parameterliste `($1, $2)`, und die
 * liest Postgres als Row-Konstruktor. Für `= ANY(...)` und `<> ALL(...)`
 * braucht es aber ein Array — `ANY(($1, $2))` scheitert zur Laufzeit, und zwar
 * erst dann, wenn die Liste tatsächlich gefüllt ist. Genau daran war das
 * Löschen und Verschieben von Dokumenten mit eigenen Artikeln gescheitert.
 *
 * Bei leerer Liste entsteht `ARRAY[]::text[]` — gültiges SQL, das nichts
 * trifft. Das ist die richtige Antwort auf "keine Slugs" und ersetzt keine
 * Prüfung beim Aufrufer, der sich die Abfrage dann ganz sparen kann.
 */
export function textArray(werte: string[]) {
  return sql`ARRAY[${sql.join(
    werte.map((w) => sql`${w}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Der Helfer, der eine String-Liste zu einem Postgres-`text[]` macht.
 *
 * Geprüft wird das erzeugte SQL, nicht sein Effekt — eine Datenbank braucht
 * das nicht, und der Fehler, um den es geht, steckte genau in der Übersetzung
 * von JavaScript nach SQL.
 *
 * Ausführen: cd backend && bun test src/db/sql-array.test.ts
 */
import { expect, test, describe } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { textArray } from "./sql-array.ts";

const dialekt = new PgDialect();

function baue(werte: string[]) {
  return dialekt.sqlToQuery(sql`SELECT 1 WHERE x = ANY(${textArray(werte)})`);
}

describe("textArray", () => {
  test("erzeugt ein Array, keine Parameterliste", () => {
    const { sql: text, params } = baue(["a", "b"]);
    expect(text).toContain("ANY(ARRAY[$1, $2]::text[])");
    // Die Form, an der es scheiterte: `($1, $2)` ist für Postgres ein
    // Row-Konstruktor und kein Array.
    expect(text).not.toContain("ANY(($");
    expect(params).toEqual(["a", "b"]);
  });

  test("der Einzelfall bleibt ein Array", () => {
    // `ANY(($1))` ist der gefährlichere Fall: es sieht wie gültiges SQL aus,
    // ist aber ein skalarer Wert in Klammern und scheitert genauso.
    expect(baue(["nur-eins"]).sql).toContain("ANY(ARRAY[$1]::text[])");
  });

  test("leere Liste ergibt ein leeres Array statt kaputtem SQL", () => {
    const { sql: text, params } = baue([]);
    expect(text).toContain("ANY(ARRAY[]::text[])");
    expect(params).toEqual([]);
  });
});

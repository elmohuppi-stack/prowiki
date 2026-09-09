/**
 * Das SQL, mit dem beim Löschen eines Dokuments die Verweise auf seine
 * verschwindenden Artikel aus den Linkspalten fallen.
 *
 * Geprüft wird das erzeugte Statement, nicht sein Effekt: eine Datenbank
 * braucht der Test dafür nicht, und der Fehler, um den es geht, steckte genau
 * in der Übersetzung von JavaScript nach SQL. Ein JS-Array direkt in ein
 * `sql`-Template gesetzt wird bei drizzle zu `($1, $2)` — für Postgres ein
 * Row-Konstruktor, und `ALL(($1, $2))` lehnt es ab. Jedes Dokument mit eigenen
 * Artikeln war dadurch unlöschbar (HTTP 500), Dokumente ohne Artikel nicht,
 * weil dieser Zweig bei ihnen gar nicht lief.
 *
 * Ausführen: cd backend && bun test src/service/document.test.ts
 */
import { expect, test, describe } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { entferneSlugVerweise, LINKSPALTEN } from "./document.ts";

const dialekt = new PgDialect();

function baue(spalte: (typeof LINKSPALTEN)[number], slugs: string[]) {
  const q = dialekt.sqlToQuery(entferneSlugVerweise(spalte, "wiki-1", slugs));
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

describe("entferneSlugVerweise", () => {
  test("übergibt die Slugs als Postgres-Array, nicht als Row", () => {
    const { sql } = baue("in_links", ["kapitel-eins", "kapitel-zwei"]);
    expect(sql).toContain("ALL(ARRAY[$1, $2]::text[])");
    expect(sql).toContain("ANY(ARRAY[$4, $5]::text[])");
    // Der Fehler, der das Löschen brach: eine Parameterliste in Klammern.
    expect(sql).not.toContain("ALL(($");
    expect(sql).not.toContain("ANY(($");
  });

  test("auch bei einem einzigen Slug bleibt es ein Array", () => {
    // Der Einzelfall ist der gefährlichere: `ALL(($1))` sieht wie gültiges SQL
    // aus, ist aber ein skalarer Wert in Klammern und scheitert genauso.
    const { sql } = baue("out_links", ["nur-eins"]);
    expect(sql).toContain("ALL(ARRAY[$1]::text[])");
  });

  test("Parameter stehen in der Reihenfolge der Platzhalter", () => {
    const { params } = baue("in_links", ["a", "b"]);
    expect(params).toEqual(["a", "b", "wiki-1", "a", "b"]);
  });

  test("wirkt nur auf die genannte Spalte", () => {
    expect(baue("out_links", ["x"]).sql).toContain("SET out_links =");
    expect(baue("out_links", ["x"]).sql).not.toContain("in_links");
  });
});

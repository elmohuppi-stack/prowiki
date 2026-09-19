/**
 * Zwei Dinge, die beide in der Übersetzung von JavaScript nach SQL stecken —
 * eine Datenbank braucht keiner der Tests.
 *
 * 1. `entferneSlugVerweise`: das SQL, mit dem beim Löschen eines Dokuments die
 *    Verweise auf seine verschwindenden Artikel aus den Linkspalten fallen.
 *    Ein JS-Array direkt in ein `sql`-Template gesetzt wird bei drizzle zu
 *    `($1, $2)` — für Postgres ein Row-Konstruktor, und `ALL(($1, $2))` lehnt
 *    es ab. Jedes Dokument mit eigenen Artikeln war dadurch unlöschbar
 *    (HTTP 500), Dokumente ohne Artikel nicht, weil dieser Zweig bei ihnen gar
 *    nicht lief.
 *
 * 2. `findYouTubeDocument`: die Dublettensuche des YouTube-Imports, siehe
 *    unten. Anlass ist ein Befund vom 19. September 2026 — dasselbe Video stand
 *    zweimal im Wiki, obwohl es einmal importiert wurde.
 *
 * Ausführen: cd backend && bun test src/service/document.test.ts
 */
import { expect, test, describe } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  entferneSlugVerweise,
  LINKSPALTEN,
  findYouTubeDocument,
  findYouTubeDocumentWhere,
} from "./document.ts";

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

/**
 * Dublettensuche des YouTube-Imports.
 *
 * Der Fehler, der diese Tests ausgelöst hat: dasselbe Video stand zweimal im
 * Wiki, obwohl es einmal importiert wurde. Ursache war nicht der Import allein,
 * sondern das Zusammenspiel aus einem mobilen Browserabbruch (nginx 499), der
 * zweiten Eingabe des Nutzers und einer Datenbank, die den zweiten Import
 * widerspruchslos annahm.
 */
describe("findYouTubeDocumentWhere", () => {
  const WHERE = () =>
    new PgDialect().sqlToQuery(findYouTubeDocumentWhere("wiki-1", "aAGEnHaArsw"));

  test("sucht über external_id UND über die URL", () => {
    // Fiele einer der beiden Wege weg, bliebe der Schutz für eine Hälfte des
    // Bestands wirkungslos: ohne external_id für alles nach der Umstellung,
    // ohne source_url für alles davor — und Letzteres sind genau die
    // Dokumente, bei denen die Dubletten entstanden sind.
    const { sql } = WHERE();
    expect(sql).toContain('"external_id" = $3');
    expect(sql).toContain('"source_url" like $4');
    expect(sql).toContain('"source"     like $5');
  });

  test("die Video-ID wird als Muster übergeben, nicht als Blankowert", () => {
    // Ein blanker LIKE-Wert (ein Parameter, der nur die ID ist) träfe nur eine
    // URL, die exakt die ID ist — bei einer gespeicherten URL nie. Ohne die
    // Prozentzeichen liefe der Vergleich für jedes echte Dokument ins Leere
    // und die Funktion gäbe still `null` zurück statt eines Treffers.
    const { params } = WHERE();
    expect(params).toEqual([
      "wiki-1",
      "youtube",
      "aAGEnHaArsw",
      "%aAGEnHaArsw%",
      "%aAGEnHaArsw%",
    ]);
  });

  test("grenzt auf Wiki und Dokumenttyp ein", () => {
    // Ohne die Wiki-Grenze fände ein Import in Wiki A das Video aus Wiki B und
    // überspränge den Import dort — ein Datenverlust, kein Duplikat.
    const { sql, params } = WHERE();
    expect(sql).toContain('"wiki_id" = $1');
    expect(sql).toContain('"type" = $2');
    expect(params[0]).toBe("wiki-1");
    expect(params[1]).toBe("youtube");
  });

  test("die drei Wege sind mit OR verknüpft, nicht mit AND", () => {
    // Mit AND müsste eine Zeile alle drei Kriterien erfüllen — was nur für
    // Dokumente gilt, bei denen external_id, source_url und source dieselbe
    // Video-ID tragen. Der Altbestand (external_id leer) fiele heraus.
    const { sql } = WHERE();
    const posSrc = sql.indexOf('"source_url" like');
    // `source` allein käme auch in `source_url` vor — gesucht wird der
    // vollqualifizierte Spaltenname, damit die Position die der dritten
    // Bedingung ist.
    const posSource = sql.indexOf('"documents"."source"');
    const posExt = sql.indexOf('"external_id" =');
    // Reihenfolge external_id → source_url → source und alle drei vorhanden.
    // Waeren sie mit AND verknuepft statt mit OR, muesste eine Zeile alle drei
    // Kriterien erfuellen - der Altbestand (external_id leer) fiele heraus.
    expect(posExt).toBeGreaterThan(-1);
    expect(posSrc).toBeGreaterThan(posExt);
    expect(posSource).toBeGreaterThan(posSrc);
    expect(sql).toContain(" or ");
  });
});


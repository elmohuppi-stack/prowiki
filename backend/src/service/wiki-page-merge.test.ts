/**
 * Zusammensetzen einer Themenseite aus fortgeschriebener Einleitung und
 * unveränderten Belegabschnitten.
 *
 * Der Punkt dieser Umstellung ist, dass frühere Abschnitte NIE wieder durch das
 * Modell laufen – sie werden hier wörtlich wieder angehängt. Genau das prüfen
 * diese Tests: nichts geht verloren, ein erneuter Import verdoppelt nichts, und
 * Seiten aus der Zeit davor werden verlustfrei überführt.
 *
 * Ausführen: cd backend && bun test src/service/wiki-page-merge.test.ts
 */
import { expect, test, describe } from "bun:test";
import { __test__ } from "./wiki-generate.ts";

const { seiteZerlegen, seiteZusammenfügen, abschnittEntfernen } = __test__;

const umgestellt = [
  "# Energiewende",
  "",
  "Die Energiewende ist der Umbau der Stromversorgung.",
  "",
  "## Belege nach Quelle",
  "",
  "### Video A",
  "",
  "- Erste Aussage [c001]",
  "",
  "### Video B",
  "",
  "- Zweite Aussage [c007]",
].join("\n");

const antwort = [
  "# Energiewende",
  "",
  "Die Energiewende ist der Umbau der Stromversorgung, zuletzt mit Blick auf Netzentgelte.",
  "",
  "## Belege nach Quelle",
  "",
  "### Video C",
  "",
  "- Dritte Aussage [c042]",
].join("\n");

describe("seiteZerlegen", () => {
  test("trennt Einleitung von den Belegabschnitten", () => {
    const { einleitung, bestand, marker } = seiteZerlegen(umgestellt);
    expect(einleitung).toContain("Umbau der Stromversorgung");
    expect(einleitung).not.toContain("Video A");
    expect(bestand).toContain("### Video A");
    expect(bestand).toContain("### Video B");
    expect(marker).toBe("## Belege nach Quelle");
  });

  test("Protokollseiten gliedern nach Sitzung – gleiche Behandlung", () => {
    const seite = "# Thema\n\nEinleitung.\n\n## Belege nach Sitzung\n\n### 3. Sitzung\n\n- Punkt";
    const { bestand, marker } = seiteZerlegen(seite);
    expect(marker).toBe("## Belege nach Sitzung");
    expect(bestand).toBe("### 3. Sitzung\n\n- Punkt");
  });

  test("Altseite: Fließtext wird als Abschnitt konserviert, nichts geht verloren", () => {
    const alt = "# Energiewende\n\nEin langer Artikel ohne Marker [c003].";
    const { einleitung, bestand, marker } = seiteZerlegen(alt);
    expect(marker).toBe(""); // Kennzeichen einer noch nicht umgestellten Seite
    expect(einleitung).toBe(alt); // das Modell sieht sie einmalig ganz
    expect(bestand).toBe("### Früherer Stand\n\nEin langer Artikel ohne Marker [c003].");
  });

  test("leere Seite", () => {
    expect(seiteZerlegen("")).toEqual({ einleitung: "", bestand: "", marker: "" });
  });
});

describe("seiteZusammenfügen", () => {
  test("hängt den neuen Abschnitt an und lässt die alten wörtlich stehen", () => {
    const { bestand } = seiteZerlegen(umgestellt);
    const neu = seiteZusammenfügen({
      modellAusgabe: antwort,
      bestand,
      quelle: "Video C",
    })!;

    expect(neu).toContain("Netzentgelte"); // neue Einleitung
    expect(neu).toContain("- Erste Aussage [c001]"); // Bestand unangetastet
    expect(neu).toContain("- Zweite Aussage [c007]");
    expect(neu).toContain("- Dritte Aussage [c042]");
    // Reihenfolge: Einleitung, Marker, Bestand, neuer Abschnitt
    expect(neu.indexOf("### Video A")).toBeLessThan(neu.indexOf("### Video C"));
    expect(neu.indexOf("## Belege nach Quelle")).toBeLessThan(neu.indexOf("### Video A"));
    // Marker genau einmal
    expect(neu.split("## Belege nach Quelle").length - 1).toBe(1);
  });

  test("erneuter Import derselben Quelle ersetzt ihren Abschnitt, statt ihn zu verdoppeln", () => {
    const { bestand } = seiteZerlegen(umgestellt);
    const wiederholung = antwort
      .replace("### Video C", "### Video B")
      .replace("Dritte Aussage [c042]", "Zweite Aussage, überarbeitet [c007]");

    const neu = seiteZusammenfügen({
      modellAusgabe: wiederholung,
      bestand,
      quelle: "Video B",
    })!;

    expect(neu.split("### Video B").length - 1).toBe(1);
    expect(neu).toContain("Zweite Aussage, überarbeitet [c007]");
    expect(neu).not.toContain("- Zweite Aussage [c007]");
    expect(neu).toContain("### Video A"); // die anderen bleiben
  });

  test("Antwort ohne Überschrift bekommt eine – sonst wäre sie später nicht auffindbar", () => {
    const ohneKopf = "# Thema\n\nEinleitung.\n\n## Belege nach Quelle\n\n- Aussage [c001]";
    const neu = seiteZusammenfügen({
      modellAusgabe: ohneKopf,
      bestand: "",
      quelle: "Video D",
    })!;
    expect(neu).toContain("### Video D\n\n- Aussage [c001]");
  });

  test("Antwort ohne Marker gibt null – der Aufrufer rettet dann den Bestand", () => {
    expect(
      seiteZusammenfügen({
        modellAusgabe: "# Thema\n\nNur Fließtext.",
        bestand: "### Video A\n\n- Erste Aussage",
        quelle: "Video C",
      }),
    ).toBeNull();
  });

  test("Umstellung einer Altseite erhält deren Inhalt", () => {
    const alt = "# Energiewende\n\nEin langer Artikel ohne Marker [c003].";
    const { bestand } = seiteZerlegen(alt);
    const neu = seiteZusammenfügen({ modellAusgabe: antwort, bestand, quelle: "Video C" })!;
    expect(neu).toContain("Ein langer Artikel ohne Marker [c003].");
    expect(neu).toContain("### Dritte Aussage".replace("### ", "")); // neuer Beleg da
    expect(neu.indexOf("### Früherer Stand")).toBeLessThan(neu.indexOf("### Video C"));
  });
});

describe("abschnittEntfernen", () => {
  test("Text vor der ersten Überschrift bleibt stehen", () => {
    const bestand = "Vorspann.\n\n### Video A\n\n- Punkt";
    expect(abschnittEntfernen(bestand, "Video A")).toBe("Vorspann.");
  });

  test("unbekannte Quelle ändert nichts", () => {
    const bestand = "### Video A\n\n- Punkt";
    expect(abschnittEntfernen(bestand, "Video Z")).toBe(bestand);
  });
});

/**
 * Der Prompt-Cache des Anbieters erkennt immer nur das gemeinsame PRÄFIX zweier
 * Anfragen. Steht ein seitenspezifischer Block vor dem Regelwerk und der
 * Linkliste, bricht das Präfix dort ab und der ganze Rest wird bei jeder Seite
 * neu bezahlt. Dieser Test hält die Reihenfolge fest.
 */
describe("Prompt-Reihenfolge (Cache-Präfix)", () => {
  const { buildPagePrompt } = __test__;

  const gemeinsam = {
    newInformation: "[c001] Irgendein Chunk.",
    language: "Deutsch",
    linkZiele: ["[[entity/anna-muster]]", "[[concept/netzentgelt]]"].join("\n"),
    sessionLabel: "Video C",
    zeitmarkenRegel: "",
  };

  test("zwei Seiten desselben Imports teilen Regelwerk, Linkliste und Anweisungen", () => {
    const a = buildPagePrompt({
      ...gemeinsam,
      item: { name: "Anna Muster", slug: "entity/anna-muster", aliases: [], description: "", details: "" },
      bisheriges: "Anna Muster ist ...",
    });
    const b = buildPagePrompt({
      ...gemeinsam,
      item: { name: "Netzentgelt", slug: "concept/netzentgelt", aliases: [], description: "", details: "" },
      bisheriges: "(Neue Seite)",
    });

    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const praefix = a.slice(0, i);

    expect(praefix).toContain("<valid_wiki_links>");
    expect(praefix).toContain("[[concept/netzentgelt]]");
    expect(praefix).toContain("</instructions>");
    // Die Prompts laufen erst im Seitenblock auseinander, nicht davor.
    expect(i).toBeGreaterThan(praefix.indexOf("</instructions>"));
    expect(a.slice(i)).toContain("Anna Muster");
    expect(b.slice(i)).toContain("Netzentgelt");
  });

  test("die Linkliste wird nicht je Seite gefiltert – sonst bricht das Präfix", () => {
    const prompt = buildPagePrompt({
      ...gemeinsam,
      item: { name: "Netzentgelt", slug: "concept/netzentgelt", aliases: [], description: "", details: "" },
      bisheriges: "(Neue Seite)",
    });
    // Der eigene Slug steht mit in der Liste; dass die Seite nicht auf sich
    // selbst verlinkt, sagt die Anweisung.
    expect(prompt).toContain("[[concept/netzentgelt]]");
    expect(prompt).toContain("Der Slug der Seite selbst darf nicht als Link");
  });
});

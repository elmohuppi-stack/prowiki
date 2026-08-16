/**
 * Kapitelaufteilung: die Stelle, an der ein Geisterkapitel „Transkript"
 * entstand.
 *
 * Ein Video-Transkript ist ein einziger, riesiger Absatz mit genau einer Zeile
 * davor: der Überschrift. Wird die Überschrift beim Größen-Split als eigenes
 * Stück abgelegt, entsteht ein Kapitel ohne jeden Inhalt — und die Pipeline
 * lässt dafür einen Artikel schreiben, der wahrheitsgemäß meldet, das Dokument
 * sei leer.
 *
 * Ausführen: cd backend && bun test src/service/wiki-chapters.test.ts
 */
import { expect, test, describe } from "bun:test";
import { __test__ } from "./wiki-generate.ts";

const { splitIntoChapters, packBySize, verwertbareKapitel } = __test__;

/** Dokumentaufbau wie ihn buildDocumentContent erzeugt. */
function dokument(transkriptZeichen: number, beschreibung = 400): string {
  const satz = "Ein Satz aus dem Transkript. ";
  const transkript = satz.repeat(Math.ceil(transkriptZeichen / satz.length));
  return [
    "# Testvideo",
    "",
    "**Kanal**: Testkanal",
    "**URL**: https://www.youtube.com/watch?v=abc12345678",
    "",
    `**Beschreibung**: ${"b".repeat(beschreibung)}`,
    "",
    "## Transkript",
    "",
    transkript,
  ].join("\n");
}

describe("packBySize", () => {
  test("eine allein stehende Überschrift wird kein eigenes Stück", () => {
    const text = "## Transkript\n\n" + "x".repeat(50_000);
    const teile = packBySize(text, 10_000);

    // Kein Teil besteht nur aus der Überschrift.
    expect(teile.some((t) => t.trim() === "## Transkript")).toBe(false);
    // Sie steht am Anfang des ersten Stücks, bei dem Text dazugehört.
    expect(teile[0].startsWith("## Transkript")).toBe(true);
    expect(teile[0].length).toBeGreaterThan(1000);
  });

  test("kein Stück überschreitet die Zielgröße", () => {
    const teile = packBySize("## Kopf\n\n" + "y".repeat(100_000), 10_000);
    for (const t of teile) expect(t.length).toBeLessThanOrEqual(10_000);
  });

  test("normale Absätze bleiben unverändert zusammengepackt", () => {
    const teile = packBySize("Absatz eins.\n\nAbsatz zwei.", 10_000);
    expect(teile).toEqual(["Absatz eins.\n\nAbsatz zwei."]);
  });
});

describe("splitIntoChapters am echten Dokumentaufbau", () => {
  test("kein Kapitel besteht nur aus der Transkript-Überschrift", () => {
    const kapitel = splitIntoChapters(dokument(300_000), 32_000);
    expect(kapitel.length).toBeGreaterThan(1);

    for (const k of kapitel) {
      const ohneUeberschrift = k.text.replace(/^#{1,6}\s+.*$/gm, "").trim();
      expect(ohneUeberschrift.length).toBeGreaterThan(0);
    }
  });

  test("der gesamte Text bleibt erhalten", () => {
    const doc = dokument(120_000);
    const kapitel = splitIntoChapters(doc, 32_000);
    const summe = kapitel.reduce((n, k) => n + k.text.length, 0);
    // Beim Zusammenfügen gehen nur Trennzeichen verloren, nichts Inhaltliches.
    expect(summe).toBeGreaterThan(doc.length * 0.98);
  });

  test("kurze Dokumente bleiben ein einziges Kapitel", () => {
    const kapitel = splitIntoChapters(dokument(2_000), 32_000);
    expect(kapitel).toHaveLength(1);
  });
});

describe("verwertbareKapitel", () => {
  test("wirft Kapitel ohne Substanz heraus", () => {
    const übrig = verwertbareKapitel([
      { title: "Transkript", text: "## Transkript", titleIsFallback: false },
      { title: "Echt", text: "A".repeat(500), titleIsFallback: false },
    ] as any);
    expect(übrig).toHaveLength(1);
    expect(übrig[0].title).toBe("Echt");
  });

  test("ein einzelnes Kapitel wird nie verworfen", () => {
    // Sonst verlöre ein Dokument, das wirklich leer ist, seine Rückmeldung.
    const übrig = verwertbareKapitel([
      { title: "", text: "## Nur eine Überschrift", titleIsFallback: true },
    ] as any);
    expect(übrig).toHaveLength(1);
  });

  test("Trennlinien und leere Listenpunkte zählen nicht als Inhalt", () => {
    const übrig = verwertbareKapitel([
      { title: "", text: "## Kopf\n\n---\n\n-\n-", titleIsFallback: true },
      { title: "Echt", text: "B".repeat(500), titleIsFallback: false },
    ] as any);
    expect(übrig).toHaveLength(1);
  });
});

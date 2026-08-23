/**
 * Darstellung von Kostenzahlen — gemeinsam für die Kostenübersicht und den
 * Aufwandskasten auf der Dokumentseite.
 *
 * Beide zeigen dieselben Größen; stünden die Formatierer zweimal da, würde
 * dasselbe Feld an einer Stelle „1,4 Mio" und an der anderen „1.400.000"
 * heißen, und ein Leser müsste raten, ob das derselbe Wert ist.
 */

/**
 * Millionstel Euro als Betrag.
 *
 * Kleine Beträge bekommen mehr Nachkommastellen: „0,00 €" für einen
 * Embedding-Posten sähe aus, als sei er kostenlos, und genau das war die
 * Annahme, die vor der Zählung galt. Erst bei echter Null steht „0 €".
 */
export function euro(micros: number | null | undefined): string {
  const m = Number(micros ?? 0);
  if (!m) return "0 €";
  const e = m / 1_000_000;
  const stellen = e >= 1 ? 2 : e >= 0.01 ? 3 : 4;
  return (
    e.toLocaleString("de-DE", {
      minimumFractionDigits: stellen,
      maximumFractionDigits: stellen,
    }) + " €"
  );
}

/** Große Stückzahlen kurz: 75.441.963 → „75,4 Mio". */
export function kurz(n: number | null | undefined): string {
  const z = Number(n ?? 0);
  if (z >= 1_000_000)
    return (
      (z / 1_000_000).toLocaleString("de-DE", { maximumFractionDigits: 1 }) +
      " Mio"
    );
  if (z >= 1_000)
    return (z / 1_000).toLocaleString("de-DE", { maximumFractionDigits: 0 }) + "k";
  return String(z);
}

/** Ganze Zahl mit Tausenderpunkten. */
export function zahl(n: number | null | undefined): string {
  return Number(n ?? 0).toLocaleString("de-DE");
}

/** Anteil (0…1) als Prozent ohne Nachkommastelle. */
export function prozent(anteil: number | null | undefined): string {
  return Math.round(Number(anteil ?? 0) * 100) + " %";
}

/** Die `kind`-Werte aus service/usage.ts, auf Deutsch. */
const ART_LABEL: Record<string, string> = {
  llm_wiki_generate: "Wiki-Generierung",
  llm_from_chat: "Artikel aus Chat",
  llm_chat: "Chat",
  llm_topic: "Themen",
  embedding: "Embeddings",
  transcript_fetch: "Transkript",
};

export function artLabel(kind: string): string {
  return ART_LABEL[kind] || kind;
}

/**
 * Feste Farbe je Art.
 *
 * Fest und nicht nach Reihenfolge vergeben, damit „Wiki-Generierung" auf jeder
 * Seite und in jedem Zeitraum dieselbe Farbe hat — sonst müsste man bei jedem
 * Diagramm neu in die Legende schauen.
 */
const ART_FARBE: Record<string, string> = {
  llm_wiki_generate: "#4f8cff",
  llm_from_chat: "#7c5cff",
  llm_chat: "#22a06b",
  llm_topic: "#e0a30c",
  embedding: "#8c9bab",
  transcript_fetch: "#e8703a",
};

export function farbe(kind: string): string {
  return ART_FARBE[kind] || "#b0b7c3";
}

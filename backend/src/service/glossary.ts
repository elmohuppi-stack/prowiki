/**
 * Geprüfte Abkürzungs-Auflösungen für die Wiki-Generierung.
 *
 * Hintergrund: Ohne eine solche Liste erfindet das Modell Auflösungen für
 * Kürzel, die es nicht kennt — bei einem Protokollbestand mit hunderten
 * Gremien-Abkürzungen war das in knora ein reales Qualitätsproblem. Der Prompt
 * bekommt deshalb eine **geschlossene** Liste und die Anweisung, alles andere
 * unaufgelöst zu lassen.
 *
 * In knora war diese Liste eine fest verdrahtete RKI-Tabelle in
 * `scripts/lib/rki-glossar.ts`. Die ist mit der RKI-Pipeline entfallen, denn
 * inhaltsspezifische Tabellen gehören nicht in den Generator: ein YouTube-Kanal
 * hat sein eigenes Jargon, eine Redaktion ein anderes.
 *
 * Geplant ist das Glossar deshalb **pro Wiki** (Tabelle `wiki_glossary`,
 * pflegbar in den Wiki-Einstellungen). Bis dahin liefert die Funktion eine
 * leere Liste — das ist der sichere Zustand: der Prompt löst dann gar keine
 * Kürzel auf, statt sie zu raten.
 */

export interface GlossaryEntry {
  /** Das Kürzel, wie es im Text vorkommt. */
  term: string;
  /** Geprüfte Auflösung. Fehlt sie, darf das Modell das Kürzel nicht auflösen. */
  expansion: string | null;
}

/**
 * Glossar eines Wikis. Noch ohne Datenquelle — siehe Modulkommentar.
 */
export async function getGlossary(_wikiId: string): Promise<GlossaryEntry[]> {
  return [];
}

/** Formatiert das Glossar für die Prompt-Einsetzung `{{glossar}}`. */
export function glossaryForPrompt(entries: GlossaryEntry[]): string {
  const resolved = entries.filter((e) => e.expansion);
  if (resolved.length === 0) return "Keines";
  return resolved.map((e) => `- ${e.term} = ${e.expansion}`).join("\n");
}

/** Kürzel ohne geprüfte Auflösung — die bleiben im Text, wie sie sind. */
export function unresolvedTerms(entries: GlossaryEntry[]): string[] {
  return entries.filter((e) => !e.expansion).map((e) => e.term);
}

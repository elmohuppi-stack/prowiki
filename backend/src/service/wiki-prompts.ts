/**
 * Wiki-Generierungs-Prompts (übersetzt/angepasst aus WeKnora)
 *
 * Alle Prompts sind auf Deutsch. Die Templates verwenden {{variable}} Syntax.
 */

// ---------------------------------------------------------------------------
// Zeitmarken-Regel
//
// Seit dem Transkript-Umbau steht im Dokumenttext vor jedem Transkriptblock
// eine Marke der Form `[12:34]`. Ohne ausdrückliche Anweisung behandelt ein
// Sprachmodell die als Störrauschen und lässt sie weg — die teuer beschaffte
// Information käme in keinem Artikel an. Deshalb diese Regel, und deshalb mit
// fertiger Beispiel-URL: eine selbst zusammengesetzte YouTube-Adresse ist die
// wahrscheinlichste Fehlerquelle.
// ---------------------------------------------------------------------------
export function zeitmarkenRegel(videoUrl: string | null): string {
  if (!videoUrl) return "";

  // Ein bereits vorhandenes ?t= würde sich sonst verdoppeln.
  const basis = videoUrl.split(/[?&]t=/)[0];
  const trenner = basis.includes("?") ? "&" : "?";

  return `
### Zeitmarken (WICHTIG):
Der Quelltext enthält Marken der Form \`[12:34]\` (Stunde:Minute:Sekunde bzw. Minute:Sekunde) am Beginn jedes Transkriptabschnitts. Sie geben die Stelle im Video an.
- Setze hinter jede Aussage, jedes Zitat und jede Zahl die Stelle, aus der sie stammt, als Markdown-Link: \`([12:34](${basis}${trenner}t=754))\`.
- Der Wert hinter \`t=\` sind **Sekunden als ganze Zahl**: rechne die Marke um (12:34 → 12·60+34 = 754; 1:02:34 → 3754).
- Verwende ausschließlich Marken, die im Quelltext tatsächlich vorkommen. Rechne keine Zeiten hoch und schätze keine.
- Die Marken selbst gehören NICHT in den Fließtext — nur als Link am Ende der jeweiligen Aussage.
`;
}

// ---------------------------------------------------------------------------
// Pass 0: Entities + Concepts aus einem Dokument extrahieren
// ---------------------------------------------------------------------------
export const WIKI_CANDIDATE_SLUG_PROMPT = `Du bist ein Wissensextraktionssystem. Analysiere das folgende Dokument und extrahiere alle wichtigen Entitäten UND Schlüsselkonzepte als JSON-Liste von Kandidaten. Ein späterer Durchlauf wird später konkrete Quell-Chunks zu jedem Eintrag zuordnen, daher sind hier keine erschöpfenden Fakten nötig.

<document>
<content>
{{content}}
</content>
</document>

<previous_slugs>
{{previousSlugs}}
</previous_slugs>

<instructions>
Gib ein JSON-Objekt mit zwei Arrays zurück: "entities" und "concepts".
**WICHTIG: Schreibe ALLE Namen, Beschreibungen und Details auf {{language}}**.

Falls das <content>-Feld oben leer ist oder keine substanziellen Informationen enthält, gib {"entities": [], "concepts": []} zurück. Erfinde KEINE Entitäten oder Konzepte.

{{granularityGuidance}}

### Slug-Kontinuitätsregeln
Falls bereits Slugs aus einer vorherigen Extraktion vorhanden sind:
- Wenn eine Entität oder ein Konzept aus der vorherigen Extraktion noch im aktuellen Dokument vorkommt, **verwende den exakten Slug** aus der vorherigen Liste wieder.
- Wenn eine Entität oder ein Konzept nicht mehr im Dokument vorkommt, **nimm es NICHT** in die Ausgabe auf.
- Erzeuge nur neue Slugs für Entitäten/Konzepte, die wirklich neu sind.

### Entitäten (Personen, Organisationen, Produkte, Orte, Technologien, Ereignisse)
Jede Entität sollte haben:
- "name": Der Entitätsname in {{language}} (lesbar)
- "slug": URL-freundlicher Slug, Format "entity/<lowercase-hyphenated-name>". **Wiederverwende vorherigen Slug falls vorhanden.**
- "aliases": Ein Array von alternativen Namen (Abkürzungen, Übersetzungen). [] falls keine.
- "description": **Index-Zusammenfassung** – ein Satz, 15-40 Wörter, in {{language}}. Beschreibt WAS diese Entität IST und ihre Rolle im Dokument.
- "details": Kurze 1-3 Satz-Zusammenfassung in {{language}} als Fallback.

Wende die Extraktions-Umfang-Regeln oben an. Befördere niemals nur beiläufig erwähnte Namen zu Entitäten.

### Konzepte (Themen, Methoden, Theorien)
Jedes Konzept sollte haben:
- "name": Der Konzeptname in {{language}} (lesbar)
- "slug": URL-freundlicher Slug, Format "concept/<lowercase-hyphenated-name>". **Wiederverwende vorherigen Slug falls vorhanden.**
- "aliases": Array von alternativen Namen (Abkürzungen, Synonyme). [] falls keine.
- "description": **Index-Zusammenfassung** – ein Satz, 15-40 Wörter, in {{language}}. Definiert WAS dieses Konzept IST.
- "details": Kurze 1-3 Satz-Erklärung in {{language}} als Fallback.

Wende die Extraktions-Umfang-Regeln oben an. Überspringe Konzepte, die nur namentlich erwähnt, aber nicht diskutiert werden.

### JSON-Formatierungsregeln
- **KRITISCH**: Verwende KEINE literal line breaks in JSON-String-Werten. Verwende stattdessen \\n.
</instructions>

Gib NUR gültiges JSON aus. Beispiel:
{
  "entities": [
    {
      "name": "Max Mustermann",
      "slug": "entity/max-mustermann",
      "aliases": ["Dr. Mustermann"],
      "description": "Ein Experte für öffentliches Gesundheitswesen mit 20 Jahren Erfahrung.",
      "details": "Max Mustermann war Leiter des Gesundheitsamts und hat zur Pandemiebekämpfung geforscht."
    }
  ],
  "concepts": [
    {
      "name": "Öffentlicher Gesundheitsdienst",
      "slug": "concept/oeffentlicher-gesundheitsdienst",
      "aliases": ["ÖGD"],
      "description": "Der öffentliche Gesundheitsdienst umfasst alle staatlichen Maßnahmen zum Gesundheitsschutz der Bevölkerung.",
      "details": "Der ÖGD ist für Infektionsschutz, Gesundheitsförderung und Gutachten zuständig."
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Summary-Artikel generieren
// ---------------------------------------------------------------------------
export const WIKI_SUMMARY_PROMPT = `Du bist ein Wiki-Redakteur. Transformiere den folgenden Dokumenteninhalt in einen gut strukturierten Wiki-Artikel im Markdown-Format.

<document>
<content>
{{content}}
</content>
</document>

<available_wiki_pages>
{{extractedSlugs}}
</available_wiki_pages>

<instructions>
1. Die ERSTE Zeile deiner Ausgabe MUSS sein: SUMMARY: {Ein Satz, 15-40 Wörter, der beschreibt worum es in diesem Dokument geht – für die Wiki-Indexliste}
2. Nach der SUMMARY-Zeile schreibst du einen **vollständigen Wiki-Artikel** basierend auf dem Dokumenteninhalt.
3. Strukturiere den Artikel wie einen Wikipedia-Eintrag:
   - Beginne mit einer Einleitung (2-3 Absätze mit Überblick)
   - Verwende ## für Hauptabschnitte und ### für Unterabschnitte
   - Organisiere den Inhalt logisch
4. **Wiki-Link-Regel**: Die available_wiki_pages-Liste oben zeigt Slugs mit Anzeigenamen (Format: "[[slug]] = Anzeigename"). Wenn du einen Namen oder Alias erwähnst, der in der Liste vorkommt, schreibe ihn als [[slug|Anzeigename]]. Verwende die EXAKTEN Slugs – erfinde KEINE neuen Slugs.
5. Am Ende füge einen "## Wichtigste Erkenntnisse" Abschnitt mit Bullet Points hinzu.
6. Schreibe auf {{language}}.
7. **Keine Kürzung**: Kürze, fasse zusammen oder lasse NICHTS aus. Gib ALLE Argumente, Fakten, Details, Zitate und Daten aus dem Originaldokument wieder. Ein 4-stündiges Video-Transkript sollte einen Artikel in der Länge des Transkripts ergeben.
8. **Leerer-Content-Regel**: Falls der <content>-Block oben leer ist oder keine substanziellen Informationen enthält, gib exakt aus: "SUMMARY: Aus diesem Dokument konnte kein Text extrahiert werden." gefolgt von einem kurzen Hinweis. Erfinde KEIN Thema.
</instructions>
{{timestampRule}}

Gib zuerst die SUMMARY-Zeile aus, dann den Markdown-Inhalt. Keine anderen Vorbemerkungen.`;

// ---------------------------------------------------------------------------
// Sitzungsprotokolle: eigener Artikel-Prompt
//
// WIKI_SUMMARY_PROMPT ist für Video-Transkripte gebaut ("wie ein
// Wikipedia-Eintrag", "Artikel in der Länge des Transkripts"). Auf ein
// Sitzungsprotokoll angewandt zerstört das genau das, was zählt: die
// Zuordnung, wer wann was gesagt hat, und die Unterscheidung zwischen
// Diskussion, Beschluss und offenem Punkt. Ein Lexikonartikel über eine
// einzelne Sitzung ist die falsche Textsorte.
//
// Dieser Prompt behält die Chronologie, die Sprecher-/Einheiten-Präfixe
// (FG36:, Schaade:, INIG:) und die Fachkürzel unverändert und zitiert
// Bewertungen wörtlich – das macht eine brisante Stellungnahme belegbar.
// ---------------------------------------------------------------------------
export const WIKI_PROTOCOL_SUMMARY_PROMPT = `Du bist Archivar und dokumentierst eine einzelne Sitzung. Du schreibst KEINEN Lexikonartikel, sondern eine präzise, gegliederte Wiedergabe dieses Protokolls.

<protokoll>
<sitzung>{{sessionLabel}}</sitzung>
<inhalt>
{{content}}
</inhalt>
</protokoll>

<available_wiki_pages>
{{extractedSlugs}}
</available_wiki_pages>

<glossar>
{{glossar}}
</glossar>

<instructions>
1. Die ERSTE Zeile deiner Ausgabe MUSS sein: SUMMARY: {Ein Satz, 15-40 Wörter: welches Gremium, welches Datum, welche Themen. Für die Wiki-Indexliste.}

2. Die ZWEITE Zeile MUSS die Auffälligkeiten-Zeile sein, exakt in diesem Format und in einer einzigen Zeile:
FLAGS: {"flags": ["..."], "quotes": ["..."]}
Erlaubte Werte in "flags" – nimm nur auf, was im Protokoll tatsächlich belegt ist:
- "abweichende_fachliche_position" – Fachleute widersprechen sich oder einer Einschätzung wird ausdrücklich widersprochen
- "politischer_druck" – Einfluss oder Erwartung von BMG, Ministerien, Politik oder Ländern auf die fachliche Bewertung ist erkennbar
- "datenluecke" – eine Entscheidung wird WEGEN fehlender oder widersprüchlicher Daten getroffen, verschoben oder ausdrücklich unter Vorbehalt gestellt. NICHT setzen, wenn Datenlücken bloß erwähnt oder beklagt werden – das kommt in fast jeder Sitzung vor und wäre als Markierung wertlos.
- "kommunikationsstrategie" – es wird beraten, eine Information ZURÜCKZUHALTEN, anders zu benennen als fachlich zutreffend, oder eine Aussage mit Rücksicht auf ihre Wirkung zu formulieren. NICHT setzen für gewöhnliche Pressearbeit, Textabstimmung oder Veröffentlichungstermine.
- "abweichung_von_who_ecdc" – die eigene Bewertung weicht von WHO, ECDC oder anderen Institutionen ab
- "risikobewertung_geaendert" – die Risikobewertung wird geändert oder ihre Änderung diskutiert
- "massnahme_ohne_evidenz" – eine Maßnahme wird erwogen oder beschlossen, obwohl die Evidenzlage ausdrücklich als dünn bezeichnet wird
In "quotes" höchstens 3 wörtliche Kurzzitate (je unter 200 Zeichen) aus dem Protokoll, die die Marker belegen.
Gibt es keine Auffälligkeiten: FLAGS: {"flags": [], "quotes": []}
Die Marker-Bezeichner selbst (z.B. "politischer_druck") gehören ausschließlich in diese Zeile und dürfen im Artikeltext NICHT vorkommen – dort steht, was im Protokoll passiert ist, nicht deine Einordnung.

3. Die DRITTE Zeile MUSS die Überschrift sein: # {{sessionLabel}}

4. Danach folgt der Artikel in genau dieser Gliederung. Abschnitte, für die das Protokoll nichts hergibt, LÄSST DU WEG – erfinde nichts:

## Kopfdaten
Gremium, Datum, Uhrzeit, Sitzungsort, Moderation, Protokollführung, Anlass, Aktenzeichen – als Liste, unverändert aus dem Protokoll übernommen. **Die Teilnehmenden gehören NICHT hierher**, sie haben ihren eigenen Abschnitt.

## Teilnehmende
Die Teilnehmerliste **mit ihrer zweistufigen Struktur**: die Organisationseinheit (z.B. FG36 oder Abteilung 3-Leitung) als Punkt der ersten Ebene, die zugehörigen Personen eingerückt darunter – genau so, wie es im Protokoll steht:

- FG36
  - Walter Haas
  - Udo Buchholz

Zieh die Liste NICHT zu einer Zeile oder einer flachen Aufzählung zusammen. Wer zu welcher Einheit gehört, ist eine eigenständige Information, die dabei verloren geht.

## Lagebild
Die berichtete Lage (Zahlen, Inzidenzen, internationale und nationale Entwicklung). **Alle Zahlen exakt übernehmen**, niemals runden oder zusammenfassen.

## Themen im Einzelnen
Die Tagesordnungspunkte in der Reihenfolge des Protokolls, mit ihren TOP-Nummern.
**Zuordnung erhalten**: steht im Protokoll "FG36: wäre mit dieser Aussage vorsichtig" oder "Schaade: substantielle Zahl von Infektionsketten?", dann bleibt dieses Präfix stehen. Wer etwas gesagt hat, ist hier die wichtigste Information – niemals in unpersönliches Passiv umschreiben.

## Beschlüsse und Aufträge
Jeder Beschluss, jede Festlegung, jeder Arbeitsauftrag als eigener Punkt, mit der verantwortlichen Einheit. Im Protokoll oft als "Beschluss:", "To Do:", "X kümmert sich", "X klärt mit Y" erkennbar.

## Kontroversen und abweichende Positionen
Meinungsverschiedenheiten, Vorbehalte, Warnungen, Abweichungen von externen Einschätzungen (WHO, ECDC, BMG, Länder), Hinweise auf politischen oder zeitlichen Druck, offen gelassene Fragen.
**Zitiere hier wörtlich** als Blockquote, wenn eine Bewertung, Warnung oder Positionierung ausgesprochen wird:
> "es gibt Mensch zu Mensch Übertragung"
Ein Zitat ist belegbar, eine Paraphrase nicht. Wenn es keine Kontroversen gab, lass den Abschnitt weg.

## Offene Punkte
Was ausdrücklich unklar, unentschieden oder auf eine spätere Sitzung verschoben wurde.

(Ein Abschnitt mit einer Kürzel-Liste am Ende ist NICHT erwünscht – die Auflösungen gehören an die erste Nennung im Text, siehe Glossar-Regel.)

5. **Wiki-Link-Regel**: Die available_wiki_pages-Liste zeigt Slugs mit Anzeigenamen ("[[slug]] = Anzeigename"). Erwähnst du einen Namen aus dieser Liste, schreibe ihn als [[slug|Anzeigename]]. Verwende die EXAKTEN Slugs, erfinde keine neuen. Setze pro Begriff höchstens einen Link, beim ersten Vorkommen.
6. **Kein Informationsverlust, aber keine Auffüllung.** Jede Aussage, Zahl, Zuordnung und jeder Beschluss aus dem Protokoll muss vorkommen. Aber blähe nichts auf: keine Einleitungsfloskeln, keine Zusammenfassung am Ende, keine Bewertung durch dich. Wenn das Protokoll knapp ist, ist der Artikel knapp.
7. **Glossar-Regel (streng)**: Der <glossar>-Block enthält geprüfte Auflösungen. Bei der **ersten** Nennung eines dort gelisteten Kürzels schreibe die Langform in Klammern dahinter, z.B. „FG36 (Fachgebiet 36 – Respiratorisch übertragbare Erkrankungen)"; danach nur noch das Kürzel.
**Ein Kürzel, das NICHT im Glossar steht, lässt du unverändert stehen – ohne Erklärung, ohne Klammer, auch wenn du glaubst, es zu kennen.** Eine geratene Auflösung ist hier der schädlichste Fehler überhaupt: sie liest sich autoritativ und entwertet den ganzen Bestand. Für die RKI-internen Kürzel gilt das besonders, weil sich einige über die Jahre geändert haben.
8. Schreibe auf {{language}}.
9. **Leerer-Inhalt-Regel**: Enthält <inhalt> keinen substanziellen Text (z.B. nur "Ausfall des Krisenstabes"), gib exakt aus: "SUMMARY: {{sessionLabel}} – kein inhaltliches Protokoll vorhanden.", dann "FLAGS: {"flags": [], "quotes": []}", dann eine Zeile, die den vorhandenen Text wiedergibt. Erfinde KEINE Themen.
</instructions>

Gib die SUMMARY-Zeile aus, dann die FLAGS-Zeile, dann den Markdown-Artikel. Keine anderen Vorbemerkungen.`;

// ---------------------------------------------------------------------------
// Entity/Concept-Seiten: Einleitung + Belegabschnitt je Quelle
//
// Bis hierher schrieb der Prompt die Seite bei JEDEM Update komplett neu
// ("Erhalte vorhandene Informationen") – gegen ein festes max_tokens von 8192.
// Eine Seite, die in 150 Quellen vorkommt, läuft irgendwann dagegen und
// verliert danach bei jedem weiteren Update Inhalt. Außerdem wuchs damit die
// Eingabe jedes Updates mit der Seitengröße.
//
// Deshalb schreibt das Modell jetzt nur noch zwei beschränkte Dinge: die kurze
// Einleitung (die es fortschreibt) und GENAU EINEN Abschnitt für die neue
// Quelle. Die früheren Abschnitte sieht es gar nicht – sie werden in
// seiteZusammenfügen() unverändert wieder angehängt. Ein- und Ausgabe eines
// Updates sind damit unabhängig davon, wie groß die Seite schon ist.
//
// Aufbau der Prompts: alles, was innerhalb eines Imports für JEDE Seite gleich
// ist (Regeln, Zeitmarken, Linkliste, Anweisungen, Quellenname), steht vorne –
// nur so trifft der Prompt-Cache des Anbieters, der immer das gemeinsame
// Präfix erkennt. Alles Seitenspezifische steht dahinter. Diese Reihenfolge
// bitte beim Bearbeiten beibehalten.
// ---------------------------------------------------------------------------

/** Steht in der Seite über den Belegabschnitten; siehe BELEG_MARKER_RE. */
const BELEG_REGELN = `- **Alle Fakten verwenden**: Der <new_information>-Block enthält WÖRTLICHE Quell-Chunks, jeder mit einem [cNNN]-Label. Verarbeite JEDEN gelieferten Chunk.
- **Nah am Original**: Nutze die Formulierungen der Quelle. Du darfst umordnen, entdoppeln und verwandte Sätze verbinden, aber erfinde keine Übergänge und blähe kurze Aussagen nicht mit Floskeln auf.
- **Nachverfolgbarkeit**: Versieh jede Tatsachenbehauptung, Zahl, Datum oder Beziehung mit dem passenden Inline-Zitat (z.B. [c003]).
- **Keine Halluzination**: Erfinde nichts, was nicht in den Quell-Chunks steht.
- **Du schreibst NUR den Abschnitt für die neue Quelle.** Die Abschnitte früherer Quellen bekommst du nicht zu sehen. Rekonstruiere sie NICHT und beziehe dich nicht auf sie – sie bleiben unverändert erhalten und werden maschinell wieder angehängt.`;

// ---------------------------------------------------------------------------
// Sitzungsprotokolle: chronologische Belegliste
// ---------------------------------------------------------------------------
export const WIKI_PROTOCOL_PAGE_PROMPT = `Du pflegst eine Themenseite, die Aussagen aus vielen Sitzungsprotokollen chronologisch sammelt. Du bist Kompilierer, nicht Autor: du ordnest Belege ein, ohne zu deuten.

### Zitat- und Kompilierungs-Regeln (KRITISCH):
${BELEG_REGELN}
{{timestampRule}}

<valid_wiki_links>
{{availableSlugs}}
</valid_wiki_links>

<instructions>
Gib genau diese Teile in dieser Reihenfolge aus, ohne Vorbemerkung:

1. Die ERSTE Zeile: SUMMARY: {Ein Satz, 15-40 Wörter: was das Thema dieser Seite ist und welche Rolle es in den Sitzungen spielt.}
2. Die ZWEITE Zeile: # {der Titel aus <page_metadata>}
3. Ein Einleitungsabsatz von höchstens 4 Sätzen: was das Thema ist und worum es in den Sitzungen dazu ging. Er ersetzt <bisheriger_stand>: übernimm daraus, was weiterhin gilt, und aktualisiere ihn, statt ihn wachsen zu lassen.
4. Die Zeile: ## Belege nach Sitzung
5. Darunter GENAU EINE Überschrift, wörtlich so:

### {{sessionLabel}}

und darunter, was in dieser Sitzung gesagt oder entschieden wurde, als Bullet-Liste mit Zuordnung (z.B. "FG36:") und Inline-Zitat [cNNN]. **Höchstens 5 Punkte und ein wörtliches Zitat**, dieses als Blockzitat (>), wenn eine Bewertung oder Position ausgesprochen wurde. Keine weitere ###-Überschrift.

Weitere Regeln:
- Jede Aussage muss DIREKT vom Thema in <page_metadata> handeln.
- Setze [[slug|name]]-Links NUR auf Slugs aus <valid_wiki_links>. Erfinde keine Slugs. Der Slug der Seite selbst darf nicht als Link im eigenen Inhalt stehen.
- Erfinde nichts. RKI-Kürzel unverändert beibehalten.
- Schreibe auf {{language}}.
</instructions>

<page_metadata>
  <slug>{{pageSlug}}</slug>
  <title>{{pageTitle}}</title>
  <type>{{pageType}}</type>
  <aliases>{{pageAliases}}</aliases>
</page_metadata>

<bisheriger_stand>
{{bisheriges}}
</bisheriger_stand>

{{additionsSection}}`;

// ---------------------------------------------------------------------------
// Entity/Concept-Seite aktualisieren oder neu erstellen (Normalfall)
// ---------------------------------------------------------------------------
export const WIKI_PAGE_MODIFY_PROMPT = `Du bist ein Wiki-Redakteur, der eine Themenseite um die Belege aus EINER neuen Quelle ergänzt. Du bist ein KOMPILIERER, kein freier Autor: Du verdichtest die gelieferten Quell-Chunks – ohne Fakten zu erfinden und ohne welche wegzulassen.

### Zitat- und Kompilierungs-Regeln (KRITISCH):
${BELEG_REGELN}
{{timestampRule}}

<valid_wiki_links>
{{availableSlugs}}
</valid_wiki_links>

<instructions>
Gib genau diese Teile in dieser Reihenfolge aus, ohne Vorbemerkung:

1. Die ERSTE Zeile: SUMMARY: {Ein Satz, 15-40 Wörter, worum es auf dieser Seite geht.}
2. Die ZWEITE Zeile: # {der Titel aus <page_metadata>}
3. Eine Einleitung von höchstens 5 Sätzen: was das Thema ist und welche Rolle es in den Quellen spielt. Sie ersetzt <bisheriger_stand>: übernimm daraus, was weiterhin gilt, und aktualisiere sie, statt sie wachsen zu lassen.
4. Die Zeile: ## Belege nach Quelle
5. Darunter GENAU EINE Überschrift, wörtlich so:

### {{sessionLabel}}

und darunter die Belege aus <new_information> als Bullet-Liste, gegliedert nach Sachzusammenhang. **Höchstens 8 Punkte und ein wörtliches Zitat**, dieses als Blockzitat (>). Jeder Punkt trägt sein [cNNN]-Zitat. Keine weitere ###-Überschrift.

Weitere Regeln:
- Jede Aussage muss DIREKT vom Thema in <page_metadata> handeln.
- Setze [[slug|name]]-Links NUR auf Slugs aus <valid_wiki_links>. Erfinde keine Slugs. Der Slug der Seite selbst darf nicht als Link im eigenen Inhalt stehen.
- Schreibe auf {{language}}.
</instructions>

<page_metadata>
  <slug>{{pageSlug}}</slug>
  <title>{{pageTitle}}</title>
  <type>{{pageType}}</type>
  <aliases>{{pageAliases}}</aliases>
</page_metadata>

<bisheriger_stand>
{{bisheriges}}
</bisheriger_stand>

{{additionsSection}}`;

// ---------------------------------------------------------------------------
// Duplikate zwischen neuen und existierenden Pages erkennen
// ---------------------------------------------------------------------------
export const WIKI_DEDUP_PROMPT = `Du bist ein striktes Deduplizierungssystem. Bestimme, welche neu extrahierten Elemente sich auf das **exakt gleiche** reale Objekt oder Konzept beziehen wie eine bestehende Wiki-Seite.

<new_items>
{{newItems}}
</new_items>

<existing_pages>
{{existingPages}}
</existing_pages>

<instructions>
### Zusammenführungs-Kriterien – ALLE müssen zutreffen:
1. Das neue Element und die bestehende Seite beziehen sich auf **dasselbe reale Objekt** (dieselbe Person, dieselbe Organisation, dasselbe spezifische Konzept).
2. Es handelt sich um eine **Namensvariation**: Abkürzung ↔ voller Name, Übersetzung oder kleine Rechtschreibunterschiede.
3. Die Typen sind kompatibel: Entitäten werden mit Entitäten zusammengeführt, Konzepte mit Konzepten. **Führe NIEMALS eine Entität mit einem Konzept zusammen oder umgekehrt.**

### Grundsatz: **verwandt ≠ identisch**. Zwei Elemente, die ein paar Zeichen im Namen teilen oder zur selben Domäne gehören, sind KEIN Grund für eine Zusammenführung. Im Zweifel NICHT zusammenführen.

Gib ein JSON-Objekt mit einer "merges"-Map zurück. Der Schlüssel ist der Slug des NEUEN Elements, der Wert ist der Slug der EXISTIERENDEN Seite, in die es eingefügt werden soll. Nur Elemente aufnehmen, bei denen du dir sehr sicher bist.

Falls keine Elemente zu existierenden Seiten passen, gib zurück: {"merges": {}}

### JSON-Formatierungsregeln
- **KRITISCH**: Verwende KEINE literal line breaks in JSON-String-Werten. Verwende \\n.
</instructions>

Gib NUR gültiges JSON aus. Beispiel:
{"merges": {"entity/acme-corporation": "entity/acme-corp", "concept/rag": "concept/retrieval-augmented-generation"}}`;

// ---------------------------------------------------------------------------
// Index-Seiten-Intro generieren
// ---------------------------------------------------------------------------
export const WIKI_INDEX_INTRO_PROMPT = `Du bist ein Wiki-Redakteur. Schreibe eine kurze Einleitung für die Index-Seite eines Wiki-Wissenspools.

<document_summaries>
{{documentSummaries}}
</document_summaries>

<instructions>
1. Schreibe eine Titelzeile beginnend mit "# " die die Wissensdomäne widerspiegelt.
2. Folge mit 2-3 Sätzen, die beschreiben, was dieses Wiki abdeckt, basierend auf den Dokument-Zusammenfassungen oben.
3. Halte es prägnant – dies ist nur der Header-Bereich.
4. Schreibe auf {{language}}.
</instructions>

Gib NUR den Titel und den Einleitungsabsatz aus. Keine Verzeichnislisten oder Seitenlinks.`;

// ---------------------------------------------------------------------------
// Index-Seiten-Intro inkrementell aktualisieren
// ---------------------------------------------------------------------------
export const WIKI_INDEX_INTRO_UPDATE_PROMPT = `Du bist ein Wiki-Redakteur. Aktualisiere den Einleitungsabschnitt einer Wiki-Index-Seite, um kürzliche Änderungen widerzuspiegeln.

<current_introduction>
{{existingIntro}}
</current_introduction>

<changes>
{{changeDescription}}
</changes>

<instructions>
1. Aktualisiere die Einleitung, um den aktuellen Stand des Wikis genau wiederzugeben.
2. Wenn Dokumente hinzugefügt wurden, erwähne die neuen Themen, falls sie den Umfang des Wikis signifikant verändern.
3. Wenn Dokumente entfernt wurden, entferne Verweise auf diese Themen.
4. Behalbe den gleichen Ton, Stil und das gleiche Titelformat wie die bestehende Einleitung.
5. Halte es prägnant – 1 Titelzeile + 2-3 Sätze.
6. Schreibe auf {{language}}.
</instructions>

Gib NUR den aktualisierten Titel und Einleitungsabsatz aus.`;

// ---------------------------------------------------------------------------
// Chunk-Citation: Ordnet jedem Kandidaten die Quell-Chunks zu, die ihn
// substanziell behandeln (erzeugt die [cNNN]-Zitatmarker + neue Slugs).
// ---------------------------------------------------------------------------
export const WIKI_CHUNK_CITATION_PROMPT = `Du bist ein präzises Zitationssystem. Scanne die folgenden Dokument-Chunks und entscheide für jeden Kandidaten unten, welche Chunks ihn SUBSTANZIELL behandeln.

<candidate_slugs>
{{candidateSlugs}}
</candidate_slugs>

<chunks>
{{chunksXml}}
</chunks>

<instructions>
**WICHTIG: Schreibe alle Namen und Details auf {{language}}.**

### Hauptaufgabe
Wähle für jeden Kandidaten-Slug oben die Chunk-IDs (aus dem <chunks>-Block), die diese Entität / dieses Konzept **substanziell behandeln**. "Substanziell" heißt: Der Chunk nennt mindestens einen konkreten Fakt, ein Attribut, einen Schritt, ein Datum, eine Zahl, eine Beziehung oder eine andere nützliche Information über den Kandidaten – keine beiläufige Erwähnung.

- Zitiere nur Chunks, die im <chunks>-Block oben vorkommen.
- Verwende das "id"-Attribut jedes <c>-Elements exakt (z.B. "c003").
- Wenn ein Kandidat in KEINEM Chunk dieses Batches sinnvoll behandelt wird, lass ihn in der Ausgabe weg (keine leeren Arrays).
- Ein Chunk KANN von mehreren Kandidaten zitiert werden.

### Zweitaufgabe: neue Slugs
Falls dieses Batch eine wichtige Entität / ein wichtiges Konzept enthüllt, die/das NICHT in <candidate_slugs> steht, füge sie/es unter "new_slugs" hinzu. Nur wirklich neue, substanziell behandelte Elemente. Jeder Eintrag braucht: "type" ("entity" oder "concept"), "name", "slug" (Format "entity/..." bzw. "concept/..."), "aliases", "description", "details", "source_chunks" (Liste der Chunk-IDs aus diesem Batch).

### JSON-Formatierungsregeln
- **KRITISCH**: Verwende KEINE literal line breaks in JSON-String-Werten. Verwende stattdessen \\n.
- Gib NUR gültiges JSON aus, keine Vorrede.
</instructions>

Ausgabeformat:
{
  "citations": {
    "entity/xxx": ["c001", "c003"],
    "concept/yyy": ["c002"]
  },
  "new_slugs": []
}

Falls nichts zitierwürdig ist, gib zurück: {"citations": {}, "new_slugs": []}`;

// ---------------------------------------------------------------------------
// Granularitäts-Guidance – steuert, wie eifrig die Extraktion Kandidaten
// befördert. Wird in {{granularityGuidance}} von WIKI_CANDIDATE_SLUG_PROMPT
// eingesetzt (Quelle: wiki_config.extraction_granularity).
// ---------------------------------------------------------------------------
export const WIKI_GRANULARITY_FOCUSED = `### Extraktions-Umfang (Granularität: fokussiert)
Extrahiere NUR die wichtigsten Entitäten und Konzepte – insgesamt **3-7 Einträge**. Nimm ausschließlich das auf, was zentral für das Dokument ist und mehrfach substanziell diskutiert wird. Lass Nebenfiguren, beiläufig erwähnte Namen und Randthemen weg. Im Zweifel WEGLASSEN.`;

export const WIKI_GRANULARITY_STANDARD = `### Extraktions-Umfang (Granularität: standard)
Extrahiere die bedeutsamen Entitäten und Konzepte – typischerweise **5-15 Einträge**, abhängig von der Dokumentlänge. Nimm auf, was substanziell diskutiert wird (mindestens zweimal erwähnt oder detailliert beschrieben). Lass triviale, nur einmal namentlich genannte Elemente weg.`;

export const WIKI_GRANULARITY_EXHAUSTIVE = `### Extraktions-Umfang (Granularität: erschöpfend)
Extrahiere JEDE benannte Entität und JEDES erkennbare Konzept (Glossar-Modus). Nimm auch einmalig erwähnte, aber klar identifizierbare Elemente auf. Lass nur reine Füllwörter und generische Begriffe ohne eigenständige Bedeutung weg.`;

export function granularityGuidance(granularity?: string): string {
  switch (granularity) {
    case "focused":
      return WIKI_GRANULARITY_FOCUSED;
    case "exhaustive":
      return WIKI_GRANULARITY_EXHAUSTIVE;
    case "standard":
    default:
      return WIKI_GRANULARITY_STANDARD;
  }
}

// ---------------------------------------------------------------------------
// Prompt-Auswahl nach Dokumentart
//
// Die Art steht in documents.source_metadata.doc_kind – bewusst dort und nicht
// in documents.type: keine Migration nötig, der Typ-Filter im Frontend bleibt
// unberührt (dort steht weiterhin die Dateiendung), und weitere Dokumentarten
// lassen sich ohne Schemaänderung ergänzen.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Auffälligkeits-Marker: geschlossenes Vokabular
//
// Die erlaubten Werte stehen im Prompt – das genügt nicht. Bei 180 Protokollen
// erfand das Modell zehn eigene Varianten (acht Schreibweisen für
// "politischer_druck", "maßnahme_ohne_evidenz" mit ß). Die Facette zerfiel
// dadurch in Einzeltreffer. Wie bei den Wiki-Slugs gilt: das Vokabular
// bestimmt der Code, nicht das Modell.
// ---------------------------------------------------------------------------

export const PROTOCOL_FLAGS = [
  "abweichende_fachliche_position",
  "politischer_druck",
  "datenluecke",
  "kommunikationsstrategie",
  "abweichung_von_who_ecdc",
  "risikobewertung_geaendert",
  "massnahme_ohne_evidenz",
] as const;

export type ProtocolFlag = (typeof PROTOCOL_FLAGS)[number];

/** Bekannte Abweichungen auf den kanonischen Marker abbilden. */
const FLAG_ALIASES: Record<string, ProtocolFlag> = {
  massnahme_ohne_evidenz: "massnahme_ohne_evidenz",
  "maßnahme_ohne_evidenz": "massnahme_ohne_evidenz",
  massnahmen_ohne_evidenz: "massnahme_ohne_evidenz",
  datenlucke: "datenluecke",
  "datenlücke": "datenluecke",
  datenluecken: "datenluecke",
  abweichung_von_who: "abweichung_von_who_ecdc",
  abweichung_von_ecdc: "abweichung_von_who_ecdc",
  abweichende_position: "abweichende_fachliche_position",
  fachlicher_dissens: "abweichende_fachliche_position",
  risikobewertung_aenderung: "risikobewertung_geaendert",
  "risikobewertung_geändert": "risikobewertung_geaendert",
};

/**
 * Normalisiert die Marker eines Artikels: bildet Varianten ab, verwirft
 * Unbekanntes, entdoppelt. Alles, was mit "politisch" beginnt, landet auf
 * politischer_druck – das war die häufigste Erfindung des Modells.
 */
export function normalizeProtocolFlags(raw: unknown): ProtocolFlag[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<ProtocolFlag>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const key = item.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if ((PROTOCOL_FLAGS as readonly string[]).includes(key)) {
      out.add(key as ProtocolFlag);
      continue;
    }
    const mapped = FLAG_ALIASES[key];
    if (mapped) {
      out.add(mapped);
      continue;
    }
    if (key.startsWith("politisch")) {
      out.add("politischer_druck");
      continue;
    }
    // Unbekannt: bewusst verwerfen. Ein Marker, den die Oberfläche nicht kennt,
    // ist als Facette wertlos und verwässert die Zählung.
  }
  return [...out];
}

export type DocKind = "meeting_protocol" | "default";

export function docKindOf(sourceMetadata: unknown): DocKind {
  const kind =
    sourceMetadata && typeof sourceMetadata === "object"
      ? (sourceMetadata as Record<string, unknown>).doc_kind
      : undefined;
  return kind === "meeting_protocol" ? "meeting_protocol" : "default";
}

/** Artikel-Prompt für ein Kapitel/Dokument. */
export function summaryPromptFor(kind: DocKind): string {
  return kind === "meeting_protocol"
    ? WIKI_PROTOCOL_SUMMARY_PROMPT
    : WIKI_SUMMARY_PROMPT;
}

/** Prompt für Entity-/Concept-Seiten. */
export function pagePromptFor(kind: DocKind): string {
  return kind === "meeting_protocol"
    ? WIKI_PROTOCOL_PAGE_PROMPT
    : WIKI_PAGE_MODIFY_PROMPT;
}

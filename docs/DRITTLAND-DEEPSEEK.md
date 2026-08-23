# LLM-Anbieter, Drittländer und wer die Wahl hat

**Stand:** 21. August 2026
**Status:** Der technische Teil ist erledigt. Offen ist **eine Entscheidung**,
und die ist deutlich kleiner geworden als sie am Morgen aussah.

---

## 1. Was sich am 21. August geändert hat

Dieses Dokument stand vorher unter der Annahme, DeepSeek sei **der** Anbieter von
prowiki und die Frage lautete „wie rechtfertigen wir Übermittlungen nach China".
Diese Annahme war falsch. DeepSeek ist nur der Anbieter, den die eine bestehende
Organisation eingetragen hat, und das Ziel ist ausdrücklich: **jede Organisation
trägt ihren eigenen Anbieter samt eigenem Schlüssel ein.**

Damit verschiebt sich die Frage von „wohin senden wir" zu „wohin sendet der
Nutzer". Das ist ein anderer Sachverhalt, kein umformulierter.

### Der Befund, der dazwischenlag

Das Schema trennte die Schlüssel der Mandanten seit dem Livegang
(`model_providers.organization_id`, „bring your own key", KONZEPT 5.4), und die
**Schreibseite** hielt das auch ein. Die **Leseseite** nicht. An fünf Stellen —
`service/llm.ts`, `router/chat.ts`, `service/embedding.ts`, `service/search.ts`,
`service/wiki.ts` sowie im Skript `embed-backfill.ts` — stand dieselbe Abfrage:

```ts
.where(and(eq(modelProviders.is_active, true), eq(modelProviders.provider_type, "chat")))
.limit(1)
```

Kein `organization_id`. Kein `ORDER BY`. Mit einer Organisation fällt das nicht
auf; mit zwei hätte es bedeutet:

- Inhalte von Organisation A gehen über den **Schlüssel von B**, auf deren Rechnung.
- Und an einen **Anbieter, den A nie gewählt hat** — womit jede Aussage über das
  Empfängerland falsch wird, auch die auf der Datenschutzseite.
- Bei der Suche zusätzlich sinnlos: `search.ts` und `embedding.ts` hätten Anfrage
  und Chunks von verschiedenen Modellen einbetten können. Zwei Modelle spannen
  verschiedene Vektorräume auf, Kosinusähnlichkeit zwischen ihnen bedeutet nichts.

Behoben in [`service/provider.ts`](../backend/src/service/provider.ts): eine
Auswahl statt sechs, immer mit Mandant, mit gleichbleibender Reihenfolge. Durch
einen Test belegt, bei dem der Provider der *anderen* Organisation absichtlich
zuerst angelegt wird — nach der alten Regel hätte er gewonnen.

Dazu behoben: die Spalte hieß `api_key_encrypted` und enthielt **Klartext**. Bei
eigenen Schlüsseln eine Formsache, bei Kundenschlüsseln ein Vorfall, denn der
nächtliche Dump liegt auf derselben Platte. Jetzt AES-256-GCM mit einem aus
`AUTH_SECRET` abgeleiteten Schlüssel ([`service/crypto.ts`](../backend/src/service/crypto.ts)),
Bestand über [`scripts/encrypt-provider-keys.ts`](../backend/src/scripts/encrypt-provider-keys.ts).

## 2. Was jetzt tatsächlich passiert

| Wohin | Was | Wer bestimmt das Land |
|---|---|---|
| Chat-Anbieter der Organisation | Chatfrage samt der per RAG geholten Textabschnitte | **die Organisation** |
| derselbe Anbieter | beim Import die **Kapitel des Dokuments** — auch ohne Frage | **die Organisation** |
| Embedding-Anbieter der Organisation | Textabschnitte zur Vektorberechnung | **die Organisation** |
| Apify / Supadata | nur Video-Adressen, keine Nutzereingaben | EU / USA, unkritisch |

Zwei Dinge daran sind wichtig und werden leicht übersehen:

- **Es geht nicht nur um Chatfragen.** Wer ein Video oder eine PDF importiert,
  übermittelt deren Inhalt — die Wiki-Generierung schickt Kapitel an dasselbe
  Modell. „Dann frag im Chat einfach nichts Sensibles" greift nicht.
- **Es gibt kein stilles Ausweichen.** Hat eine Organisation keinen aktiven
  Anbieter, findet **keine** Übermittlung statt und der Chat bleibt ohne
  Ergebnis. Der Rückfall auf einen Plattform-Provider hängt an
  `ALLOW_PLATFORM_PROVIDER` und ist standardmäßig **aus**. Das ist der Kern:
  wer seinen eigenen Anbieter einträgt, weil er nicht nach China senden will,
  darf nicht unbemerkt doch dort landen, wenn sein Schlüssel abläuft. Ein leerer
  Chat ist ein Fehler, den man sieht.

## 3. Was damit rechtlich noch offen ist

Weniger als vorher, aber nicht nichts.

**Erledigt ist die Wahl des Empfängers.** Wenn die Organisation den Anbieter
einträgt, ist die Auswahl des Empfängers ihre Entscheidung und nicht unsere. Das
ist der Unterschied zwischen „prowiki sendet nach China" und „prowiki sendet
dorthin, wohin der Kunde es eingerichtet hat" — und es ist die Struktur, die
Anbieter von Selbst-Hosting-Werkzeugen üblicherweise haben.

**Nicht erledigt ist die Aufklärung und die Rolle.** prowiki führt die
Übermittlung technisch aus. Daraus folgt:

1. **Die Datenschutzseite muss das so sagen** — und tut es seit dem 21. August:
   sie nennt nicht mehr DeepSeek als *den* Anbieter, sondern erklärt, dass die
   Organisation ihn wählt, was in welchem Fall übertragen wird (inklusive der
   Importe) und dass bei einem Anbieter außerhalb der EU eine Drittlandübermittlung
   vorliegt, deren Land sich aus der eigenen Wahl ergibt.
   [`frontend/src/views/legal/Privacy.vue`](../frontend/src/views/legal/Privacy.vue)
2. **Die Oberfläche sollte den aktiven Anbieter zeigen**, nicht nur die
   Einstellungsseite. Wer im Chat sitzt, sollte sehen können, wohin seine Frage
   geht. Das ist noch offen und die naheliegende nächste Kleinigkeit —
   `holeProvider` liefert `name` und `herkunft` schon mit.
3. **Für eigene Kunden mit eigenem Schlüssel** bleibt prowiki für die *Speicherung*
   verantwortlich, für die Übermittlung an den selbstgewählten Anbieter aber auf
   deren Weisung. Ein Auftragsverarbeitungsvertrag zwischen prowiki und dem
   Kunden regelt das; das ist ohnehin fällig, sobald jemand zahlt, und unabhängig
   von dieser Frage.

**Der Fall, in dem die alte Frage zurückkommt:** sobald `ALLOW_PLATFORM_PROVIDER=1`
gesetzt wird, also mit einem Tarif „Kontingent inklusive". Dann sendet prowiki
wieder über einen selbst gewählten Anbieter, und dann gilt Abschnitt 4 in voller
Länge. Deshalb steht der Schalter auf 0, und deshalb ist die Vorgabe kein Zufall.

## 4. Wenn ein Plattform-Anbieter kommt: die drei Wege

Nur für den Fall aus dem letzten Absatz. Für „bring your own key" ist nichts
davon nötig.

- **Standardvertragsklauseln plus Folgenabschätzung** (Art. 46). Der formal
  richtige Weg. Erste Hürde: zeichnet der Anbieter sie überhaupt. Zweite: ein
  ehrliches Transfer Impact Assessment kommt bei China schwer zu einem
  „tragfähig", weil die dortige Sicherheitsgesetzgebung staatlichen Zugriff
  einräumt, gegen den ein privater Vertrag wenig ausrichtet — und bei
  Klartext-Prompts an ein Sprachmodell gibt es keine technische Zusatzmaßnahme,
  die das rettet. Verschlüsselung hilft nicht, wenn der Empfänger den Klartext
  lesen muss, um zu antworten.
- **Einwilligung** (Art. 49 Abs. 1 lit. a). Ein nicht vorausgewähltes Häkchen bei
  der Registrierung mit klarem Text und einem Vermerk am Konto. Billig und für
  einen kleinen Kreis vertretbar. Grenze: die Vorschrift ist für
  *gelegentliche* Übermittlungen gedacht, nicht für Dauerbetrieb mit hunderten
  Kunden.
- **Einen Plattform-Anbieter in der EU oder unter dem Angemessenheitsbeschluss
  wählen.** Kostet Geld statt Rechtsrisiko und ist die einzige Variante, die
  auch bei Stufe 4 trägt. Was der Unterschied ausmacht, ist seit dem
  21. August **messbar**: `usage_events` zählt Tokens je Art und Modell
  ([`service/usage.ts`](../backend/src/service/usage.ts),
  `GET /api/v1/usage/wiki/:wikiId`) — und seit dem 23. August auch ablesbar,
  im Reiter „💶 Kosten" eines Wiki. Wer den Anbieterwechsel gegen den Preis
  abwägen will, findet die Grundlage dort statt in `psql`.

**Empfehlung für diesen Fall:** den Plattform-Anbieter von Anfang an in der EU
oder den USA wählen und DeepSeek denjenigen lassen, die ihn selbst eintragen. Der
Preisunterschied trifft dann nur das eigene Kontingent, nicht die Rechtslage.

## 5. Was ausdrücklich nicht offen ist

- **Die USA.** Der Angemessenheitsbeschluss trägt Übermittlungen dorthin.
- **Ein Einwilligungsbanner.** prowiki hat kein Tracking und keine
  Dritt-Cookies. Das hier ist eine Frage der Übermittlungsgrundlage, nicht des
  TTDSG.
- **Der Anbieterwechsel als Umbau.** Er ist eine Zeile in der Datenbank: alle
  Aufrufe gehen über dieselbe OpenAI-kompatible Schnittstelle, und die Provider
  stehen in `model_providers`. Wer glaubt, dafür müsse Code geändert werden,
  liest `service/provider.ts` und ist beruhigt.

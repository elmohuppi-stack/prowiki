# prowiki — Konzept & Befunde

**Stand:** 2. August 2026
**Ausgangspunkt:** `~/workspace/knora` (live auf Hetzner, 5.703 Wiki-Seiten, 77.028 Zeilen in der DB)
**Ziel:** aus dem persönlichen Second Brain ein Produkt machen, das Dritte (YouTuber,
Redaktionen, Agenturen) für ihr eigenes öffentliches oder internes Wiki nutzen.

---

## 1. Was knora schon trägt

Der inhaltliche Kern ist da und produktiv erprobt — das ist der Grund, prowiki nicht
bei Null zu beginnen:

| Baustein | Zustand |
|---|---|
| Ingest: Upload (PDF/DOCX/HTML via MarkItDown), URL-Scraping, YouTube-Transkript | funktioniert, inkl. großer Dateien |
| Chunking + Embedding (pgvector, `text-embedding-3-small`, HNSW-Index) | funktioniert, Index seit Migration `0009` reproduzierbar |
| Hybride Suche (Vektor + tsvector + Trigramm) | 1,45 ms warm auf 5.703 Seiten |
| Wiki-Generierung kapitelweise über ganze Dokumente, Taxonomie Summary/Concept/Entity | funktioniert, steuerbare Tiefe |
| `[[Slug]]`-Verlinkung, Backlinks, D3-Graph, Themen-Cluster | funktioniert |
| RAG-Chat mit Quellen, SSE-Streaming, Verlaufskontext | funktioniert |
| Versionshistorie + Edit-Lock (`wiki_page_revisions`, `manually_edited`) | Backend fertig, Frontend nur teilweise |
| Draft/Review/Publish für Artikel-Verbünde | funktioniert (Chat → Wiki) |
| Betrieb: Compose, Healthchecks, Speicherdeckel, tägliches Backup mit geprüftem Restore | seit 2. August solide |

**Wiederverwendbar: schätzungsweise 70–80 % der ~25.800 Zeilen.** Alles was mit Inhalt zu
tun hat, bleibt. Was ersetzt werden muss, ist die Schicht darunter: Identität, Mandanten,
Rechte, Sichtbarkeit, Jobs.

---

## 2. Befunde Auth & Rechte — das ist der Blocker

knoras Rechtemodell ist für genau einen Betreiber gebaut, der allen Nutzern vertraut.
Das ist für ein persönliches Werkzeug richtig und für ein Produkt untragbar. Die Befunde
in der Reihenfolge ihrer Schwere:

### 2.1 Hardcodierte Superuser-Hintertür

`service/auth.ts:49-85` vergleicht die eingegebenen Zugangsdaten **im Klartext** gegen
`ADMIN_EMAIL`/`ADMIN_PASSWORD` aus der `.env` — vor jeder DB-Abfrage. Default:
`admin@knora.app` / `admin123`. Zusätzlich erhebt `middleware/auth.ts:60` jeden Nutzer,
dessen E-Mail `ADMIN_EMAIL` entspricht, ungeachtet der DB-Rolle zum Admin:

```ts
role: (dbUser.email === ADMIN_EMAIL ? "admin" : dbUser.role)
```

Wer sich mit dieser Adresse registriert, ist Admin. Wer die `.env` liest, ist Admin über
alle Mandanten. In einem Multi-Tenant-Produkt ist das ein Totalschaden — muss vollständig
raus, ersatzlos.

### 2.2 Tokens sind nicht widerrufbar

Die Tabelle `sessions` existiert im Schema (`schema.ts:25`) und wird **von keiner Zeile
Code benutzt**. Auth ist ein zustandsloses JWT mit 7 Tagen Laufzeit, `logout()` löscht nur
`localStorage`. Folgen: ein abgegriffenes Token gilt eine Woche, ein Passwortwechsel
beendet keine Sitzung, ein entlassener Mitarbeiter behält Zugriff, „auf allen Geräten
abmelden" ist unmöglich. Für ein Produkt mit Teams ist das nicht verhandelbar.

### 2.3 Offene Registrierung ohne Verifikation

`router/auth.ts:20` — `POST /register` ist öffentlich, ohne E-Mail-Verifikation, ohne
Einladungs-Flow, ohne Rate-Limit. Jeder legt sich einen Account an. Es gibt außerdem
**keinen** Passwort-Reset-Endpunkt: wer sein Passwort vergisst, braucht den Betreiber.

### 2.4 Keine Rate-Limits, keine Sperren

Nirgends im Backend ein Rate-Limit — auch nicht auf `/login`. Brute-Force ist ungebremst,
Account-Lockout existiert nicht. Genauso ungebremst: Import- und Chat-Endpunkte, die echtes
Geld kosten (LLM-Tokens, Apify-Calls).

### 2.5 Rollen sind zu grob und falsch verkoppelt

Zwei Ebenen (`middleware/workspace-access.ts:9-23`): global `admin|editor|viewer`, pro
Workspace `owner|editor|viewer`. Schreiben verlangt beides. Konsequenz aus
`canWrite()` (Zeile 79):

```ts
if (user.role === "viewer") return false;   // global schlägt lokal
```

Ein global als `viewer` angelegter Nutzer kann **im eigenen Workspace nichts schreiben**.
Für ein Produkt, in dem jede Selbstregistrierung sofort ihr eigenes Wiki betreiben soll,
ist diese Verkopplung genau verkehrt. Außerdem fehlt jede Abstufung, die redaktionelle
Arbeit braucht: Autor darf schreiben aber nicht veröffentlichen, Reviewer darf freigeben
aber nicht importieren, Buchhaltung sieht Rechnungen aber keine Inhalte.

### 2.6 Keine Mandantenebene

Ein Workspace gehört einem Nutzer (`workspaces.created_by`). Es gibt keine Organisation,
kein Team, keine Sitzverwaltung, keine Eigentumsübertragung, keine Abrechnungseinheit. Ein
YouTube-Kanal ist aber nicht eine Person: Basta Berlin sind zwei Hosts plus Zulieferer,
eine Agentur betreut zehn Kanäle. Ohne Org-Ebene lässt sich das nicht abbilden und nicht
abrechnen.

### 2.7 Nichts ist öffentlich zugänglich

Ein `grep` über das gesamte Repo findet **kein** `is_public`, `visibility` oder `anonymous`.
Alle Router hängen hinter `authMiddleware`. Die zentrale Produktanforderung — „bei Bedarf ist
dieses Wiki öffentlich verfügbar" — hat aktuell keinen einzigen Anknüpfungspunkt im Code.

### 2.8 Kleinere Befunde

- `index.ts:19-28`: `cors({ origin: "*" })` über alle Routen. Mit Bearer-Token im
  `localStorage` heute nicht direkt ausnutzbar, aber es blockiert den Umstieg auf
  Cookie-Sessions (die für SSR nötig sind) und muss ohnehin pro Mandant/Domain werden.
- JWT im `localStorage` (`stores/auth.ts:6`) ist XSS-exponiert. Bei einem Wiki, das
  fremdes HTML/Markdown rendert, ist das die falsche Ablage — `httpOnly`-Cookie.
- Kein Audit-Log für Sicherheitsereignisse. `activity_logs` protokolliert Importe und
  Wiki-Läufe, aber keine Logins, Rollenwechsel, Freigaben, Löschungen.
- Kein 2FA, kein SSO/OIDC, keine API-Keys. Professionelle Käufer fragen nach allen dreien.
- `workspaceParamAccess()` (Zeile 135) fällt auf „erste UUID im Pfad" zurück, wenn der
  Router-Parameter fehlt. Pragmatisch, aber die Autorisierung sollte nicht an einem
  Regex über dem Pfad hängen.
- ~~Der DB-Nutzer der App ist auf dem Server **SUPERUSER**.~~ **Erledigt am 2. August**
  (`platform/OFFENE-PROBLEME.md` Punkt 5): knora verbindet sich seit dem Umbau als
  unprivilegierte Rolle `knora_app`; `knora` ist nur noch Bootstrap- und Wartungsrolle und
  gehört in keinen Verbindungsstring. Für prowiki gilt dieselbe Regel von Anfang an — eine
  eigene, unprivilegierte Rolle je Datenbank, ohne SUPERUSER, CREATEROLE, CREATEDB,
  REPLICATION oder BYPASSRLS. Das ist zugleich Voraussetzung für Row-Level-Security (4.1).

### 2.9 Empfehlung: Auth nicht selbst bauen

Punkte 2.1–2.4 und 2.8 sind gelöste Probleme. Sie selbst zu implementieren heißt, in einem
sicherheitskritischen Bereich Code zu schreiben, den man dauerhaft pflegen muss.

**Empfehlung: [Better Auth](https://better-auth.com).** Gründe: TypeScript-nativ, läuft in
Bun/Hono, hat einen Drizzle-Adapter (bleibt in derselben Postgres-DB, kein zweiter Dienst),
und liefert genau das fehlende Set fertig — Sessions in der DB mit Widerruf, E-Mail-Verifikation,
Passwort-Reset, 2FA/Passkeys, OIDC/SSO für Enterprise-Kunden, API-Keys, Rate-Limiting. Das
`organization`-Plugin bringt Orgs, Mitglieder, Einladungen und Rollen mit; die
Sichtbarkeits- und Capability-Logik aus Abschnitt 4 bleibt unsere.

Alternativen, kurz gewogen:

| Option | Für | Gegen |
|---|---|---|
| **Better Auth** *(empfohlen)* | eine DB, ein Prozess, TS-Typen Ende-zu-Ende, Orgs im Plugin | Bibliotheks-Bindung, jung |
| Zitadel (self-hosted) | echter OIDC-Provider, Orgs eingebaut, auditiert | zweiter Dienst + eigene DB auf einem 3,7-GB-Host |
| Keycloak | Industriestandard | schwer, JVM, RAM |
| Clerk / WorkOS | nichts zu betreiben | laufende Kosten pro Nutzer, Nutzerdaten außer Haus |
| selbst bauen | keine Abhängigkeit | wir schreiben Passwort-Reset, 2FA und Session-Widerruf von Hand |

---

## 3. Befunde Skalierung — 300+ Videos gehen so nicht

### 3.1 Es gibt keinen Kanal-Import

`POST /documents/import-youtube` (`router/document.ts:285`) nimmt **eine** Video-URL.
300 Videos = 300 Formulareingaben. Ein Kanal-Import fehlt vollständig.

### 3.2 Der Import blockiert den Request

Derselbe Endpunkt ruft `fetchYouTubeInfo()` **synchron im Request** auf (Zeile 316) und
antwortet erst danach. Bei Apify sind das je Video Sekunden bis Minuten. Nur Chunking und
Wiki-Generierung sind danach ausgelagert — per `setTimeout` (Zeile 369/376).

### 3.3 Jobs sind flüchtig

`setTimeout` im API-Prozess ist keine Queue: kein Retry, keine Persistenz, keine
Nebenläufigkeitsgrenze, keine Sichtbarkeit, keine Idempotenz. Ein `docker compose up
--build` mitten im Lauf verliert alle laufenden Importe stillschweigend. `docs/PLAN.md`
benennt das selbst als „nächster empfohlener Ausbau" — bei 300 Videos ist es kein Ausbau
mehr, sondern die Voraussetzung.

### 3.4 Keine Deduplizierung, keine Fortschreibung

`source_url` hat keinen Unique-Index. Derselbe Kanal zweimal importiert = alles doppelt,
inklusive doppelter Embedding- und LLM-Kosten. Und es gibt keinen Mechanismus, der neue
Videos eines Kanals nachzieht — ein Wiki, das ab Import-Datum einfriert, ist für einen
laufenden Kanal wertlos.

### 3.5 Zeitstempel werden weggeworfen

`buildDocumentContent()` (`service/youtube.ts:149`) plattet das Transkript zu Fließtext.
Die Segmentzeiten der Provider gehen verloren. Damit ist die naheliegendste Funktion eines
Video-Wikis nicht baubar: aus einem Satz im Artikel per Klick an die passende Sekunde im
Video springen (`?t=1234`). **Das ist die Funktion, die ein Video-Wiki von einem Textwiki
unterscheidet** — und die Daten liegen beim Import vor. Sie zu verwerfen kostet später
einen vollständigen Re-Import.

### 3.6 Keine Kostenkontrolle

`activity_logs` hält `duration_ms`, aber keine Tokens und keine Kosten. Niemand kann sagen,
was ein Kanal-Import gekostet hat. Ohne Zählung pro Mandant und harte Deckel ist jeder Tarif
und jeder öffentliche Chat ein unkalkulierbares Risiko.

---

## 4. Zielarchitektur prowiki

### 4.1 Mandanten- und Rechtemodell

Drei Ebenen statt zwei:

```
organization          Abrechnungs- und Vertrauensgrenze (Kanal, Redaktion, Agentur)
  └─ wiki             was heute "workspace" heißt; hat eine Sichtbarkeit
       └─ page        Artikel; kann eigene Sichtbarkeit haben (Entwurf, intern)
```

Neue Tabellen (Namen als Vorschlag):

```
organizations          id, slug, name, plan, custom_domain, branding, created_at
org_members            org_id, user_id, role, invited_by, joined_at
org_invitations        org_id, email, role, token, expires_at, accepted_at
wikis                  org_id, slug, name, visibility, settings…   (ersetzt workspaces)
wiki_members           wiki_id, user_id, role                       (optionaler Override)
usage_events           org_id, kind, tokens_in, tokens_out, tokens_cached, cost_micros, ref_id, created_at
audit_events           org_id, actor_id, action, target, ip, user_agent, created_at
api_keys               org_id, name, hash, scopes, last_used_at, expires_at
```

**Rechte über Capabilities, nicht über Rollen-Vergleiche.** Rollen sind nur benannte Bündel;
geprüft wird immer eine Capability an einer zentralen Stelle. Das behebt 2.5 und macht
später eigene Rollen pro Org möglich, ohne `canWrite()` anzufassen.

| Capability | owner | admin | editor | author | reviewer | viewer | anonym (öffentlich) |
|---|---|---|---|---|---|---|---|
| `wiki.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | nur `public` |
| `wiki.write` | ✓ | ✓ | ✓ | ✓ | – | – | – |
| `wiki.publish` | ✓ | ✓ | ✓ | – | ✓ | – | – |
| `wiki.delete` | ✓ | ✓ | – | – | – | – | – |
| `source.import` | ✓ | ✓ | ✓ | – | – | – | – |
| `chat.use` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | wenn freigeschaltet |
| `member.manage` | ✓ | ✓ | – | – | – | – | – |
| `billing.manage` | ✓ | – | – | – | – | – | – |
| `settings.manage` | ✓ | ✓ | – | – | – | – | – |

Sichtbarkeit pro Wiki: `private` (nur Mitglieder) · `link` (unlisted, wer die URL hat) ·
`public` (indexierbar) · später `members` (Paywall, Abschnitt 5.4).

Zusätzlich als zweites Netz: **Row-Level-Security in Postgres** auf `org_id`. Damit kann ein
vergessener `where`-Filter in einer Query keine Fremddaten mehr ausliefern. Setzt die
unprivilegierte DB-Rolle aus Befund 2.8 voraus.

### 4.2 Öffentliches Lesen braucht Server-Rendering

Ein öffentliches Wiki, das nicht gefunden wird, hat seinen Zweck verfehlt — und genau das
ist der Nutzen für einen YouTuber: seine Inhalte werden durchsuchbar und auffindbar. Die
heutige Vue-SPA rendert im Browser, ohne Meta-Tags, ohne Sitemap, ohne saubere URLs.

**Vorschlag: Aufteilung in zwei Frontends bei einem Backend.**

- **Lese-Seite (neu, Nuxt 4 SSR/ISR):** öffentliche Wikis, SEO-Meta, OpenGraph, Sitemap,
  Canonical-URLs, schnelle Erstauslieferung, öffentlicher Chat und Suche. Aggressiv gecacht
  — öffentliche Artikel ändern sich selten, das entlastet den kleinen Host.
- **Autoren-App (bestehende Vue-SPA):** Import, Editor, Review, Graph, Mitglieder,
  Einstellungen. Die vorhandenen ~25.000 Zeilen UI bleiben nutzbar; nur Auth und
  Org-Auswahl werden umgebaut. Kein SEO-Bedarf, keine Notwendigkeit zu portieren.

Adressraum: `wiki.example.com/<org>/<wiki>/<slug>`, dazu Custom Domains pro Org. Für
Kundendomänen ist **Caddy mit On-Demand-TLS** deutlich weniger Arbeit als certbot pro
Domain — ein Zertifikat entsteht beim ersten Aufruf, wenn die Domain in `organizations`
freigegeben ist.

### 4.3 Persistente Job-Queue

**Vorschlag: [pg-boss](https://github.com/timgit/pg-boss)** — Queue in der vorhandenen
Postgres-DB. Kein Redis (bleibt der Entscheidung in `PLAN.md` treu), aber persistent, mit
Retry mit Backoff, Nebenläufigkeitsgrenzen, Cron und Dead-Letter-Queue. Alternativen sind
Graphile Worker (gleiches Prinzip) oder BullMQ (braucht Redis).

Wichtig: **ein eigener Worker-Container**, getrennt vom API-Container. Ein Wiki-Lauf über
300 Videos darf die API nicht ausbremsen, und beide brauchen unterschiedliche
Speicherdeckel. Job-Typen:

```
channel.sync      Kanal enumerieren → je neues Video einen video.ingest-Job
video.ingest      Metadaten + Transkript holen, Dokument anlegen  (idempotent über external_id)
document.chunk    Chunking + Embedding
wiki.generate     Artikel erzeugen
wiki.relink       Backlinks/Graph nachziehen
wiki.lint         Wiki gegen sich selbst prüfen (4.7), als Cron
```

Fortschritt gehört ins UI: „147 von 312 Videos verarbeitet, 3 fehlgeschlagen" mit
Wiederholen pro Video. Der `ActivityBar` ist der vorhandene Anknüpfungspunkt.

### 4.4 Kanal-Import, der 300 Videos trägt

- **Backfill:** YouTube Data API v3, `playlistItems` über die Uploads-Playlist des Kanals.
  50 Videos pro Call zu 1 Quota-Einheit — 300 Videos sind 6 Einheiten von 10.000 pro Tag.
  Vernachlässigbar.
- **Fortschreibung:** der RSS-Feed `youtube.com/feeds/videos.xml?channel_id=…` liefert die
  letzten 15 Videos ohne API-Quota. Als `channel.sync`-Cron stündlich — neue Videos landen
  automatisch im Wiki.
- **Transkripte:** unverändert über die vorhandenen Provider (Apify/Supadata).
- **Deduplizierung:** neue Spalte `documents.external_id` mit Unique-Index über
  `(wiki_id, external_id)`. Ein zweiter Import desselben Kanals ist dann ein No-Op statt
  einer Kostenverdopplung.
- **Segment-Zeiten erhalten** (Befund 3.5): Tabelle `transcript_segments`
  (`document_id, start_ms, end_ms, text, speaker?`). Die Wiki-Generierung führt die
  Zeitmarken durch bis in die Zitate, sodass jeder Artikelabsatz auf
  `youtube.com/watch?v=…&t=1234` verlinkt. Diese Entscheidung sollte **vor** dem ersten
  großen Import fallen — nachrüsten heißt alle Transkripte erneut holen (bei Apify: erneut
  bezahlen).

### 4.5 Kostenkontrolle

`usage_events` bei jedem LLM- und Provider-Aufruf, aggregiert pro Org und Monat. Daran
hängen: Tarifgrenzen (Videos/Monat, Tokens/Monat), harte Deckel mit Vorwarnung, ein
Kostenvoranschlag **vor** einem Kanal-Import („312 Videos, ~48 h Material, geschätzt
X €, fortsetzen?"), und ein eigener, strengerer Deckel für anonymen Chat auf öffentlichen
Wikis, damit ein viraler Link keine Rechnung erzeugt.

---

### 4.6 Betrieb, Kapazität und Hosting

Betriebsumgebungen (lokal / Staging / Produktion), die gemessene Kapazität des bestehenden
Servers, der Anbietervergleich und die Serverentscheidung stehen in einem eigenen Dokument:
**[HOSTING.md](./HOSTING.md)**.

Für die Architektur hier genügen zwei Ergebnisse daraus:

- **RAM ist die bindende Größe**, nicht CPU — wegen des Vektorindex (541 MB für ein Wiki mit
  5.703 Seiten), der im Arbeitsspeicher liegen muss.
- **Vor dem ersten großen Import ist kein neuer Server nötig.** Stufe 0 läuft vollständig
  lokal gegen `docker-compose.dev.yml`.

### 4.7 Wiki-Pflege: der Lint-Lauf

Die Generierung schreibt Seiten fort, aber niemand prüft das Ergebnis als Ganzes. Bei knora
war das verschmerzbar, weil jede Quelle einzeln und unter Aufsicht hereinkam. Der
Kanal-Import aus 4.4 kehrt das um: 312 Videos laufen in einem Vorgang durch, ohne dass ein
Mensch dazwischensteht. Damit wird eine Prüfung *nach* dem Lauf zur Voraussetzung dafür, dem
Ergebnis zu trauen — und zwar mehr als bei einem Werkzeug, das man von Hand füttert.

Der Lint-Lauf ist ein Job (`wiki.lint`, als Cron je Wiki und nach jedem größeren Import), der
das Wiki gegen sich selbst prüft. Er ändert nichts, er meldet:

| Befund | Woraus er sich ergibt |
|---|---|
| Widersprüche zwischen Seiten | zwei Seiten behaupten Gegensätzliches über dieselbe Entität |
| überholte Aussagen | eine neuere Quelle widerspricht einem älteren Belegabschnitt derselben Seite |
| Waisenseiten | Seite ohne eingehenden `[[Slug]]` — die Backlink-Tabelle liegt vor |
| fehlende Seiten | Begriff taucht häufig auf, hat aber keine eigene Seite |
| fehlende Querverweise | Seite nennt eine Entität, die es als Seite gibt, ohne sie zu verlinken |
| Lücken | Thema mit dünner Belegdecke — Hinweis, welche Quelle noch fehlt |

Die Befunde landen nicht im Log, sondern in einer **Redaktions-Inbox** je Wiki: eine Liste mit
Seitenbezug, die man abarbeitet, zuweist oder verwirft. Sie ist der Gegenpol zum Batch-Import
und zugleich die Grundlage für den Freigabe-Workflow aus Stufe 3.

Zwei Dinge fallen dabei ab. Erstens ist „überholte Aussage" mechanisch dieselbe Abfrage wie
der **Positionswandel** aus 5.2 — der Lint-Lauf ist der Motor für dieses Feature, nicht ein
zweites System daneben. Zweitens ist die Kostenseite zu beachten: ein Lint über ein Wiki mit
5.703 Seiten ist kein kleiner Lauf. Er gehört unter dieselbe Zählung und denselben Deckel wie
alles andere (4.5), mit einstellbarem Umfang — täglich nur das seit dem letzten Lauf
Geänderte, vollständig nur auf Anforderung.

---

## 5. Weitere Vorschläge — was prowiki zum Werkzeug macht

Über die Frage hinaus, sortiert nach Verhältnis von Nutzen zu Aufwand.

### 5.1 Sofort wertvoll, kleiner Aufwand

1. **Tiefe Video-Links** (siehe 4.4). Jeder Absatz zeigt auf die Sekunde. Alleinstellungsmerkmal.
2. **Einbettbares Widget.** Ein `<script>`-Schnipsel, den ein YouTuber auf seine eigene
   Seite legt: Suchfeld plus Chat-Bubble über seinem Wiki. Sein Publikum bleibt bei ihm,
   der Traffic ist unserer. Stärkster Vertriebskanal, den dieses Produkt haben kann.
3. **Fehler melden.** Ein Knopf unter jedem öffentlichen Artikel. LLM-generierte Inhalte
   haben Fehler; das Publikum eines Kanals findet sie zuverlässig und gern.
4. **Export als OKF-Bundle (Obsidian-kompatibel).** Markdown-ZIP plus JSON pro Wiki. Nimmt
   Interessenten die Angst vor Lock-in — und kostet einen Tag Arbeit. Der Hebel liegt in der
   Form. Googles [Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
   (OKF v0.1, 12. Juni 2026) legt für genau dieses Muster Feldnamen fest: ein Verzeichnis
   Markdown-Dateien mit YAML-Frontmatter, ein Pflichtfeld `type`, dazu `title`,
   `description`, `resource`, `tags`, `timestamp`; `index.md` und `log.md` sind reservierte
   Dateinamen. Was wir dafür brauchen, liegt fast vollständig vor:

   | Bei uns | OKF |
   |---|---|
   | Taxonomie Summary/Concept/Entity | `type` — Vokabular definiert der Produzent |
   | Seitenindex | `index.md` |
   | Änderungs-Chronik (Punkt 8) | `log.md` |
   | `source_url` / tiefer Video-Link | `resource` |
   | `[[Slug]]` | gewöhnliche Markdown-Links — **die einzige echte Umstellung** |

   Weil Obsidian gewöhnliche Markdown-Links liest, ist ein OKF-konformer Export gleichzeitig
   ein benutzbarer Vault: ein Export, zwei Zwecke, keine doppelte Arbeit. Der Gewinn ist ein
   Verkaufsargument — „Ihr Wiki liegt in einem offenen Standard vor" schlägt bei Redaktionen
   und Firmenkunden „Sie bekommen ein ZIP". Wichtig ist die Beschränkung: OKF wird **nur an
   der Außenkante gesprochen**. Intern bleiben Seiten in Postgres mit Revisionen,
   Chunk-Bezügen, Sichtbarkeit und Mandant — ein Dateiformat ist dafür kein Ersatz, und OKF
   v0.1 von einem einzigen Anbieter ist zu jung für eine Wette auf das Datenmodell. Auch die
   dortige Navigationsidee (der Agent liest `index.md` und steigt ab) übernehmen wir nicht:
   dieselbe Index-first-Annahme wie bei Karpathy, die bei 5.703 Seiten nicht trägt. Unsere
   hybride Suche bleibt.
5. **Sitemap, OpenGraph, `robots.txt`, RSS je Wiki.** Fällt mit 4.2 fast von selbst ab.
6. **Analytics pro Wiki:** meistgelesene Artikel, gestellte Fragen, Fragen ohne gute
   Antwort. Letzteres ist redaktionell Gold — es zeigt, worüber das nächste Video geht.
   Umami läuft auf dem Server bereits.
7. **Redaktionsanweisung je Wiki.** `wiki_config` (`schema/tenancy.ts`) kennt heute nur
   Schalter: Sprache, Tiefe, Granularität. Was fehlt, ist ein Freitextfeld, das in
   `service/wiki-prompts.ts` einfließt — Tonfall, welche Seitentypen es geben soll, wie
   Personen benannt werden, was nie ohne Beleg behauptet werden darf, welche Themen außen
   vor bleiben. Ein Interview-Kanal, eine Behördendokumentation und eine interne
   Wissensbasis brauchen unterschiedliche Ergebnisse aus derselben Pipeline. Das ist der
   Unterschied zwischen einem gehorsamen Redakteur und einem generischen Chatbot, kostet
   wenig und macht das Ergebnis für den Kunden ohne unseren Eingriff steuerbar.
8. **Änderungs-Chronik je Wiki.** `activity_logs` und `wiki_page_revisions` halten alles
   fest, aber nichts davon beantwortet die Frage „was hat sich hier seit letzter Woche
   geändert". Eine lesbare, fortlaufende Chronik — neue Quellen, neue und geänderte Seiten,
   Lint-Läufe — ist intern die Kontrolle über einen Import, den niemand beaufsichtigt hat,
   und öffentlich ein „Zuletzt aktualisiert"-Feed, der ein Kanal-Publikum zurückholt. Fällt
   mit dem RSS aus Punkt 5 fast zusammen.

### 5.2 Mittelfristig, differenzierend

9. **Sprecher und Gäste als Entitäten.** Die Entity-Taxonomie existiert schon. Bei einem
   Interview-Format ist „alle Aussagen von Gast X über Thema Y" die eigentliche Suchanfrage.
10. **Zeitachse und Positionswandel.** Über 300 Videos hinweg zeigen, wie sich eine Position
    zu einem Thema entwickelt hat — mit Belegzitaten und Datum. Journalistisch stark,
    politisch heikel, deshalb ausschließlich mit wörtlichen Zitaten und Quellenlink.
    Mechanisch ist das dieselbe Abfrage wie „überholte Aussage" im Lint-Lauf (4.7) —
    gebaut wird es einmal, nicht zweimal.
11. **Übersetzte Wikis.** Ein deutscher Kanal erreicht auf Englisch ein Vielfaches. Die
    Übersetzung ist billiger als die Generierung, weil das Material schon strukturiert ist.
12. **Redaktioneller Freigabe-Workflow.** Entwurf → Review → veröffentlicht existiert im
    Ansatz (`status`, Cluster-Review). Ausbauen zu Zuweisung, Kommentaren, Diff-Ansicht
    zwischen Revisionen (die Revisionen liegen schon in der DB).
13. **WYSIWYG-Editor.** TipTap ist installiert und nicht verdrahtet. Für Kunden, die kein
    Markdown schreiben, ist eine Textarea ein Ausschlussgrund.
14. **API + Webhooks.** `api_keys` aus 4.1 plus Ereignisse wie „Artikel veröffentlicht".
    Erlaubt Kunden eigene Automatisierungen und macht das Produkt integrierbar.

### 5.3 Weitere Quellen

15. Podcasts über RSS-Feed (Whisper-Transkription), Spotify, Vimeo — dieselbe Pipeline wie
    YouTube, nur ein anderer Enumerator.
16. Notion, Confluence, Google Drive, Slack-Archive für die interne Wissensbasis. Das ist
    der Weg in Firmenkunden hinein, wenn das öffentliche Wiki den Einstieg gemacht hat.
17. **OKF-Bundle als Quellenart** — die Gegenrichtung zum Export aus 5.1/4. Ein Kunde, dessen
    Datenteam seinen Katalog ohnehin als OKF ausgibt, lädt ihn hoch statt ihn abzuschreiben.
    Der billigste Import der ganzen Pipeline, weil Struktur, Typen und Querverweise schon
    vorliegen: es entfällt genau die Extraktion, die bei einem Transkript das Geld kostet.
    Heute spekulativ — es offenzuhalten kostet nichts, sobald der Export das Format
    beherrscht.

### 5.4 Monetarisierung

18. **Mitglieder-Bereich.** Sichtbarkeit `members` plus Anbindung an Steady/Patreon/Stripe.
    Genau so verdienen unabhängige Kanäle Geld: Wiki öffentlich als Reichweite, Archiv,
    Volltextsuche und Chat für zahlende Unterstützer. Das ist für die Zielgruppe
    wahrscheinlich das kaufentscheidende Merkmal.
19. **Tarife** entlang der Zählung aus 4.5: Videos/Monat, Wikis, Sitze, Custom Domain,
    eigener LLM-Schlüssel („bring your own key" statt unserem Kontingent).

### 5.5 Rechtliches — vor dem ersten Fremdkunden zu klären

> **Der Drittlandtransfer ist am 21. August 2026 wesentlich kleiner geworden.**
> Nicht durch eine Rechtsgrundlage, sondern weil jede Organisation ihren eigenen
> LLM-Anbieter samt Schlüssel einträgt — die Wahl des Empfängerlands liegt damit
> beim Kunden, nicht bei prowiki. Der Code hielt das vorher nicht ein; der Befund
> und was offen bleibt (Anbieter in der Oberfläche zeigen, AV-Vertrag, und der
> ganze Abschnitt für den Fall eines Plattform-Kontingents) stehen in
> [DRITTLAND-DEEPSEEK.md](DRITTLAND-DEEPSEEK.md).

20. **AGB, Datenschutzerklärung, Auftragsverarbeitungsvertrag, Impressumspflicht pro Wiki.**
    Sobald Dritte Inhalte veröffentlichen, ist prowiki Hoster. Ein deutsches Angebot braucht
    das, bevor der erste externe Kunde live geht — nicht danach.
21. **Urheberrecht an Transkripten.** Der Kanalbetreiber importiert seine eigenen Videos:
    unproblematisch. Fremde Kanäle importieren: nicht. Der Import fremder Kanäle sollte
    technisch möglich, aber als privates Wiki voreingestellt und bei „öffentlich" mit einer
    Bestätigung der Rechtelage versehen sein.
22. **AI-Kennzeichnung.** Generierte Artikel als solche markieren, samt Quelle und
    Generierungsdatum. Kostet nichts, schafft Vertrauen und deckt kommende
    Transparenzpflichten ab.

---

## 6. Vorgehen

### Stufe 0 — Fundament (Voraussetzung für alles)
Code aus knora übernehmen · Better Auth einsetzen, Hintertür aus 2.1 entfernen ·
Org/Wiki/Member-Schema · Capability-Prüfung zentral · Sichtbarkeit `private|link|public` ·
pg-boss + Worker-Container · Rate-Limits · Audit-Log.

**Stand 21. August 2026 — was davon steht:**

| Punkt | Stand |
|---|---|
| Code, Better Auth, Hintertür weg, Org/Wiki/Member, Capabilities, Sichtbarkeit | erledigt (Livegang 16. August) |
| **pg-boss + Worker-Container** | **erledigt** — `backend/src/jobs/`, Container `prowiki-worker`. Durch einen Test belegt: ein Job, der in einem Prozess eingestellt wird, wird nach dessen Ende von einem neuen abgeholt |
| **Rate-Limits** | **erledigt** — `middleware/rate-limit.ts` auf Import, Transkriptabruf, Chat und Generierung. Ausdrücklich Schutz gegen den eigenen Klick, noch keiner gegen Fremde: der Zähler liegt im Speicher und gehört in die Datenbank, sobald die API mehrfach läuft |
| **Kostenzählung** (`usage_events`, KONZEPT 4.5) | **erledigt** — Tokens gemessen, Preise geschätzt, `GET /api/v1/usage/…`. Steht nicht in der Zeile oben, gehört aber vor Stufe 1: ohne sie ist der Kanal-Import ein Blindflug durchs Guthaben. **Seit 23. August auch sichtbar**: Reiter „💶 Kosten" je Wiki und Aufwandskasten je Dokument; Preise auf `deepseek-v4-*` samt Prompt-Cache und Stoßzeit umgestellt (die alte Tabelle kannte nur `deepseek-chat` und bewertete jeden Posten mit 0) |
| **Mandantentrennung der LLM-Provider** | **erledigt am 21. August** — `service/provider.ts`. Vorher nahmen sechs Stellen „die erste aktive Zeile" ohne `organization_id`: mit zwei Mandanten wären Inhalte über den Schlüssel des anderen gelaufen. Dazu sind die Schlüssel jetzt wirklich verschlüsselt (`service/crypto.ts`) — die Spalte hieß `api_key_encrypted` und enthielt Klartext |
| **Audit-Log** (`audit_events`) | **erledigt am 6. September** — `service/audit.ts` schreibt die Tabelle, die seit dem Livegang leer stand. Protokolliert werden Anmeldung (erfolgreich **und** fehlgeschlagen), Rollenwechsel auf Organisations- wie Wiki-Ebene, Freigabe eines Verbunds und die Löschung von Seite, Dokument und Wiki. Die Anmeldung hängt am Entstehen der Sitzung, nicht an der Anmelderoute — sonst fehlten Verifikation und Erstanmeldung; Org-Rollen laufen über einen Nachlauf-Hook, weil sie nie an unseren Routern vorbeikommen. **Nicht enthalten:** eine Leseseite — das Protokoll ist heute nur per SQL einsehbar (siehe unten) |

**Damit ist Stufe 0 nach der eigenen Liste abgeschlossen.** Zwei Vorbehalte bleiben
ausdrücklich stehen, beide nicht Teil der Stufe-0-Zeile, beide vor Stufe 2 fällig:

- Der **Rate-Limit-Zähler liegt im Prozessspeicher** (`middleware/rate-limit.ts`). Sobald
  die API mehrfach läuft oder anonymer Chat dazukommt, zählt jeder Prozess für sich.
- **Row-Level-Security auf `org_id` (4.1) ist nie gebaut worden.** Keine Migration enthält
  `ENABLE ROW LEVEL SECURITY`. Das zweite Netz gegen einen vergessenen `where`-Filter
  existiert bislang nur als Vorsatz.

Dazu eine bewusste Auslassung beim Audit-Log: es gibt **keinen Endpunkt und keine Ansicht**,
die es liest. Das ist keine vergessene Arbeit, sondern eine offene Entscheidung — wer ein
Sicherheitsprotokoll lesen darf, ist eine Rechtefrage (`owner`? `admin`? nur der
Betreiber?), und sie zu treffen gehört zur Mitgliederverwaltung in Stufe 3, nicht in einen
Nachtrag zu Stufe 0.

### Stufe 1 — Kanal-Import in Serie
`channel.sync` + `video.ingest` · YouTube Data API zum Backfill, RSS zur Fortschreibung ·
`external_id` mit Unique-Index · `transcript_segments` mit Zeitmarken · Fortschritts-UI mit
Wiederholen · Kostenvoranschlag und Zählung · Redaktionsanweisung je Wiki (5.1/7) — sie
gehört vor den ersten großen Lauf, weil ein Wiki aus 312 Videos im falschen Ton neu
generiert werden müsste. **Prüfstein: Basta Berlin komplett, in einem
Vorgang, wiederholbar.**

### Stufe 2 — Öffentliches Wiki
Nuxt-Lese-Seite · SEO/Sitemap/OG · öffentliche Suche · anonymer Chat mit Deckel ·
Custom Domains via Caddy · tiefe Video-Links · „Fehler melden".

### Stufe 3 — Redaktion & Team
Einladungen · Freigabe-Workflow mit Diff · WYSIWYG · Analytics · Export als OKF-Bundle ·
**Lint-Lauf (4.7) mit Redaktions-Inbox** · Änderungs-Chronik je Wiki.

### Stufe 4 — Produkt
Tarife und Abrechnung · Mitglieder-Bereich · Widget · API und Webhooks · SSO/2FA für
Firmenkunden.

---

## 7. Entscheidungen

### Getroffen am 2. August 2026

1. **Better Auth statt Eigenbau.** Begründung in 2.9. Damit entfallen Befunde 2.1–2.4 und
   Teile von 2.8 als selbst zu schreibender Code; Sessions liegen widerrufbar in derselben
   Postgres-DB. Die Capability- und Sichtbarkeitslogik aus 4.1 bleibt unsere.

2. **Transkript-Zeitmarken von Anfang an.** `transcript_segments` ist Teil des ersten
   Schemas, nicht einer späteren Migration. Die Wiki-Generierung führt die Zeitmarken bis in
   die Zitate durch (4.4). Nachrüsten hätte bedeutet, alle Transkripte erneut zu holen und
   bei Apify erneut zu bezahlen.

3. **Ein Codebase: prowiki ist knora v2.** knora wird nach erfolgreichem Start von prowiki
   abgeschaltet, das RKI-Wiki zieht als erste Organisation um. Kein Fork, keine doppelte
   Pflege der ~80 % geteilten Codes.

   prowiki ist funktional ein Superset von knora. **Nicht** übernommen werden zwei
   *Mechanismen*: die `.env`-Admin-Hintertür (2.1) und das globale
   `admin/editor/viewer`-Modell (2.5) — beide werden durch 4.1 ersetzt. Inhaltlich fehlt
   nichts, der Anmelde- und Navigationsablauf ändert sich.

4. **Getrennte Umgebungen und größere Hardware** vor dem ersten zahlenden Kunden —
   Dimensionierung, Anbietervergleich und Serverentscheidung in [HOSTING.md](./HOSTING.md).

### Getroffen am 6. September 2026

5. **Das Muster ist bestätigt, vier Ideen übernommen.** Anlass war
   [Karpathys „LLM Wiki"](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
   — dieselbe Grundthese wie hier: nicht RAG über Rohdokumente, sondern ein persistentes
   Wiki als kompilierte Zwischenschicht, das bei jeder neuen Quelle fortgeschrieben statt neu
   abgeleitet wird. Der Text beschreibt die Ein-Personen-Variante; alles, was prowiki zum
   Produkt macht — Mandanten, Rechte, Sichtbarkeit, Kostenzählung, Queue, öffentliches Lesen
   — fehlt dort naturgemäß. Übernommen wurden vier Punkte:

   - **Lint-Lauf** als neuer Abschnitt 4.7. Die deutlichste Lücke: sein Ablauf hat bei jeder
     Quelle einen Menschen in der Schleife, unser Kanal-Import hat keinen.
   - **Redaktionsanweisung je Wiki** (5.1/7), bei ihm die Schema-Datei.
   - **Änderungs-Chronik je Wiki** (5.1/8), bei ihm `log.md`.
   - **Export als Markdown-Vault** statt als bloßes ZIP (5.1/4) — die Form dieses Exports
     legt Entscheidung 6 fest.

   Nicht übernommen: eine kuratierte Index-Datei statt Suche — das trägt bei seinen ~100
   Quellen, nicht bei 5.703 Seiten; und die Disziplin, jede Quelle einzeln und unter Aufsicht
   einzupflegen — das ist das Gegenteil des Prüfsteins von Stufe 1.

6. **OKF nur an der Außenkante.** Googles
   [Open Knowledge Format](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing)
   (v0.1, 12. Juni 2026) ist nicht ein weiteres Werkzeug, sondern die Standardisierung genau
   des Musters aus Entscheidung 5 — der Text zitiert Karpathy ausdrücklich. Es ist ein
   **Format, kein System**: ein Verzeichnis Markdown mit YAML-Frontmatter, eine Seite
   Spezifikation, kein SDK, keine Laufzeit. Es kennt keine Mandanten, keine Rechte, keine
   Sichtbarkeit, keine Revisionen, keine Kostenzählung, keine Suche und keine Generierung —
   alles, was Abschnitt 4 ausmacht, hat dort kein Gegenstück. Damit ist es keine Konkurrenz
   zu prowiki, sondern eine Transportform.

   **Entschieden:** der Export (5.1/4) wird OKF-konform und bleibt dabei Obsidian-taugliches
   Markdown; der Import eines OKF-Bundles ist als Quellenart vorgemerkt (5.3/17). **Nicht**
   entschieden und ausdrücklich abgelehnt: OKF als internes Datenmodell und die
   Index-first-Navigation der Spezifikation. Begründung: die Anpassung am Rand kostet
   gegenüber dem ohnehin geplanten Export fast nichts und ist zurücknehmbar, falls der
   Standard nicht ankommt — eine Wette auf v0.1 eines einzigen Anbieters im Kern der
   Anwendung wäre sie nicht.

### Abschaltkriterium für knora

Erst wenn alle fünf Punkte erfüllt sind:

- [ ] Alle 5.703 Wiki-Seiten, Dokumente, Chunks und Embeddings migriert, **Zeilenzahlen
      abgeglichen** (Verfahren wie beim Restore-Test am 2. August)
- [ ] Identische Treffer bei einem festen Satz Testsuchen (Volltext, Vektor, Facetten)
- [ ] `manually_edited`-Flags und `wiki_page_revisions` erhalten — sonst überschreibt der
      erste Generierungslauf in prowiki die Handarbeit
- [ ] Phase Parallelbetrieb, in der das RKI-Wiki in prowiki real benutzt wurde
- [ ] Backup für prowiki läuft und ist per Restore geprüft

Danach knora stoppen, den letzten Dump aufheben.

### Offen

Keine offenen Grundsatzentscheidungen mehr — Stufe 0 kann beginnen.

Und eine Frage zum Hosting, die nicht die Struktur, aber den Zeitplan betrifft: der
3,7-GB-Hetzner-Host trägt knora heute knapp. Ein öffentliches Wiki mit anonymem Chat, ein
Worker-Container und eine Nuxt-Instanz brauchen mehr — spätestens vor Stufe 2 ist eine
größere Maschine fällig, und die Rollentrennung des DB-Nutzers (Befund 2.8) ist dann ohnehin
Voraussetzung für Row-Level-Security.

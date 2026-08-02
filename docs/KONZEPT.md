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
- Der DB-Nutzer der App ist auf dem Server **SUPERUSER** in einer Instanz, die vier Apps
  teilen (in `knora/docs/optimize-knora.md` als offen dokumentiert). Für ein
  mandantenfähiges Produkt mit Row-Level-Security ist eine unprivilegierte Rolle
  Voraussetzung, nicht Kosmetik.

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
usage_events           org_id, kind, tokens_in, tokens_out, cost_micros, ref_id, created_at
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

## 5. Weitere Vorschläge — was prowiki zum Werkzeug macht

Über die Frage hinaus, sortiert nach Verhältnis von Nutzen zu Aufwand.

### 5.1 Sofort wertvoll, kleiner Aufwand

1. **Tiefe Video-Links** (siehe 4.4). Jeder Absatz zeigt auf die Sekunde. Alleinstellungsmerkmal.
2. **Einbettbares Widget.** Ein `<script>`-Schnipsel, den ein YouTuber auf seine eigene
   Seite legt: Suchfeld plus Chat-Bubble über seinem Wiki. Sein Publikum bleibt bei ihm,
   der Traffic ist unserer. Stärkster Vertriebskanal, den dieses Produkt haben kann.
3. **Fehler melden.** Ein Knopf unter jedem öffentlichen Artikel. LLM-generierte Inhalte
   haben Fehler; das Publikum eines Kanals findet sie zuverlässig und gern.
4. **Export.** Markdown-ZIP plus JSON pro Wiki. Nimmt Interessenten die Angst vor
   Lock-in — und kostet einen Tag Arbeit.
5. **Sitemap, OpenGraph, `robots.txt`, RSS je Wiki.** Fällt mit 4.2 fast von selbst ab.
6. **Analytics pro Wiki:** meistgelesene Artikel, gestellte Fragen, Fragen ohne gute
   Antwort. Letzteres ist redaktionell Gold — es zeigt, worüber das nächste Video geht.
   Umami läuft auf dem Server bereits.

### 5.2 Mittelfristig, differenzierend

7. **Sprecher und Gäste als Entitäten.** Die Entity-Taxonomie existiert schon. Bei einem
   Interview-Format ist „alle Aussagen von Gast X über Thema Y" die eigentliche Suchanfrage.
8. **Zeitachse und Positionswandel.** Über 300 Videos hinweg zeigen, wie sich eine Position
   zu einem Thema entwickelt hat — mit Belegzitaten und Datum. Journalistisch stark,
   politisch heikel, deshalb ausschließlich mit wörtlichen Zitaten und Quellenlink.
9. **Übersetzte Wikis.** Ein deutscher Kanal erreicht auf Englisch ein Vielfaches. Die
   Übersetzung ist billiger als die Generierung, weil das Material schon strukturiert ist.
10. **Redaktioneller Freigabe-Workflow.** Entwurf → Review → veröffentlicht existiert im
    Ansatz (`status`, Cluster-Review). Ausbauen zu Zuweisung, Kommentaren, Diff-Ansicht
    zwischen Revisionen (die Revisionen liegen schon in der DB).
11. **WYSIWYG-Editor.** TipTap ist installiert und nicht verdrahtet. Für Kunden, die kein
    Markdown schreiben, ist eine Textarea ein Ausschlussgrund.
12. **API + Webhooks.** `api_keys` aus 4.1 plus Ereignisse wie „Artikel veröffentlicht".
    Erlaubt Kunden eigene Automatisierungen und macht das Produkt integrierbar.

### 5.3 Weitere Quellen

13. Podcasts über RSS-Feed (Whisper-Transkription), Spotify, Vimeo — dieselbe Pipeline wie
    YouTube, nur ein anderer Enumerator.
14. Notion, Confluence, Google Drive, Slack-Archive für die interne Wissensbasis. Das ist
    der Weg in Firmenkunden hinein, wenn das öffentliche Wiki den Einstieg gemacht hat.

### 5.4 Monetarisierung

15. **Mitglieder-Bereich.** Sichtbarkeit `members` plus Anbindung an Steady/Patreon/Stripe.
    Genau so verdienen unabhängige Kanäle Geld: Wiki öffentlich als Reichweite, Archiv,
    Volltextsuche und Chat für zahlende Unterstützer. Das ist für die Zielgruppe
    wahrscheinlich das kaufentscheidende Merkmal.
16. **Tarife** entlang der Zählung aus 4.5: Videos/Monat, Wikis, Sitze, Custom Domain,
    eigener LLM-Schlüssel („bring your own key" statt unserem Kontingent).

### 5.5 Rechtliches — vor dem ersten Fremdkunden zu klären

17. **AGB, Datenschutzerklärung, Auftragsverarbeitungsvertrag, Impressumspflicht pro Wiki.**
    Sobald Dritte Inhalte veröffentlichen, ist prowiki Hoster. Ein deutsches Angebot braucht
    das, bevor der erste externe Kunde live geht — nicht danach.
18. **Urheberrecht an Transkripten.** Der Kanalbetreiber importiert seine eigenen Videos:
    unproblematisch. Fremde Kanäle importieren: nicht. Der Import fremder Kanäle sollte
    technisch möglich, aber als privates Wiki voreingestellt und bei „öffentlich" mit einer
    Bestätigung der Rechtelage versehen sein.
19. **AI-Kennzeichnung.** Generierte Artikel als solche markieren, samt Quelle und
    Generierungsdatum. Kostet nichts, schafft Vertrauen und deckt kommende
    Transparenzpflichten ab.

---

## 6. Vorgehen

### Stufe 0 — Fundament (Voraussetzung für alles)
Code aus knora übernehmen · Better Auth einsetzen, Hintertür aus 2.1 entfernen ·
Org/Wiki/Member-Schema · Capability-Prüfung zentral · Sichtbarkeit `private|link|public` ·
pg-boss + Worker-Container · Rate-Limits · Audit-Log.

### Stufe 1 — Kanal-Import in Serie
`channel.sync` + `video.ingest` · YouTube Data API zum Backfill, RSS zur Fortschreibung ·
`external_id` mit Unique-Index · `transcript_segments` mit Zeitmarken · Fortschritts-UI mit
Wiederholen · Kostenvoranschlag und Zählung. **Prüfstein: Basta Berlin komplett, in einem
Vorgang, wiederholbar.**

### Stufe 2 — Öffentliches Wiki
Nuxt-Lese-Seite · SEO/Sitemap/OG · öffentliche Suche · anonymer Chat mit Deckel ·
Custom Domains via Caddy · tiefe Video-Links · „Fehler melden".

### Stufe 3 — Redaktion & Team
Einladungen · Freigabe-Workflow mit Diff · WYSIWYG · Analytics · Export.

### Stufe 4 — Produkt
Tarife und Abrechnung · Mitglieder-Bereich · Widget · API und Webhooks · SSO/2FA für
Firmenkunden.

---

## 7. Offene Entscheidungen

Drei Punkte legen die Struktur fest und sollten vor Stufe 0 beantwortet sein:

1. **Ein Codebase oder zwei?**
   *Empfehlung: einer.* prowiki wird knora v2, knoras Daten (RKI-Wiki, 5.703 Seiten) wandern
   als erste Organisation hinein, knora wird danach abgeschaltet. Ein Fork bedeutet, jede
   Korrektur zweimal zu machen — bei 25.800 Zeilen und einem Entwickler ist das der teurere
   Weg. Gegen die Empfehlung spricht nur: knora läuft und soll nicht wackeln. Das ist mit
   dem geprüften Backup und einer parallelen prowiki-Instanz auffangbar.

2. **Better Auth oder selbst bauen?**
   *Empfehlung: Better Auth* (Begründung in 2.9). Die Alternative heißt, Passwort-Reset,
   Session-Widerruf, 2FA und SSO selbst zu schreiben und zu pflegen.

3. **Zeitmarken jetzt oder später?**
   *Empfehlung: jetzt.* Nachrüsten heißt, alle Transkripte erneut zu holen — bei Apify mit
   erneuten Kosten. Vor dem ersten Import von 300 Videos ist es eine Schema-Entscheidung,
   danach eine Migration.

Und eine Frage zum Hosting, die nicht die Struktur, aber den Zeitplan betrifft: der
3,7-GB-Hetzner-Host trägt knora heute knapp. Ein öffentliches Wiki mit anonymem Chat, ein
Worker-Container und eine Nuxt-Instanz brauchen mehr — spätestens vor Stufe 2 ist eine
größere Maschine fällig, und die Rollentrennung des DB-Nutzers (Befund 2.8) ist dann ohnehin
Voraussetzung für Row-Level-Security.

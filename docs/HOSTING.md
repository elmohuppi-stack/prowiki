# prowiki — Hosting, Kapazität und Betriebsumgebungen

**Stand:** 2. August 2026

Ausgelagert aus `KONZEPT.md`. Dort steht das Produkt, hier die Frage, worauf es läuft.

---

## 1. Betriebsumgebungen

Sobald echte Kunden auf prowiki liegen, braucht es getrennte Umgebungen. Drei Stufen:

| | Wo | Zweck |
|---|---|---|
| **Lokal** | Mac, `docker-compose.dev.yml` | Entwicklung, existiert aus knora |
| **Staging / QM** | eigener kleiner Server, eigene DB, eigene Domain | Migrationen gegen **Kopie der Produktionsdaten**, Abnahme vor Deploy |
| **Produktion** | eigener Server, eigene Postgres-Instanz | zahlende Kunden |

**Die eigentliche Leistung von Staging** ist nicht „Features ausprobieren", sondern der
Migrationstest gegen echte Daten. Fast jeder Deploy-Ausfall ist datengeformt, nicht
codegeformt — eine leere Test-DB findet das nie. Das Backup-Skript aus knora
(`/usr/local/sbin/pg-shared-backup`) liefert genau das benötigte Artefakt.

Absperrungen, ohne die Staging gefährlich statt nützlich ist:

- kein Mailversand nach außen (Mail-Catcher), Stripe im Testmodus
- `noindex` + Basic Auth — sonst indexiert Google die Staging-Kopie und sie konkurriert
  mit der Produktion um dieselben Suchbegriffe
- eigener LLM-Schlüssel mit hartem Deckel; eine Endlosschleife im Test darf keine Rechnung
  erzeugen
- keine Kundendomänen, kein Zugriff auf Produktions-Buckets
- **Datenschutz:** eine Kopie der Produktionsdaten auf Staging heißt Kundendaten auf einem
  zweiten System. Entweder anonymisieren oder im AVV abdecken.

**Ergänzend, und für einen Einzelentwickler wichtiger als die Staging-Instanz selbst:
Feature-Flags pro Organisation.** Staging allein erzeugt langlebige Zweige, die
auseinanderlaufen und schmerzhaft zusammengeführt werden. Mit Flags wird laufend auf
Produktion deployt und die Funktion je Org freigeschaltet — das ergibt Beta-Tester unter
echten Kunden und einen sofortigen Aus-Schalter. Dazu: Backup **vor** jedem Deploy und ein
geprobter Rollback-Weg.

## 2. Kapazität — gemessen am 2. August 2026

Aufnahme des aktuellen Hetzner-Hosts:

| | Wert |
|---|---|
| CPU | 2 vCPU, AMD EPYC-Genoa (shared), vServer |
| RAM | 3,7 GB — 1,9 GB belegt, **589 MB Swap in Benutzung** |
| Disk | 75 GB, 51 GB frei |
| Load | 0,14 / 0,42 / 0,34 — CPU ist nicht der Engpass |
| Container | **21** (knora, mediathek, umami, mathe-quiz, elmo-scanner, finanzen, pick-the-place, benzin-preise, wetter, sari) |
| Postgres | 640 MB RSS, `shared_buffers` 512 MB, `effective_cache_size` 1500 MB |
| Cache-Trefferquote | **96,28 %** — etwa jede 25. Leseanfrage geht auf die Platte (Ziel > 99 %) |
| DB-Größen | knora **1268 MB** · mediathek 27 MB · umami 9 MB · mathe_quiz 8 MB |

**Befund: reicht für knora, nicht für prowiki mit Kunden.** Heute geht es gut, weil knora
ein Werkzeug für einen Menschen ist — bei Load 0,14 gibt es keine Gleichzeitigkeit. Die
589 MB Swap zeigen jedoch, dass die Maschine bereits am Rand arbeitet.

Die entscheidende Zahl ist der Vektorindex: **541 MB HNSW für ein einziges Wiki mit 5.703
Seiten.** Vektorsuche ist nur schnell, solange dieser Index im Arbeitsspeicher liegt. Zehn
Kunden dieser Größe sind rund 5 GB Vektorindex — auf einer Maschine mit 3,7 GB gesamt geht
das arithmetisch nicht auf. Dazu kommen Worker (LLM-Läufe über Stunden), Nuxt-SSR, der
speicherhungrige Parser und öffentlicher Traffic mit offenen SSE-Streams.

**Zielgröße: 16 GB RAM für die Produktion.** RAM ist die bindende Größe, nicht CPU — der
jetzige Host läuft bei Load 0,14, und die rechenintensiven Teile (LLM-Aufrufe,
Transkript-Abruf) sind netzgebunden.

#### Anbietervergleich bei 16 GB

Alle Preise **netto** (vorsteuerabzugsberechtigt). IONOS und Hetzner weisen inkl. MwSt. aus
und wurden umgerechnet (÷ 1,19). Hetzner-Werte am 2. August 2026 aus der eingeloggten Cloud
Console abgelesen, IONOS aus dem Konfigurator.

| Anbieter / Typ | vCPU | RAM | Disk | **netto/Mon.** | Bindung |
|---|---|---|---|---|---|
| **IONOS VPS XL+** *(empfohlen)* | 8 | 16 GB | **480 GB** | **31,93 €** | 12 Monate |
| Hostinger KVM 4 | 4 | 16 GB | 200 GB | 27,99 € | **24 Monate** |
| Hetzner Cloud CPX42 | 8 | 16 GB | 320 GB | **69,99 €**¹ | keine |
| Hetzner Cloud CCX23 *(dedizierte vCPU)* | 4 | 16 GB | 160 GB | 86,49 €¹ | keine |

¹ inkl. 0,50 € netto für die IPv4, die Hetzner separat berechnet.

Weitere Hetzner-Cloud-Werte zur Einordnung (netto): CPX12 1/2 GB 11,49 € · CPX22 2/4 GB
19,49 € · CPX32 4/8 GB 35,49 € · CCX13 2/8 GB 42,99 €.

> **Warnung zu Hetzner-Preisangaben aus zweiter Hand.** Vor dem Blick in die Konsole waren
> zwei Quellen im Umlauf, die beide falsch lagen: eine KI-generierte Angabe nannte für die
> 16-GB-Klasse „ca. 16–22 €" (tatsächlich 82,69 € brutto — Faktor 4) und vertauschte
> zusätzlich die Tarifnamen; eine Schätzung aus dem Modellgedächtnis lag bei ~30 €.
> Hetzners Preisseite ist vollständig JS-gerendert und über drei URLs nicht auslesbar.
> **Nur die eingeloggte Cloud Console ist maßgeblich.**

#### Entscheidung: IONOS VPS XL+, 12 Monate, Standort Deutschland

Hetzner Cloud kostet nach der Preisanpassung vom Juni 2026 für dieselbe Ausstattung das
**2,2-fache** — 38 € netto mehr im Monat, 457 € im Jahr — bei zugleich 160 GB weniger
Plattenplatz.

Die strukturellen Vorteile von Hetzner bleiben sachlich richtig: Festpreis ohne Bindung,
keine Einrichtungsgebühr, stundengenaue Abrechnung, zubuchbare Volumes, Snapshots als
Rollback vor jedem Deploy. Vor allem erlaubt die stundengenaue Abrechnung **Staging on
demand statt Dauerserver**: Snapshot ziehen, Server in Produktionsgröße erzeugen, Migration
testen, löschen — ein Test von 20 Stunden im Monat kostet unter einem Euro, und Staging
hätte dieselbe Größe wie die Produktion, was einen Migrationstest erst voll aussagekräftig
macht. Dieser Vorteil ist rund 15 € netto im Monat wert (der entfallende Staging-Server).
Es bleiben **rund 23 € netto Aufpreis im Monat allein für die Flexibilität** — das trägt es
in dieser Phase nicht.

**Bei IONOS ist Staging deshalb wieder ein Dauerserver:** VPS L+ (6 vCores, 8 GB, 240 GB,
15,13 € netto). Kleiner als die Produktion — der Nachteil ist bewusst in Kauf genommen und
bei Migrationstests mitzudenken.

**Kostenverlauf XL+ bei 12 Monaten Laufzeit:**

| Zeitraum | brutto | netto |
|---|---|---|
| Monat 1–3 (Aktion) | 9 €/Mon. | 7,56 €/Mon. |
| Monat 4–12 | 38 €/Mon. | 31,93 €/Mon. |
| **Jahr 1 gesamt** | 369 € | **310,08 €** (Ø 25,84 €/Mon.) |
| **Ab Jahr 2, dauerhaft** | 456 €/Jahr | **383,19 €/Jahr** (Ø **31,93 €/Mon.**) |

**Laufzeit 12 Monate, nicht 1 Monat.** Bei „1 Monat" entfällt die Aktion vollständig (38 €
ab dem ersten Tag) *und* die Einrichtungsgebühr von 10 € wird fällig; bei „12 Monate" ist
sie erlassen. Jahr 1 kostet monatlich kündbar 466 € statt 369 € brutto — die Kündbarkeit
kostet 81,51 € netto, ab Jahr 2 sind beide gleich teuer. Da allein die Stufen 0–2 mehrere
Monate brauchen, ist das Flexibilität, die nicht genutzt wird.

**XXL+ (24 GB) nicht zum Start:** 48,74 € statt 31,93 € netto — 202 € netto jährlich für
8 GB mehr RAM.

> **Vor der Bestellung einmal prüfen: Hetzners dedizierte Server** (Robot-Linie und
> Serverbörse, *nicht* die Cloud). Dort ist das Verhältnis RAM zu Euro grundlegend anders —
> üblicherweise bekommt man dort in der Preisklasse, in der die Cloud 16 GB liefert, ein
> Vielfaches davon. Für eine Anwendung, deren bindende Größe RAM ist und deren Vektorindex
> mit jedem Kunden wächst, wäre das der eigentliche Treffer und würde die Kapazitätsfrage
> für Jahre erledigen. Nachteile: keine stundengenaue Abrechnung, keine Snapshots, Ausfälle
> betreffen echte Hardware.

> **Keine SSL-Zusatzoptionen buchen** — gilt bei jedem Anbieter. IONOS bietet im
> Bestellprozess SSL Starter (3 €), Starter Wildcard (8 €) und Business (6 €) pro Monat an.
> Auf einem Server mit Root holt Caddy oder Certbot die Zertifikate kostenlos und automatisch
> erneuert von Let's Encrypt, Wildcard eingeschlossen — so läuft es auf dem bisherigen Server
> bereits. Für die Kundendomänen aus 4.2 wird ohnehin **On-Demand-TLS** gebraucht, das ein
> gekauftes Zertifikat gar nicht leisten kann. Wildcard wären 96 € im Jahr für nichts.

> **Ausgeschlossen: Hostinger „Cloud Hosting" (Startup/Professional/Enterprise).** Das ist
> managed Shared Hosting für PHP-Websites — erkennbar an „PHP-Worker", „Inodes" und
> „Managed Hosting für WordPress". Kein Root, kein Docker, und entscheidend: **kein
> pgvector.** Die Erweiterung muss in den Datenbankserver installiert werden, was Root auf
> dem DB-Host voraussetzt; Shared Hosting bietet MySQL/MariaDB ohne Installationsrechte.
> Ohne pgvector gibt es weder semantische Suche noch RAG-Chat. Dasselbe gilt für jedes
> andere Shared-Hosting-Angebot — das Ausschlusskriterium ist die Produktkategorie, nicht
> die Größe.

Sobald Kundendaten darauf liegen:

- **Standort Deutschland** wählen (bei IONOS auswählbar) und für den AVV dokumentieren
- **Backups sind bei IONOS Aufpreis** (ab 6 Cent pro GB/Monat) und bei Hostinger nur
  wöchentlich — beides zu wenig für Kundendaten. Das tägliche Dump-Skript aus knora läuft
  unabhängig vom Provider-Backup weiter.
- Off-site-Kopie der Backups (aus dem knora-Bericht noch offen; mit Kunden nicht mehr optional)

Gesamtkosten Infrastruktur nach dieser Wahl (XL+ Produktion + L+ Staging, beide
12 Monate, ohne SSL-Zusatz):

| | brutto | netto |
|---|---|---|
| Jahr 1 | 546 € | **458,82 €** (Ø 38,24 €/Mon.) |
| Ab Jahr 2 | 672 €/Jahr | **564,71 €/Jahr** (Ø **47,06 €/Mon.**) |

Gegenüber den LLM-Kosten eines einzigen vollständigen Kanal-Imports der kleinere Posten.

---

## 3. Verhältnis zum bestehenden Server `nuernberg-16gb`

Der Hausleitfaden für den bestehenden Server steht in
`~/workspace/platform` — [`ARCHITEKTUR.md`](../../platform/ARCHITEKTUR.md)
(Sollzustand), [`DEPLOYMENT.md`](../../platform/DEPLOYMENT.md) (Bedienung),
[`OFFENE-PROBLEME.md`](../../platform/OFFENE-PROBLEME.md) (Ist-Abweichungen).
prowiki hält sich daran, auch wenn es später auf einer eigenen Maschine läuft: die Regeln
sind aus realen Ausfällen abgeleitet, nicht aus Geschmack.

### Eigene Postgres-Instanz — kein Verstoß gegen die Hausregel

`ARCHITEKTUR.md` verbietet Apps auf `nuernberg-16gb` einen eigenen Postgres-Container
(Abschnitt 12) und verlangt „geteilte Infrastruktur, getrennte Daten". Das gilt **für Apps
auf diesem Host**. prowiki zieht auf eine eigene Maschine (Abschnitt 2) und bringt dort
seine eigene Instanz mit — das ist kein Nebeneinander zweier Postmaster auf einem Host,
sondern eine getrennte Umgebung.

> **Korrektur gegenüber einer früheren Fassung dieses Dokuments.** Hier stand als
> Begründung, die App-Rolle in `pg-shared` sei SUPERUSER. **Das stimmt seit dem 2. August
> nicht mehr** (`OFFENE-PROBLEME.md` Punkt 5): `knora_app`, `mediathek`, `umami` und
> `mathe_user` sind alle unprivilegiert, `knora` ist nur noch Wartungsrolle. Die
> Trennungsentscheidung trägt trotzdem — sie steht auf Kapazität und Mandantentrennung,
> nicht auf einem behobenen Rechtefehler: der 3,7-GB-Host trägt prowikis Vektorindizes
> nicht, und eine Instanz mit Kundendaten sollte nicht neben Hobby-Apps liegen, deren
> Lastspitzen niemand budgetiert.

### Was prowiki aus dem Leitfaden übernimmt

| Regel | Quelle | Umsetzung in prowiki |
|---|---|---|
| Unprivilegierte App-Rolle je Datenbank | ARCH 4.1 | `prowiki_app`, kein SUPERUSER/CREATEDB/CREATEROLE; `REVOKE CONNECT … FROM PUBLIC` |
| Pool-Obergrenze explizit setzen | ARCH 4.2 | `DB_POOL_MAX`, Default 10 statt der 20 aus knora |
| Kanonischer DB-Hostname, kein `db`/`postgres` | ARCH 4.3 | `pg-shared` bzw. der Instanzname; nie ein generischer Alias |
| Nur vorhandene Extensions voraussetzen | ARCH 4.4 | `vector`, `pg_trgm` — beide im Image `pgvector/pgvector:pg17` |
| Portblock aus der Vergabeliste | ARCH 5 | **3121 / 3122**. Beim Schreiben dieses Dokuments war 3101 die nächste freie Vergabe; wandervogel hat ihn genommen, bevor prowiki so weit war |
| Ports nur auf `127.0.0.1`, DB gar nicht | ARCH 6 | Prod- und Dev-Compose gebunden, DB nie auf `0.0.0.0` |
| `apps-net` als `external: true`, `- default` mitlisten | ARCH 6 | aus knora übernommen und erfüllt. **Das Netz hieß bis zum Umzug `hetzner-network`**; der alte Name im ersten Compose-Stand war ein Blocker beim Livegang ([LIVEGANG 2.2](./LIVEGANG.md)) |
| Eigener Healthcheck gegen die eigene App | ARCH 6, 10 | `/health` mit `select 1`, 503 im Fehlerfall |
| `mem_limit` überall | ARCH 8 | app 768 MB, frontend 128 MB, parser 1 GB; Worker kommt dazu |
| Indexe gehören in die Migration, auch die teuren | ARCH 7.1 | HNSW mit `vector_cosine_ops` in der ersten Migration, nicht als Kommentar |
| `shm_size: 1g` für Index-Builds | ARCH 7.1 | im Dev-Compose gesetzt |
| Technische Identifikatoren `COLLATE "C"` | ARCH 7.3 | Slugs, `user.email`, `session.token`, `external_id`, `key_hash` |
| Migrationen vorwärts-only, nummeriert, im Repo | ARCH 7.4 | Drizzle-Kette wie in knora |
| Pflichtvariablen mit `${VAR:?…}` | ARCH 9 | `AUTH_SECRET`, `APP_BASE_URL`, `DB_USER`, `DB_PASSWORD` |
| Täglicher Dump mit geprüftem Restore | ARCH 10, DEPL 7 | auf der neuen Maschine einzurichten — **offen** |

### Vor dem ersten Deploy zu erledigen

- [ ] Datenbank + Rolle `prowiki_app` anlegen, `REVOKE CONNECT … FROM PUBLIC`
- [x] Portblock 3121/3122 gegen `sites-available` gegenprüfen (nicht `sites-enabled` —
      daraus entstand die openclaw/knora-Kollision)
- [ ] nginx-Vhost **und** Symlink, Zertifikat per certbot
- [ ] `/var/www/prowiki` als Git-Checkout, `.env` mit Mode `600`
- [ ] Backup samt Restore-Test einrichten, bevor Kundendaten darauf liegen
- [x] Deploy-Weg in `platform/DEPLOYMENT.md` ergänzen — **16.08.**, samt Zeile in der App-Tabelle


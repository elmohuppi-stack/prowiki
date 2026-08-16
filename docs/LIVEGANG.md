# prowiki live schalten

**Stand:** 16. August 2026
**Zielserver:** `nuernberg-16gb` (netcup, 8 vCPU, 15 GB RAM, 452 GB frei), SSH-Alias `elmarhepp`
**Maßgeblich:** [platform/NEUE-APP.md](../../platform/NEUE-APP.md) für den Ablauf,
[platform/ARCHITEKTUR.md](../../platform/ARCHITEKTUR.md) für die Regeln,
[platform/DEPLOYMENT.md](../../platform/DEPLOYMENT.md) für den Betrieb danach.

Dieses Dokument ist der Plan für **eine Sache**: prowiki neben knora in Betrieb
nehmen, mit den migrierten Daten, privat, für zwei Nutzer. Es ist kein Ersatz von
knora — das Abschaltkriterium aus [KONZEPT §7](KONZEPT.md) verlangt eine Phase
Parallelbetrieb, und die beginnt hier.

---

## 1. Festlegungen

Die sieben Punkte aus NEUE-APP §1, entschieden:

| # | Festlegung | Wert | Begründung |
|---|---|---|---|
| 1 | Slug | `prowiki` | Verzeichnis `/var/www/prowiki`, Container-Präfix, nginx-Config |
| 2 | Domains | `prowiki.elmarhepp.de` | Eine Domain wie bei knora: die API liegt hinter demselben nginx im Frontend-Container unter `/api/`. Kein DNS-Schritt nötig (Wildcard `*.elmarhepp.de`) |
| 3 | Portblock | **3121 / 3122** | 3101/3102 gehören **wandervogel** — die `.env.example` behauptet bislang das Gegenteil. 3111/3112 sind für `umweg` vorgemerkt. Genutzt wird nur 3121 (Frontend); 3122 bleibt für eine später getrennte API reserviert |
| 4 | Datenhaltung | eigene DB `prowiki` in `pg-shared` | Relational, Vektoren, >1 GB — der Entscheidungsbaum lässt nichts anderes zu |
| 5 | Speicher | `prowiki-app` 768 MB · `prowiki-parser` 1 GB · `prowiki-web` 128 MB | Wie knora. Parser lädt ganze PDFs in den RAM |
| 6 | Öffentlich? | erreichbar ja, **alle Wikis privat**, Anmeldung nötig | Sichtbarkeit `public` kommt erst mit Stufe 2 |
| 7 | Personenbezug | Konten, Chatverläufe, Uploads; Dritte: **DeepSeek (CN)**, **OpenAI (US)**, Apify/Supadata | Siehe [Abschnitt 6](#6-rechtliches) — hier steckt die unangenehmste offene Arbeit |

Portprüfung am 16. August gegen `sites-available` durchgeführt: belegt sind
3001–3101, frei ab 3111. Ergebnis unten in Schritt 0 nachprüfbar.

---

## 2. Was heute nicht deploybar ist

Fünf Befunde, alle geprüft, nicht vermutet. Die ersten drei verhindern den Start.

### 2.1 Das Frontend-Image lässt sich nicht bauen — Blocker

```
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

`frontend/Dockerfile` baut aus dem Kontext `./frontend` und ruft dort `npm install`.
Seit das Frontend `@prowiki/shared` benutzt (Capability-Definition, Commit
`10005f0`), steht in `frontend/package.json` ein `workspace:*` — und ein npm ohne
Workspace-Wurzel kann das nicht auflösen. **Das Produktions-Image ist seit diesem
Commit nie gebaut worden**, der lokale `vite build` läuft, weil er im Workspace
läuft.

Fix: derselbe Weg wie im Backend-Dockerfile — Kontext auf das Repo-Wurzelverzeichnis,
`packages/shared` mitkopieren, mit Bun statt npm installieren.
Das Backend-Image baut sauber durch (geprüft, 484 MB).

### 2.2 Servicenamen und Netz sind auf dem Stand vor der Konsolidierung — Blocker

`docker-compose.yml` heißt die Dienste `app`, `frontend`, `parser`, `tools` und hängt
sie ins Netz `hetzner-network`.

- **Das Netz gibt es nicht mehr**; es heißt seit dem Umzug `apps-net`. `docker compose
  up` bricht mit „network not found" ab.
- **`app` ist genau der Name aus dem Vorfall vom 8. August**, als vier Container im
  geteilten Netz so hießen und knoras Login zehn Sekunden hielt, weil Dockers DNS
  reihum in fremde Apps auflöste. knora heißt dort inzwischen `knora-app` — würde
  prowiki als `app` starten, wäre der Fehler zurück.

Fix: `prowiki-app`, `prowiki-web`, `prowiki-parser`, `prowiki-tools`; Netz `apps-net`
als `external: true`. Ins `apps-net` gehören **nur** `prowiki-app` und
`prowiki-tools` — Web und Parser brauchen die Datenbank nicht.
Mit dem Umbenennen muss `frontend/nginx.conf` mit: es proxyt `/api/` an `app:3000`.

### 2.3 `CREATE EXTENSION vector` braucht Superuser — Blocker

`drizzle/0000_init_prowiki.sql:12` legt `vector` und `pg_trgm` an. Beide sind nicht
„trusted", die App-Rolle `prowiki` ist regelkonform unprivilegiert — die Migration
scheitert an Zeile 12.

Fix: Extensions einmalig als `knora` (Wartungsrolle) in der neuen Datenbank anlegen.
Die Migration hat `IF NOT EXISTS` und läuft danach ohne Rechteproblem durch. Gilt
**pro Datenbank**, nicht pro Cluster.

### 2.4 Sitzungscookies wären nicht `Secure`

`auth/index.ts:83` schaltet `useSecureCookies` an `NODE_ENV === "production"` —
und **weder Compose noch Dockerfile setzen `NODE_ENV`**. In Produktion liefe die
Anmeldung damit über ein Cookie ohne `Secure`-Flag.

Fix: `NODE_ENV: production` in den `prowiki-app`-Service.

### 2.5 Uploads scheitern am Host-nginx

Der Container-nginx erlaubt 512 MB, der Host-nginx nicht: `client_max_body_size`
ist serverweit nirgends gesetzt, es gilt der Default von **1 MB**. Ein Upload
scheitert mit 413, bevor er den Container erreicht. (knora hat dasselbe Problem,
nur fällt es dort nicht auf, weil die großen Importe über das `tools`-Profil laufen.)

Fix: `client_max_body_size 512m;` in den prowiki-Vhost.

---

## 3. Vorbereitung im Repo

Alles lokal, ohne Serverzugriff, in einem Commit prüfbar per `docker build`.

1. **`frontend/Dockerfile`** auf Repo-Wurzel-Kontext und Bun umstellen; `packages/shared`
   mitkopieren. Danach `docker build -f frontend/Dockerfile .` als Nachweis.
2. **`docker-compose.yml`**: Servicenamen mit Slug, `apps-net` extern, `NODE_ENV`,
   Port `3121`, `DB_POOL_MAX`, `- default` in jeder `networks:`-Liste,
   Volume-Altlast `RKI_MD_DIR` entfernen.
3. **`frontend/nginx.conf`**: Upstream `app` → `prowiki-app`.
4. **`.env.example`**: Ports korrigieren (3121/3122), `NODE_ENV`, `DB_POOL_MAX`,
   `SOURCE_DATABASE_URL` als dokumentierter Einmalwert für die Migration.
5. **`deploy.sh`**: Kommentar „Portblock 3101/3102" korrigieren — er behauptet heute
   einen fremden Block. Die Schutzprüfungen (Zielverzeichnis, Origin, kein
   Postgres-Service) bleiben.
6. **Rechts-Links in der Oberfläche** (Abschnitt 6).
7. **Selbstregistrierung schaltbar machen** (Abschnitt 5, Schritt 6).

---

## 4. Reihenfolge der Live-Schaltung

Die Reihenfolge aus NEUE-APP §4 ist nicht beliebig: certbot braucht einen
erreichbaren Vhost, der Vhost einen laufenden Container, der Container die Datenbank.

```sh
# 0. Gegenprüfen, dass 3121 frei ist und apps-net existiert
ssh elmarhepp 'grep -rh proxy_pass /etc/nginx/sites-available/ | sort -u'
ssh elmarhepp 'docker network ls --format "{{.Name}}" | grep apps-net'

# 1. Verzeichnis und Code
ssh elmarhepp 'mkdir -p /var/www/prowiki'
ssh elmarhepp 'git clone https://github.com/elmohuppi-stack/prowiki.git /var/www/prowiki'

# 2. Datenbank, Rolle, Extensions  (Passwort: openssl rand -base64 24 | tr "+/" "-_")
#    Das tr ist Pflicht: ein "/" im Passwort bricht den Verbindungsstring als URL.
ssh elmarhepp 'docker exec -i pg-shared psql -U knora -d postgres' <<'SQL'
CREATE ROLE prowiki LOGIN PASSWORD '<generiert>';   -- kein SUPERUSER, kein CREATEDB
CREATE DATABASE prowiki OWNER prowiki;
REVOKE CONNECT ON DATABASE prowiki FROM PUBLIC;
GRANT  CONNECT ON DATABASE prowiki TO prowiki;
SQL
ssh elmarhepp 'docker exec -i pg-shared psql -U knora -d prowiki' <<'SQL'
ALTER SCHEMA public OWNER TO prowiki;
CREATE EXTENSION IF NOT EXISTS vector;      -- Superuser nötig, siehe 2.3
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS amcheck;     -- gilt pro DB, nicht pro Cluster
SQL

# 3. .env anlegen, Mode 600 (Inhalt siehe Abschnitt 5)
ssh elmarhepp 'chmod 600 /var/www/prowiki/.env'

# 4. Stack starten
ssh elmarhepp 'cd /var/www/prowiki && docker compose up -d --build'
ssh elmarhepp 'docker ps --filter name=prowiki --format "{{.Names}}\t{{.Status}}"'

# 5. Doppelte Aliase prüfen — Ausgabe MUSS leer sein
ssh elmarhepp 'for c in $(docker network inspect apps-net -f "{{range .Containers}}{{.Name}} {{end}}"); do
  docker inspect $c -f "{{range \$k,\$v := .NetworkSettings.Networks}}{{if eq \$k \"apps-net\"}}{{\$v.Aliases}}{{end}}{{end}}" \
    | tr -d "[]" | tr " " "\n" | grep -v "^$" | sort -u; done | sort | uniq -d'

# 6. Schema, Konten, Migration — Abschnitt 5

# 7. nginx-Vhost + Symlink + Test
ssh elmarhepp 'ln -s /etc/nginx/sites-available/prowiki.conf /etc/nginx/sites-enabled/ \
  && nginx -t && systemctl reload nginx'

# 8. Zertifikat
ssh elmarhepp 'certbot --nginx -d prowiki.elmarhepp.de'

# 9. Verifikation
curl -I https://prowiki.elmarhepp.de/
curl -s https://prowiki.elmarhepp.de/health
ssh elmarhepp 'free -h; docker ps --format "{{.Names}}\t{{.Status}}" | sort'
```

Vhost (`/etc/nginx/sites-available/prowiki.conf`), vor certbot:

```nginx
server {
    listen 80;
    server_name prowiki.elmarhepp.de;

    client_max_body_size 512m;          # sonst 413 vor dem Container, siehe 2.5

    location / {
        proxy_pass http://127.0.0.1:3121;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;            # SSE für Chat-Streaming
        proxy_cache off;
        proxy_read_timeout 86400s;
    }
}
```

---

## 5. Daten und Konten

Der heikelste Teil, weil hier zwei Reihenfolgen ineinandergreifen: die Migration
ordnet Nutzer über die **E-Mail** zu, also müssen die Konten **vor** ihr existieren —
und Konten entstehen nur über die reguläre Registrierung.

```sh
cd /var/www/prowiki

# 1. Schema anlegen (Migration; Extensions stehen schon aus Schritt 2)
docker compose --profile tools run --rm prowiki-tools bun run db:migrate

# 2. Beide Konten registrieren — über die laufende App, nicht über die DB
curl -s -X POST http://127.0.0.1:3121/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"…","password":"…","name":"…"}'

# 3. Verifikationslink aus dem Log holen und aufrufen (es gibt keinen Mailversand)
docker compose logs prowiki-app | grep '\[auth\] Verifikation'

# 4. Migration gegen die knora-Datenbank im selben Cluster.
#    Kein Dump, kein Transfer: beide Datenbanken liegen in pg-shared.
#    SOURCE_DATABASE_URL vorher in die .env (Mode 600), danach wieder entfernen —
#    sie enthält knora_apps Zugangsdaten und hat in prowikis .env nichts verloren.
docker compose --profile tools run --rm prowiki-tools \
  bun run src/scripts/migrate-knora.ts \
    --source "$SOURCE_DATABASE_URL" \
    --org "Elmo" --owner elmar.hepp@gmail.com

# 5. Abgleich prüfen — das Skript endet mit Exitcode 1, wenn eine Zahl abweicht
```

Erwartete Laufzeit nach lokaler Messung: **rund eine Minute**, davon 20 s Chunks
und 31 s HNSW-Neubau. Erwartete Größe der neuen Datenbank: **~1,4 GB**, davon
~620 MB Vektorindex.

**Schritt 6: Selbstregistrierung schließen.** NEUE-APP verlangt sie standardmäßig
aus; `emailAndPassword.enabled: true` lässt `POST /api/auth/sign-up/email` heute für
jeden offen, auch ohne Link in der Oberfläche. Da der Bootstrap sie aber braucht,
gehört sie an einen Schalter (`ALLOW_SIGNUP`, Default aus) statt an einen zweiten
Deploy — sonst steht die App zwischen Schritt 2 und 6 offen im Netz.

---

## 6. Rechtliches

Der Teil, der am ehesten liegen bleibt, und der einzige mit Außenwirkung.
Maßgeblich ist [NEUE-APP §3](../../platform/NEUE-APP.md#3-impressum-und-datenschutz).

**Heute hat prowiki weder ein Impressum noch eine Datenschutzseite** — `grep` über
`frontend/src` findet keinen einzigen Treffer. knora hat beides in der Fußzeile.

Zu tun:

- **Fußzeile** in `App.vue` und auf der Login-Seite, mit absolutem Link auf
  `https://elmarhepp.de/impressum`. Keine Anschrift im Repo, nirgends.
- **Eigene, kurze Datenschutzseite**, die für den gemeinsamen Teil auf
  `https://elmarhepp.de/datenschutz` verweist und nur beschreibt, was prowiki selbst
  tut. Darin gehören:
  - **Konten** (Better Auth: Name, E-Mail, Passwort-Hash, Sitzungen in der DB), Löschweg
  - **Inhalte und Uploads**: Dokumente, Transkripte, Chatverläufe
  - **Drittlandtransfer, zweimal** — und das ist der Punkt, der eine Entscheidung
    verlangt, keine Formulierung: Chat-Eingaben gehen an **DeepSeek (China)**,
    Embeddings an **OpenAI (USA)**. Für die USA gibt es das Angemessenheitsbeschluss-
    Konstrukt, für China nicht; ein Transfer dorthin braucht eine eigene Grundlage
    (Art. 49 DSGVO oder Standardvertragsklauseln plus Folgenabschätzung). Solange
    das nur eigene Konten betrifft, ist es überschaubar — vor dem ersten Fremdkunden
    ist es zu klären.
  - **`localStorage`-Schlüssel** benennen: `prowiki-theme`, `prowiki-sidebar`,
    `prowiki-last-wiki`, `prowiki.speech.*`, `activeOrgId`. Einwilligungsfrei, weil
    für die Funktion nötig — aber zu nennen.
  - **Sitzungscookie** von Better Auth, `httpOnly`, 30 Tage.
- **Kein Einwilligungsbanner** nötig (kein Tracking, keine Dritt-Cookies).
- **Reichweitenmessung**: bewusst entscheiden. Wenn ja, die **selbst gehostete**
  Umami-Instanz und ein Text, der das auch sagt.

---

## 7. Nach dem Livegang

1. **[platform/DEPLOYMENT.md](../../platform/DEPLOYMENT.md) ergänzen** — Zeile in der
   App-Tabelle (Domain, Port 3121, `/var/www/prowiki`, Deploy `./deploy.sh`,
   Persistenz `pg-shared → prowiki`) und ein Abschnitt zum Deploy-Weg samt
   `tools`-Profil.
2. **Pool nachmessen** statt schätzen:
   `select datname, count(*) from pg_stat_activity group by 1`. Startwert 8.
3. **Sicherung prüfen.** `pg_dumpall` nimmt die neue Datenbank von selbst mit; die
   nächtliche Datei wächst um rund 1,4 GB. Am Morgen nach dem Livegang einmal in
   `/var/backups/pg-shared/` schauen und `.last-success` gegenlesen.
4. **Abschaltfrage beantworten:** Woran merkt man, dass prowiki *nicht* benutzt wird?
   Vorschlag: UptimeRobot-Prüfung auf `/health` und ein Blick auf `activity_logs`.
5. **Zwei Vektorindizes im Speicher.** Solange knora und prowiki parallel laufen,
   hält der Cluster denselben HNSW-Index zweimal (2 × ~620 MB). Bei 15 GB und
   3,7 GB Ist-Auslastung unkritisch — aber es ist der Posten, der beim Parallelbetrieb
   wächst, und der beim Abschalten von knora wieder verschwindet.

---

## 8. Rückweg

Es gibt keinen Zustand, in dem ein Fehlschlag knora beschädigt — prowiki bekommt eine
eigene Datenbank, eigene Container, einen eigenen Vhost. Der Rückweg ist deshalb kurz:

```sh
ssh elmarhepp 'cd /var/www/prowiki && docker compose down'
ssh elmarhepp 'rm /etc/nginx/sites-enabled/prowiki.conf && nginx -t && systemctl reload nginx'
# Datenbank bleibt stehen; ein erneuter Migrationslauf mit --reset baut sie neu auf.
```

Die einzige Stelle mit Wirkung nach außen ist Schritt 2 der Live-Schaltung — dort wird
in `pg-shared` geschrieben, also in die Instanz, an der fünf Apps hängen. `CREATE
DATABASE` und `CREATE ROLE` sind additiv und berühren die bestehenden Datenbanken
nicht. Trotzdem gilt die Regel aus DEPLOYMENT.md: **kein `docker compose up` in
`/var/www/pg-shared`**, und keine Compose-Datei dorthin kopieren.

---

## 9. Was ausdrücklich nicht dazugehört

- **knora abschalten.** Die fünf Kriterien aus [KONZEPT §7](KONZEPT.md) sind erst
  nach einer Phase realer Nutzung erfüllt.
- **Öffentliche Wikis.** Sichtbarkeit `public` existiert im Schema, aber ohne
  Lese-Seite, ohne SEO, ohne Rate-Limits — das ist Stufe 2.
- **pg-boss und der Worker-Container.** Im Parallelbetrieb tragen die
  `setTimeout`-Jobs. Der Vorbehalt bleibt: ein `docker compose up --build` mitten in
  einem Import verliert ihn stillschweigend.
- **Mailversand.** Verifikations- und Reset-Links stehen im Log. Für zwei bekannte
  Nutzer tragbar, vor dem ersten Fremdkunden nicht.

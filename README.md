# prowiki

> **Aus Videos, Dokumenten und Webseiten wird ein durchsuchbares, befragbares Wiki — öffentlich oder privat.**

prowiki verwandelt die Inhalte eines YouTube-Kanals, einer Redaktion oder einer Firma in ein
verlinktes Wiki mit Volltext- und Vektorsuche und einem RAG-Chat, der Antworten mit Quellen
belegt. Ein Kanal mit 300 Videos wird in einem Vorgang importiert; neue Videos ziehen
automatisch nach.

**TypeScript Ende-zu-Ende** — Vue 3 + Bun/Hono + PostgreSQL/pgvector.

---

## Status

**In Arbeit: Stufe 0 (Fundament).** prowiki ist die Weiterentwicklung von
[knora](https://github.com/elmohuppi-stack/knora) zu einem mandantenfähigen Produkt. Der
inhaltliche Kern ist aus knora übernommen und produktiv erprobt; neu gebaut wird die Schicht
darunter: Identität, Mandanten, Rechte, Sichtbarkeit, Jobs.

| Bereich | Stand |
|---|---|
| Ingest (PDF/DOCX/HTML, URL, YouTube), Chunking, Embedding | aus knora übernommen, läuft |
| Hybride Suche (pgvector + tsvector + Trigramm) | aus knora übernommen, läuft |
| Wiki-Generierung, `[[Links]]`, Graph, Themen, Backlinks | aus knora übernommen, läuft |
| RAG-Chat mit Quellen und SSE-Streaming | aus knora übernommen, läuft |
| **Better Auth: Sitzungen, Verifikation, Reset, Rate-Limits** | **Konfiguration steht** |
| **Mandanten-Schema (Organisation → Wiki → Seite)** | **Schema steht** |
| **Capability-Rechtemodell, Sichtbarkeit private/link/public** | **Auflösung steht** |
| Router und Services auf das neue Modell umstellen | offen |
| pg-boss + Worker-Container statt `setTimeout`-Jobs | offen |
| Kanal-Import für ganze YouTube-Kanäle (Stufe 1) | offen |
| Öffentliche Lese-Seite mit SSR/SEO (Stufe 2) | offen |

Konzept, Befunde und Roadmap: [`docs/KONZEPT.md`](docs/KONZEPT.md).
Server, Kapazität und Betriebsumgebungen: [`docs/HOSTING.md`](docs/HOSTING.md).

---

## Was prowiki gegenüber knora anders macht

knora ist ein persönliches Werkzeug für einen Betreiber, der allen Nutzern vertraut. Das ist
für ein Produkt untragbar. Die vier tragenden Änderungen:

**1. Mandanten statt Einzelnutzer.** Drei Ebenen statt zwei:

```
organization      Abrechnungs- und Vertrauensgrenze (Kanal, Redaktion, Agentur)
  └─ wiki         in knora "workspace"; hat eine Sichtbarkeit
       └─ page    Artikel
```

**2. Rechte über Capabilities, nicht über Rollen-Vergleiche.** Geprüft wird immer eine
Capability (`wiki.publish`, `source.import`), nie eine Rolle. Rollen sind nur benannte
Bündel — neue Abstufungen sind Datenänderung, kein Codeeingriff.

| Capability | owner | admin | editor | author | reviewer | viewer | anonym |
|---|---|---|---|---|---|---|---|
| `wiki.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | nur `public`/`link` |
| `wiki.write` | ✓ | ✓ | ✓ | ✓ | – | – | – |
| `wiki.publish` | ✓ | ✓ | ✓ | – | ✓ | – | – |
| `wiki.delete` | ✓ | ✓ | – | – | – | – | – |
| `source.import` | ✓ | ✓ | ✓ | – | – | – | – |
| `chat.use` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | wenn freigeschaltet |
| `settings.manage` | ✓ | ✓ | – | – | – | – | – |
| `billing.manage` | ✓ | – | – | – | – | – | – |

**3. Öffentlichkeit als erstklassiges Konzept.** Jedes Wiki hat eine Sichtbarkeit:
`private` (nur Mitglieder) · `link` (wer die URL hat) · `public` (indexierbar). Anonymer
Chat wird je Wiki einzeln freigeschaltet, weil jede Frage Geld kostet.

**4. Zeitmarken im Transkript.** `transcript_segments` speichert Segmentzeiten, damit jeder
Artikelabsatz auf die Sekunde im Video verlinken kann. knora warf diese Daten weg;
Nachrüsten hätte bedeutet, alle Transkripte erneut zu bezahlen.

---

## Architektur

```
prowiki/
├── backend/                    Bun + Hono
│   └── src/
│       ├── auth/
│       │   ├── index.ts        Better Auth (Sessions, Verifikation, Orgs, Rate-Limits)
│       │   └── permissions.ts  Capability-Statement und Rollenbündel
│       ├── middleware/
│       │   ├── auth.ts         Sitzung → principal (blockiert nicht)
│       │   └── access.ts       principal + wiki → Capability-Menge  ← einzige Rechtequelle
│       ├── db/schema/
│       │   ├── auth.ts         user, session, account, organization, member, invitation
│       │   ├── tenancy.ts      wikis, wiki_members, usage_events, audit_events, api_keys
│       │   └── content.ts      documents, transcript_segments, chunks, wiki_pages, chat
│       ├── router/             REST-Routen
│       └── service/            Fachlogik
├── frontend/                   Vue 3 + Vite + PrimeVue (Autoren-App)
├── packages/shared/            TypeScript-Typen für beide Seiten
├── parser/                     MarkItDown (Python) für PDF/DOCX/HTML
└── docs/
    ├── KONZEPT.md              Befunde, Zielarchitektur, Roadmap
    └── HOSTING.md              Kapazität, Anbietervergleich, Betriebsumgebungen
```

| Komponente | Technologie |
|---|---|
| Backend | [Bun](https://bun.sh) + [Hono](https://hono.dev) |
| Identität | [Better Auth](https://better-auth.com) — Sessions in der DB, 2FA/SSO nachrüstbar |
| Jobs | [pg-boss](https://github.com/timgit/pg-boss) — persistent in Postgres, kein Redis |
| Frontend | [Vue 3](https://vuejs.org) + [Vite](https://vitejs.dev) + [PrimeVue](https://primevue.org) |
| ORM | [Drizzle](https://orm.drizzle.team) |
| Datenbank | [PostgreSQL](https://www.postgresql.org) + [pgvector](https://github.com/pgvector/pgvector) |
| LLM | [Vercel AI SDK](https://sdk.vercel.ai/docs) (SSE-Streaming) |

---

## Quickstart

Voraussetzungen: [Bun](https://bun.sh) 1.2+, [Docker](https://www.docker.com).

```bash
git clone https://github.com/elmohuppi-stack/prowiki.git
cd prowiki

cp .env.example .env
# AUTH_SECRET setzen: openssl rand -base64 32
# Ohne AUTH_SECRET bricht der Start ab — bewusst, statt still mit einem
# Default-Secret aus dem Repository weiterzulaufen.

docker compose -f docker-compose.dev.yml up -d db
bun install

cd backend
bun run db:migrate
cd ..

bun run dev              # Backend, Hot-Reload
cd frontend && bun run dev
```

Die Entwicklungs-Datenbank läuft auf **Port 5433** und der Parser auf **8002**, damit knora
auf derselben Maschine parallel weiterlaufen kann, bis es abgeschaltet wird.

---

## Entwicklung

```bash
cd backend
bun run db:generate      # Migration aus dem Schema erzeugen
bun run db:migrate       # anwenden
bunx tsc --noEmit        # Typecheck

cd frontend
bunx vite build          # fängt Template-Fehler, die der Dev-Server durchlässt
```

Konventionen und Fallstricke: [`.instructions.md`](.instructions.md).

---

## Lizenz

MIT — siehe [LICENSE](./LICENSE).

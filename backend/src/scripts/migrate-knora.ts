#!/usr/bin/env bun
/**
 * Überführt eine knora-Datenbank in prowiki.
 *
 * Ausgangslage: knora kennt `workspaces`, die einem Nutzer gehören. prowiki
 * kennt `organization → wiki → page` (KONZEPT 4.1). Inhaltlich sind die
 * Tabellen deckungsgleich — die Migration ist deshalb im Kern ein
 * `INSERT … SELECT` je Tabelle mit drei Umbenennungen:
 *
 *   workspace_id (varchar) → wiki_id (varchar)   Wert bleibt gleich
 *   users.id     (integer) → user.id   (text)    über die E-Mail zugeordnet
 *   workspaces             → wikis                + organization_id, slug, visibility
 *
 * **Die Workspace-UUID wird zur Wiki-UUID.** Damit bleibt jeder `workspace_id`-Wert
 * in documents, chunks, wiki_pages, topics, chat_sessions und activity_logs
 * unverändert gültig, und es braucht keine Abbildungstabelle. Dasselbe gilt für
 * Dokument-, Chunk- und Seiten-IDs: sie werden übernommen, weil `out_links`,
 * `chunk_refs` und `source_document_id` sonst ins Leere zeigen würden.
 *
 * Die Massendaten (82.000 Chunks mit je 1536 Dimensionen) laufen über
 * `COPY … TO STDOUT` → `COPY … FROM STDIN`. Sie werden dabei nie in JavaScript
 * materialisiert; das Skript hält immer nur den Stream in der Hand.
 *
 * Nutzerkonten legt dieses Skript **nicht** an — genauso wenig wie
 * bootstrap-org.ts. Konten entstehen über die reguläre Registrierung samt
 * Verifikation (Befund 2.1). Wer zum Zeitpunkt der Migration noch kein
 * prowiki-Konto hat, hinterlässt in `created_by` eine Null; die Inhalte selbst
 * wandern vollständig.
 *
 * Aufruf:
 *   bun run src/scripts/migrate-knora.ts \
 *     --source postgresql://…/knora_src \
 *     --org "Elmo" [--slug elmo] [--owner elmar.hepp@gmail.com] \
 *     [--reset] [--dry-run]
 */
import { pipeline } from "node:stream/promises";
import postgres from "postgres";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dryRun = process.argv.includes("--dry-run");
const doReset = process.argv.includes("--reset");
const sourceUrl = arg("source") ?? process.env.SOURCE_DATABASE_URL;
const targetUrl = arg("target") ?? process.env.DATABASE_URL;
const orgName = arg("org");
const ownerEmail = arg("owner");

/** Wie in bootstrap-org.ts — Umlaute ausgeschrieben statt entfernt. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** SQL-Literal für einen Text; nur für Werte aus der eigenen Datenbank. */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Reihenfolge ist Fremdschlüsselreihenfolge, nicht Größenreihenfolge.
 * `select` ist die Projektion auf der knora-Seite, `columns` die Zielspalten —
 * beide in derselben Reihenfolge, sonst schiebt COPY Werte in die falsche Spalte.
 */
interface TableSpec {
  target: string;
  source: string;
  columns: string[];
  select: (u: (col: string) => string) => string[];
  /** Sequenz, die nach dem Kopieren nachgezogen werden muss (serial-Spalten). */
  sequence?: { name: string; column: string };
}

const TABLES: TableSpec[] = [
  {
    target: "documents",
    source: "documents",
    columns: [
      "id", "wiki_id", "title", "type", "source", "source_url", "content",
      "file_path", "file_size", "file_hash", "parse_status", "parse_error",
      "chunk_count", "channel", "published_at", "duration", "source_metadata",
      "created_by", "created_at", "updated_at", "processed_at",
    ],
    select: (u) => [
      "id", "workspace_id", "title", "type", "source", "source_url", "content",
      "file_path", "file_size", "file_hash", "parse_status", "parse_error",
      "chunk_count", "channel", "published_at", "duration", "source_metadata",
      u("created_by"), "created_at", "updated_at", "processed_at",
    ],
  },
  {
    target: "topics",
    source: "topics",
    columns: ["id", "wiki_id", "slug", "label", "description", "color", "sort_order", "created_at"],
    select: () => ["id", "workspace_id", "slug", "label", "description", "color", "sort_order", "created_at"],
  },
  {
    target: "document_topics",
    source: "document_topics",
    columns: ["id", "document_id", "topic_id", "source", "created_at"],
    select: () => ["id", "document_id", "topic_id", "source", "created_at"],
    sequence: { name: "document_topics_id_seq", column: "id" },
  },
  {
    target: "chunks",
    source: "chunks",
    // start_ms/end_ms bleiben leer: knora warf die Segmentzeiten beim Import weg
    // (Befund 3.5). Tiefe Video-Links gibt es deshalb erst für Neuimporte.
    columns: ["id", "document_id", "wiki_id", "content", "chunk_index", "token_count", "embedding", "created_at"],
    select: () => ["id", "document_id", "workspace_id", "content", "chunk_index", "token_count", "embedding", "created_at"],
  },
  {
    target: "wiki_pages",
    source: "wiki_pages",
    // generated_by_ai = true für alle Altseiten: knora hat jede Wiki-Seite
    // generiert, es gab keinen anderen Weg, eine anzulegen (KONZEPT 5.5, Punkt 19).
    // `manually_edited` bleibt davon unberührt — es sagt aus, ob jemand die
    // generierte Seite später von Hand überarbeitet hat.
    columns: [
      // Kein `length`: die Spalte steht zwar in knoras schema.ts, wurde aber
      // nie in eine Migration übernommen und existiert in keiner der beiden
      // Datenbanken. Maßgeblich ist hier die Datenbank, nicht die Schemadatei.
      "id", "wiki_id", "slug", "title", "summary", "content", "page_type",
      "status", "source_document_id", "parent_slug", "sort_order",
      "out_links", "in_links", "aliases", "source_refs", "chunk_refs",
      "page_metadata", "generated_by_ai", "generated_at", "version",
      "created_by", "updated_by", "manually_edited", "created_at", "updated_at",
    ],
    select: (u) => [
      "id", "workspace_id", "slug", "title", "summary", "content", "page_type",
      "status", "source_document_id", "parent_slug", "sort_order",
      "out_links", "in_links", "aliases", "source_refs", "chunk_refs",
      "page_metadata", "true", "created_at", "version",
      u("created_by"), u("updated_by"), "manually_edited", "created_at", "updated_at",
    ],
  },
  {
    target: "wiki_page_revisions",
    source: "wiki_page_revisions",
    columns: ["id", "page_id", "wiki_id", "version", "title", "summary", "content", "edited_by", "created_at"],
    select: (u) => ["id", "page_id", "workspace_id", "version", "title", "summary", "content", u("edited_by"), "created_at"],
    sequence: { name: "wiki_page_revisions_id_seq", column: "id" },
  },
  {
    target: "chat_sessions",
    source: "chat_sessions",
    columns: ["id", "wiki_id", "user_id", "title", "model_id", "created_at", "updated_at"],
    select: (u) => ["id", "workspace_id", u("user_id"), "title", "model_id", "created_at", "updated_at"],
  },
  {
    target: "chat_messages",
    source: "chat_messages",
    columns: ["id", "session_id", "role", "content", "knowledge_refs", "created_at"],
    select: () => ["id", "session_id", "role", "content", "knowledge_refs", "created_at"],
  },
  {
    target: "activity_logs",
    source: "activity_logs",
    columns: ["id", "action", "status", "message", "details", "wiki_id", "document_id", "user_id", "duration_ms", "created_at"],
    select: (u) => ["id", "action", "status", "message", "details", "workspace_id", "document_id", u("user_id"), "duration_ms", "created_at"],
  },
];

async function main() {
  if (!sourceUrl || !targetUrl || !orgName) {
    console.error(
      'Aufruf: --source <knora-url> [--target <prowiki-url>] --org "<Name>" ' +
        "[--slug <slug>] [--owner <email>] [--reset] [--dry-run]",
    );
    process.exit(1);
  }

  const orgSlug = arg("slug") ?? slugify(orgName);
  const src = postgres(sourceUrl, { max: 2, onnotice: () => {} });
  const dst = postgres(targetUrl, { max: 2, onnotice: () => {} });

  // ---------------------------------------------------------------- Nutzer
  const srcUsers = await src<{ id: number; email: string; name: string }[]>`
    select id, email, name from users order by id`;
  const dstUsers = await dst<{ id: string; email: string }[]>`
    select id, email from "user"`;
  const byEmail = new Map(dstUsers.map((u) => [u.email.toLowerCase(), u.id]));

  const userMap = new Map<number, string>();
  const unmatched: string[] = [];
  for (const u of srcUsers) {
    const hit = byEmail.get(u.email.toLowerCase());
    if (hit) userMap.set(u.id, hit);
    else unmatched.push(`${u.email} (knora-ID ${u.id}, ${u.name})`);
  }

  /** `created_by`-Ausdruck: int-ID der Quelle → text-ID des Ziels, sonst NULL. */
  const mapUser = (col: string): string => {
    if (userMap.size === 0) return `null::text`;
    const cases = [...userMap]
      .map(([from, to]) => `when ${from} then ${lit(to)}`)
      .join(" ");
    return `(case ${col} ${cases} else null end)::text`;
  };

  console.log(`Quelle       : ${sourceUrl.replace(/:[^:@]+@/, ":***@")}`);
  console.log(`Ziel         : ${targetUrl.replace(/:[^:@]+@/, ":***@")}`);
  console.log(`Organisation : ${orgName} (${orgSlug})`);
  console.log(
    `Nutzer       : ${userMap.size} von ${srcUsers.length} zugeordnet` +
      (unmatched.length ? `\n  ⚠️  ohne prowiki-Konto: ${unmatched.join(", ")}` : ""),
  );

  // -------------------------------------------------------------- Workspaces
  const workspaces = await src<
    {
      id: string; name: string; description: string | null; created_by: number | null;
      chunk_size: number; chunk_overlap: number;
      embedding_model_id: string | null; chat_model_id: string | null;
      indexing_strategy: unknown; wiki_config: unknown;
      created_at: Date; updated_at: Date;
    }[]
  >`select * from workspaces order by created_at`;

  // Slugs kollisionsfrei: knora hatte keinen Slug, zwei Workspaces dürfen aber
  // "Archiv (alt)" und "Archiv-alt" heißen — beides ergäbe denselben Slug.
  const takenSlugs = new Set<string>();
  const wikiSlugs = new Map<string, string>();
  for (const ws of workspaces) {
    const base = slugify(ws.name) || "wiki";
    let slug = base;
    for (let n = 2; takenSlugs.has(slug); n++) slug = `${base}-${n}`;
    takenSlugs.add(slug);
    wikiSlugs.set(ws.id, slug);
  }

  console.log(`\nWikis        : ${workspaces.length}`);
  for (const ws of workspaces) {
    console.log(`  ${wikiSlugs.get(ws.id)!.padEnd(24)} ${ws.name}`);
  }

  if (dryRun) {
    console.log("\n(DRY-RUN — nichts geschrieben)");
    await src.end();
    await dst.end();
    return;
  }

  // ------------------------------------------------------------------ Reset
  if (doReset) {
    console.log("\n--reset: leere Zieltabellen …");
    await dst.unsafe(`
      truncate table
        activity_logs, chat_messages, chat_sessions, wiki_page_revisions,
        wiki_pages, chunks, document_topics, topics, documents,
        transcript_segments, wiki_members, wikis
      restart identity cascade`);
    await dst.unsafe(`delete from member where organization_id in
      (select id from organization where slug = ${lit(orgSlug)})`);
    await dst.unsafe(`delete from organization where slug = ${lit(orgSlug)}`);
    await dst.unsafe(`delete from model_providers`);
  }

  // ----------------------------------------------------- Organisation + Wikis
  const [existingOrg] = await dst<{ id: string }[]>`
    select id from organization where slug = ${orgSlug} limit 1`;

  let orgId = existingOrg?.id;
  if (!orgId) {
    orgId = crypto.randomUUID();
    await dst`insert into organization ${dst({
      id: orgId,
      name: orgName,
      slug: orgSlug,
      created_at: new Date(),
    })}`;
    console.log(`\nOrganisation angelegt: ${orgId}`);
  } else {
    console.log(`\nOrganisation vorhanden: ${orgId}`);
  }

  // Mitgliedschaften: der --owner bekommt `owner`, alle übrigen zugeordneten
  // Nutzer `admin`. knoras globale Rolle wird bewusst nicht übernommen — sie
  // galt über alle Workspaces hinweg und ist genau der Befund, den prowiki
  // ablöst (2.5).
  //
  // Ohne --owner fällt die Inhaberschaft an den Nutzer, dem in knora die
  // meisten Workspaces gehörten. Eine Organisation ohne Inhaber hätte
  // niemanden, der `billing.manage` besitzt.
  let ownerUserId: string | null = null;
  if (ownerEmail) {
    ownerUserId = byEmail.get(ownerEmail.toLowerCase()) ?? null;
    if (!ownerUserId) {
      console.error(`❌ Kein prowiki-Konto für --owner ${ownerEmail}.`);
      process.exit(1);
    }
  } else {
    const [haeufigster] = await src<{ created_by: number }[]>`
      select created_by from workspaces
      where created_by is not null
      group by created_by order by count(*) desc limit 1`;
    ownerUserId = haeufigster ? (userMap.get(haeufigster.created_by) ?? null) : null;
  }

  for (const [, userId] of userMap) {
    const [u] = await dst<{ email: string }[]>`
      select email from "user" where id = ${userId}`;
    const role = userId === ownerUserId ? "owner" : "admin";
    await dst`
      insert into member ${dst({
        id: crypto.randomUUID(),
        organization_id: orgId,
        user_id: userId,
        role,
        created_at: new Date(),
      })}
      on conflict do nothing`;
    console.log(`  Mitglied ${u.email} → ${role}`);
  }
  if (!ownerUserId) {
    console.warn(
      "  ⚠️  Kein Inhaber gesetzt — niemand hat `billing.manage`. " +
        "Nachholen mit bootstrap-org.ts oder --owner.",
    );
  }

  // Modellanbieter zuerst: wikis.embedding_model_id zeigt darauf.
  //
  // Sie gehören der migrierten Organisation, nicht der Plattform. In knora war
  // die Liste global, weil es genau einen Betreiber gab — dessen API-Schlüssel
  // sind jetzt die der Organisation ("bring your own key", KONZEPT 5.4).
  // Ein `organization_id = null` hieße Plattform-Anbieter: der taucht in
  // `listProviders(orgId)` nirgends auf und wäre in den Einstellungen weder
  // sicht- noch änderbar.
  const providerCopied = await copyTable(sourceUrl, targetUrl, dst, {
    target: "model_providers",
    source: "model_providers",
    columns: ["id", "organization_id", "name", "provider_type", "api_base_url",
      "api_key_encrypted", "default_model", "is_active", "created_at", "updated_at"],
    select: () => [
      "id", `${lit(orgId!)}::text`, "name", "provider_type", "api_base_url",
      "api_key_encrypted", "default_model", "is_active", "created_at", "updated_at"],
  });
  console.log(`  model_providers: ${providerCopied}`);

  for (const ws of workspaces) {
    await dst`
      insert into wikis ${dst({
        // Die Workspace-UUID wird zur Wiki-UUID — siehe Kopfkommentar.
        id: ws.id,
        organization_id: orgId,
        slug: wikiSlugs.get(ws.id)!,
        name: ws.name,
        description: ws.description,
        // Alle migrierten Wikis starten privat. Öffentlich wird bewusst
        // geschaltet, nicht bei einer Migration nebenbei vergeben.
        visibility: "private",
        anonymous_chat_enabled: false,
        chunk_size: ws.chunk_size,
        chunk_overlap: ws.chunk_overlap,
        embedding_model_id: ws.embedding_model_id,
        chat_model_id: ws.chat_model_id,
        indexing_strategy: ws.indexing_strategy as object,
        wiki_config: ws.wiki_config as object,
        created_by: ws.created_by ? (userMap.get(ws.created_by) ?? null) : null,
        created_at: ws.created_at,
        updated_at: ws.updated_at,
      })}
      on conflict (id) do nothing`;
  }
  console.log(`  wikis: ${workspaces.length}`);

  // ------------------------------------------------------------- Massendaten
  //
  // Der HNSW-Index wird für den Import abgeworfen und danach in einem Zug neu
  // gebaut. 82.000 Vektoren einzeln in einen bestehenden HNSW-Graphen
  // einzufügen dauert ein Vielfaches des Neuaufbaus — und der Graph wird dabei
  // schlechter balanciert.
  console.log("\nInhalte:");
  await dst.unsafe(`drop index if exists chunks_embedding_hnsw_idx`);

  for (const spec of TABLES) {
    const started = Date.now();
    const rows = await copyTable(sourceUrl, targetUrl, dst, spec, mapUser);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ${spec.target.padEnd(20)} ${String(rows).padStart(7)} Zeilen  (${secs}s)`);

    if (spec.sequence) {
      await dst.unsafe(
        `select setval('${spec.sequence.name}',
           coalesce((select max(${spec.sequence.column}) from ${spec.target}), 0) + 1, false)`,
      );
    }
  }

  // Wie in Migration 0001 — dieselbe Definition, sonst weicht die migrierte
  // Datenbank vom Schemastand ab.
  const indexStart = Date.now();
  await dst.unsafe(`set maintenance_work_mem = '1GB'`);
  await dst.unsafe(
    `create index if not exists chunks_embedding_hnsw_idx
       on chunks using hnsw (embedding vector_cosine_ops)`,
  );
  console.log(
    `  ${"HNSW-Index".padEnd(20)} ${" ".repeat(7)}         (${((Date.now() - indexStart) / 1000).toFixed(1)}s)`,
  );

  // ------------------------------------------------- external_id nachtragen
  // Befund 3.4: knora hatte keinen Unique-Index auf der Quelle, ein zweiter
  // Import desselben Videos erzeugte ein Duplikat samt doppelter Kosten.
  // prowiki verhindert das über (wiki_id, external_id) — der Wert lässt sich
  // für YouTube-Dokumente aus der URL zurückgewinnen. Wo bereits Duplikate
  // liegen, bleibt external_id null (der Index verbietet den zweiten Eintrag),
  // und die Dubletten werden hier benannt statt stillschweigend übergangen.
  const nachgetragen = await dst`
    with kandidaten as (
      select id, wiki_id,
             substring(source_url from '(?:v=|youtu\\.be/|/shorts/)([A-Za-z0-9_-]{11})') as vid
      from documents
      where type = 'youtube' and source_url is not null and external_id is null
    ),
    eindeutig as (
      -- Nur wo das Paar (Wiki, Video) genau einmal vorkommt. Bei Dubletten
      -- verbietet der Unique-Index den zweiten Eintrag; beide bleiben dann leer,
      -- statt dass eine willkürliche Hälfte gewinnt.
      select wiki_id, vid from kandidaten
      where vid is not null
      group by wiki_id, vid having count(*) = 1
    )
    update documents d set external_id = k.vid
    from kandidaten k
    join eindeutig e on e.wiki_id = k.wiki_id and e.vid = k.vid
    where d.id = k.id
    returning 1`;
  console.log(`\nexternal_id nachgetragen: ${nachgetragen.length} YouTube-Dokumente`);

  const dubletten = await dst<{ wiki_id: string; vid: string; anzahl: number }[]>`
    select wiki_id,
           substring(source_url from '(?:v=|youtu\\.be/|/shorts/)([A-Za-z0-9_-]{11})') as vid,
           count(*)::int as anzahl
    from documents
    where type = 'youtube' and source_url is not null
    group by 1, 2 having count(*) > 1 order by 3 desc`;
  if (dubletten.length) {
    console.log(`⚠️  ${dubletten.length} Videos mehrfach importiert (external_id bleibt leer):`);
    for (const d of dubletten.slice(0, 10)) {
      console.log(`    ${d.vid} × ${d.anzahl}  in Wiki ${d.wiki_id}`);
    }
  }

  await abgleich(src, dst);
  await src.end();
  await dst.end();
}

/**
 * Streamt eine Tabelle von der Quelle ins Ziel und liefert die Zeilenzahl.
 *
 * Jeder Kopiervorgang bekommt zwei **eigene, danach geschlossene** Verbindungen.
 * Wiederverwendet man die Verbindung aus dem Pool, bleibt sie nach einem großen
 * `COPY` in einem Zustand, in dem der nächste `COPY` still hängt statt zu
 * scheitern — beobachtet nach den 82.600 Chunks: Quelle und Ziel warteten
 * beide auf den jeweils anderen. Eine frische Verbindung je Tabelle kostet
 * Millisekunden und schließt diese Klasse Fehler aus.
 */
async function copyTable(
  sourceUrl: string,
  targetUrl: string,
  dst: postgres.Sql,
  spec: TableSpec,
  mapUser: (col: string) => string = () => "null::text",
): Promise<number> {
  const projection = spec.select(mapUser).join(", ");
  const [{ n: vorher }] = await dst.unsafe(
    `select count(*)::int as n from ${spec.target}`,
  );

  const from = postgres(sourceUrl, { max: 1, onnotice: () => {} });
  const to = postgres(targetUrl, { max: 1, onnotice: () => {} });
  try {
    const readable = await from
      .unsafe(`copy (select ${projection} from ${spec.source}) to stdout`)
      .readable();
    const writable = await to
      .unsafe(`copy ${spec.target} (${spec.columns.join(", ")}) from stdin`)
      .writable();
    await pipeline(readable, writable);
  } finally {
    await from.end({ timeout: 5 });
    await to.end({ timeout: 5 });
  }

  const [{ n: nachher }] = await dst.unsafe(
    `select count(*)::int as n from ${spec.target}`,
  );
  return (nachher as number) - (vorher as number);
}

/**
 * Zeilenabgleich Quelle ↔ Ziel. Erstes der fünf Abschaltkriterien aus
 * KONZEPT §7 — ohne diesen Vergleich ist die Migration nicht bewertbar.
 */
async function abgleich(src: postgres.Sql, dst: postgres.Sql) {
  const paare: [string, string][] = [
    ["documents", "documents"],
    ["chunks", "chunks"],
    ["wiki_pages", "wiki_pages"],
    ["topics", "topics"],
    ["document_topics", "document_topics"],
    ["wiki_page_revisions", "wiki_page_revisions"],
    ["chat_sessions", "chat_sessions"],
    ["chat_messages", "chat_messages"],
    ["activity_logs", "activity_logs"],
    ["workspaces", "wikis"],
  ];

  console.log("\nAbgleich (knora → prowiki):");
  let abweichungen = 0;
  for (const [a, b] of paare) {
    const [{ n: soll }] = await src.unsafe(`select count(*)::int as n from ${a}`);
    const [{ n: ist }] = await dst.unsafe(`select count(*)::int as n from ${b}`);
    const ok = soll === ist;
    if (!ok) abweichungen++;
    console.log(
      `  ${ok ? "✓" : "✗"} ${a.padEnd(20)} ${String(soll).padStart(7)} → ${String(ist).padStart(7)}`,
    );
  }

  // Embeddings sind der teuerste Teil der Migration — sie müssen exakt
  // übereinstimmen, sonst ist die Vektorsuche im Ziel stiller Schrott.
  const [{ n: sollEmb }] = await src.unsafe(
    `select count(embedding)::int as n from chunks`,
  );
  const [{ n: istEmb }] = await dst.unsafe(
    `select count(embedding)::int as n from chunks`,
  );
  const embOk = sollEmb === istEmb;
  if (!embOk) abweichungen++;
  console.log(
    `  ${embOk ? "✓" : "✗"} ${"chunks mit Embedding".padEnd(20)} ${String(sollEmb).padStart(7)} → ${String(istEmb).padStart(7)}`,
  );

  // Handarbeit darf nicht verlorengehen: sonst überschreibt der erste
  // Generierungslauf in prowiki die manuellen Korrekturen (KONZEPT §7).
  const [{ n: sollMan }] = await src.unsafe(
    `select count(*)::int as n from wiki_pages where manually_edited`,
  );
  const [{ n: istMan }] = await dst.unsafe(
    `select count(*)::int as n from wiki_pages where manually_edited`,
  );
  const manOk = sollMan === istMan;
  if (!manOk) abweichungen++;
  console.log(
    `  ${manOk ? "✓" : "✗"} ${"manuell bearbeitet".padEnd(20)} ${String(sollMan).padStart(7)} → ${String(istMan).padStart(7)}`,
  );

  console.log(
    abweichungen === 0
      ? "\n✅ Alle Zeilenzahlen stimmen überein."
      : `\n❌ ${abweichungen} Abweichung(en) — Migration nicht abgeschlossen.`,
  );
  if (abweichungen > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Migration fehlgeschlagen:", err);
  process.exit(1);
});

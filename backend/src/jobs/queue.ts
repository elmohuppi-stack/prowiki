/**
 * Persistente Job-Warteschlange (pg-boss).
 *
 * ## Warum überhaupt
 *
 * Bis zum 21. August 2026 liefen alle Hintergrundarbeiten über `setTimeout`
 * im API-Prozess: Datei-Upload, URL-Import, Chunking, Embedding,
 * Wiki-Generierung, Chat→Wiki. Das hatte einen Fehler, der sich nicht
 * wegkonfigurieren lässt — **ein Neustart verliert sie still.** `deploy.sh`
 * macht ein `docker compose up --build`, und ein Import, der in dem Moment
 * mitten im Chunking steht, ist danach einfach weg: das Dokument bleibt auf
 * `processing` stehen, niemand wird benachrichtigt, kein Log sagt etwas.
 * Bei zwei bekannten Nutzern ist das ärgerlich; beim Kanal-Import aus Stufe 1
 * (300 Videos in einem Vorgang) ist es das Ende des Vorgangs.
 *
 * pg-boss legt die Jobs in dieselbe Postgres-Instanz, in der die Daten schon
 * liegen. Kein weiterer Dienst, kein Redis, und die Sicherung erfasst die
 * Warteschlange von selbst mit — ein Job überlebt damit nicht nur den
 * Neustart, sondern auch das Zurückspielen eines Dumps.
 *
 * ## Wer schreibt, wer arbeitet
 *
 * Die API **stellt nur ein** (`enqueue`), sie arbeitet nichts ab. Abgearbeitet
 * wird im eigenen Container `prowiki-worker` (`jobs/worker.ts`). Diese Trennung
 * ist der eigentliche Gewinn: ein langer Import kann den HTTP-Prozess nicht
 * mehr blockieren, und der Worker darf neu gestartet werden, ohne dass die
 * Oberfläche ausfällt.
 *
 * ## Verbindungsbudget
 *
 * pg-boss hält einen **eigenen** Pool, zusätzlich zu dem aus `db/index.ts`.
 * Auf `pg-shared` gilt `max_connections = 100` für alle Apps zusammen
 * (platform/ARCHITEKTUR.md 4.2), deshalb ist er hier bewusst klein: er führt
 * nur Warteschlangen-SQL aus, keine Nutzlast.
 */
// pg-boss 12 exportiert die Klasse benannt, nicht als Default — und die Typen
// einzeln statt als Namensraum unter der Klasse.
import { PgBoss } from "pg-boss";
import type { SendOptions } from "pg-boss";

/**
 * Die Namen der Warteschlangen. Als Konstanten, weil pg-boss sie seit v10
 * **vorher angelegt** haben will (`createQueue`) — ein Tippfehler in einem
 * `send()` wäre sonst kein Fehler, sondern ein Job, den nie jemand abholt.
 */
export const QUEUE = {
  /** Hochgeladene Datei aus dem Spool lesen, Text extrahieren, chunken. */
  fileImport: "file.import",
  /** Webseite laden, Text extrahieren, chunken. */
  urlImport: "url.import",
  /** Dokumenttext in Chunks schneiden und speichern. */
  chunk: "document.chunk",
  /** Fehlende Embeddings eines Wiki nachziehen. */
  embed: "wiki.embed",
  /** Wiki-Artikel aus einem Dokument erzeugen. */
  wikiGenerate: "wiki.generate",
  /** Artikelverbund aus einem Chatverlauf erzeugen. */
  chatCluster: "wiki.from-chat",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/**
 * Nutzlasten. Bewusst klein gehalten: was in der Datenbank steht, wird dort
 * gelesen und nicht durch die Job-Tabelle geschleppt.
 *
 * Der Volltext eines Dokuments ist der Grund für diese Regel. Er wird beim
 * Import ohnehin nach `documents.content` geschrieben, *bevor* gechunkt wird —
 * ihn zusätzlich in die Nutzlast zu legen hieße, jedes Transkript zweimal zu
 * speichern und die Warteschlangentabelle mit Megabytes zu füllen, die einen
 * Tag später Müll sind. Die `timeline` bleibt dagegen in der Nutzlast: sie ist
 * ein Eintrag je 30-Sekunden-Block, also wenige Kilobyte selbst bei einem
 * mehrstündigen Video, und sie aus dem Text zurückzurechnen wäre fehleranfällig.
 */
export interface JobPayloads {
  [QUEUE.fileImport]: {
    docId: string;
    wikiId: string;
    userId: string;
    fileName: string;
    fileType: string;
    /** Pfad im geteilten Spool-Verzeichnis, siehe jobs/spool.ts. */
    spoolPath: string;
    /** Beim Import gewählter Chat-Anbieter, siehe service/provider.ts. */
    providerId?: string;
  };
  [QUEUE.urlImport]: {
    docId: string;
    wikiId: string;
    userId: string;
    url: string;
    providerId?: string;
  };
  [QUEUE.chunk]: {
    docId: string;
    wikiId: string;
    /** Zeichen-zu-Zeit-Zuordnung; nur bei YouTube-Importen belegt. */
    timeline?: Array<{
      char_start: number;
      char_end: number;
      start_ms: number;
      end_ms: number | null;
    }>;
    /** Vorhandene Chunks vorher löschen (erneuter Transkript-Abruf). */
    replace?: boolean;
  };
  [QUEUE.embed]: { wikiId: string };
  /**
   * `providerId` ist die Wahl aus dem Import-Dialog. Sie wandert durch die
   * Nutzlast und nicht über das Dokument, weil sie zu *diesem Lauf* gehört und
   * nicht zum Dokument: dasselbe Dokument kann später mit einem anderen Modell
   * neu erzeugt werden. Fehlt sie oder taugt sie nicht mehr, gilt die übliche
   * Auswahl (service/provider.ts).
   */
  [QUEUE.wikiGenerate]: {
    docId: string;
    wikiId: string;
    userId: string;
    providerId?: string;
  };
  [QUEUE.chatCluster]: {
    wikiId: string;
    sessionId: string;
    clusterId: string;
    spec: Record<string, unknown>;
    userId?: string;
  };
}

/**
 * Wie oft ein Job wiederholt wird und wie lange er laufen darf.
 *
 * Die Werte sind nicht geraten, sondern an den Zeiten der Aufrufe entlang
 * gewählt, die die Jobs machen:
 *
 * - `expireInSeconds` muss **über** dem längsten fremden Timeout liegen, den
 *   der Job abwartet. Beim Datei-Import ist das `PARSER_TIMEOUT_MS` (Vorgabe
 *   30 min, `router/document.ts`) — ein Job, der vor dem Parser abläuft, gilt
 *   als abgestürzt und wird ein zweites Mal gestartet, während der erste noch
 *   arbeitet. Deshalb 45 Minuten.
 * - `retryLimit` ist klein und `retryBackoff` an: die Fehler, die hier
 *   auftreten, sind fast nie flüchtig (kein Parser, kein Schlüssel, kein
 *   Guthaben). Fünfmal blind zu wiederholen kostet bei den LLM-Jobs echtes
 *   Geld, ohne die Aussicht zu verbessern.
 * - Nur die LLM-Jobs laufen einzeln (`localConcurrency: 1`). Zwei parallele
 *   Generierungsläufe auf demselben Wiki würden sich um dieselben Seiten
 *   streiten, und das Ratenlimit des Anbieters teilen sie sich ohnehin.
 */
export const QUEUE_OPTIONS: Record<
  QueueName,
  { retryLimit: number; expireInSeconds: number; localConcurrency: number }
> = {
  [QUEUE.fileImport]: { retryLimit: 2, expireInSeconds: 2700, localConcurrency: 2 },
  [QUEUE.urlImport]: { retryLimit: 3, expireInSeconds: 600, localConcurrency: 2 },
  [QUEUE.chunk]: { retryLimit: 2, expireInSeconds: 1800, localConcurrency: 2 },
  [QUEUE.embed]: { retryLimit: 3, expireInSeconds: 3600, localConcurrency: 1 },
  [QUEUE.wikiGenerate]: { retryLimit: 1, expireInSeconds: 3600, localConcurrency: 1 },
  [QUEUE.chatCluster]: { retryLimit: 1, expireInSeconds: 3600, localConcurrency: 1 },
};

/**
 * Wofür diese Instanz da ist.
 *
 * `api` stellt nur ein. `worker` arbeitet ab **und** führt die Wartung: Jobs
 * neu ausgeben, deren Bearbeiter nicht mehr antwortet, abgelaufene aufräumen,
 * erledigte nach `deleteAfterDays` löschen. Diese Wartung darf nicht in beiden
 * Prozessen laufen — pg-boss sichert sie zwar über Advisory Locks ab, aber ein
 * API-Prozess, der alle 60 Sekunden Wartungs-SQL auf `pg-shared` schickt, zahlt
 * dafür Verbindungen und Last, die er nicht braucht.
 */
export type BossRolle = "api" | "worker";

let boss: PgBoss | null = null;
let startPromise: Promise<PgBoss> | null = null;
let rolle: BossRolle = "api";

/**
 * Legt die Rolle fest. Muss **vor** dem ersten `getBoss()`/`enqueue()` kommen;
 * der Worker ruft es als erstes in `main()`.
 */
export function setzeRolle(r: BossRolle) {
  if (boss || startPromise) {
    throw new Error("Rolle nach dem Start von pg-boss nicht mehr änderbar");
  }
  rolle = r;
}

/**
 * Liefert die laufende pg-boss-Instanz und startet sie beim ersten Aufruf.
 *
 * `start()` legt beim ersten Lauf das Schema `pgboss` an. Die Rolle `prowiki`
 * besitzt ihre Datenbank und darf das; ein `CREATE EXTENSION` braucht pg-boss
 * nicht (es nutzt `gen_random_uuid()`, seit PG13 eingebaut) — anders als die
 * Erstmigration, die Superuser-Rechte verlangte (docs/LIVEGANG.md 2.3).
 *
 * Das gemerkte `startPromise` ist kein Schmuck: `enqueue` kann aus mehreren
 * gleichzeitigen Requests kommen, und zwei parallele `start()`-Läufe würden
 * beide versuchen, das Schema anzulegen.
 */
export function getBoss(): Promise<PgBoss> {
  if (boss) return Promise.resolve(boss);
  if (startPromise) return startPromise;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL fehlt – die Job-Warteschlange braucht sie");
  }

  const instance = new PgBoss({
    connectionString,
    // Siehe Verbindungsbudget oben.
    max: Number(process.env.JOBS_POOL_MAX ?? 2),
    schema: "pgboss",
    // Nur der Worker wartet die Warteschlange, siehe BossRolle.
    supervise: rolle === "worker",
    // Zeitpläne braucht prowiki nicht — die Cron-artigen Läufe (Backup,
    // Prüfung) liegen auf dem Host, nicht in der App.
    schedule: false,
  });

  // pg-boss wirft Verbindungsfehler als Event. Ohne Zuhörer beendet ein
  // einzelner Netzwerkfehler den ganzen Prozess mit einem unbehandelten
  // Fehler — auch den API-Prozess, der nur einstellen wollte.
  instance.on("error", (e) =>
    console.error("[jobs] pg-boss-Fehler:", e instanceof Error ? e.message : e),
  );

  startPromise = instance
    .start()
    .then(async () => {
      for (const name of Object.values(QUEUE)) {
        const o = QUEUE_OPTIONS[name];
        // Die Werte auch auf der Warteschlange setzen, nicht nur beim Senden.
        // Ein Job, der einmal ohne Optionen eingestellt wird — von Hand, aus
        // einem Skript, aus einer künftigen Stelle im Code —, bekäme sonst
        // pg-boss' Vorgaben: 15 Minuten Laufzeit und zwei Versuche. Für einen
        // Datei-Import mit 30-Minuten-Parser ist das genau der Fall, in dem
        // derselbe Job doppelt läuft.
        await instance.createQueue(name, {
          retryLimit: o.retryLimit,
          retryDelay: 30,
          retryBackoff: true,
          expireInSeconds: o.expireInSeconds,
          // Erledigte Jobs zwei Wochen halten (pg-boss' Vorgabe ist eine).
          // Sie sind die einzige Spur, aus der sich hinterher beantworten
          // lässt, warum ein Import nichts geliefert hat — dieselbe Frist wie
          // die Dump-Aufbewahrung (deploy/pg-shared).
          deleteAfterSeconds: 14 * 24 * 60 * 60,
        });
      }
      boss = instance;
      startPromise = null;
      console.log("[jobs] Warteschlange bereit");
      return instance;
    })
    .catch((e) => {
      startPromise = null;
      throw e;
    });

  return startPromise;
}

/** Einen Job einstellen. Liefert die Job-ID, mit der er im Log auffindbar ist. */
export async function enqueue<N extends QueueName>(
  name: N,
  data: JobPayloads[N],
  options?: SendOptions,
): Promise<string | null> {
  const b = await getBoss();
  const { retryLimit, expireInSeconds } = QUEUE_OPTIONS[name];
  const id = await b.send(name, data as object, {
    retryLimit,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds,
    ...options,
  });
  console.log(`[jobs] ${name} eingestellt: ${id}`);
  return id;
}

/**
 * Beim Herunterfahren: laufende Jobs zu Ende bringen, dann Verbindungen zu.
 *
 * `timeout` ist die Geduld für den anmutigen Teil. Sie muss **unter** der
 * `stop_grace_period` des Containers liegen, sonst kommt Dockers `SIGKILL`
 * zuerst und das anmutige Abschalten war Zierde.
 */
export async function stopBoss(): Promise<void> {
  const b = boss;
  boss = null;
  startPromise = null;
  if (!b) return;
  await b.stop({ graceful: true, close: true, timeout: 50_000 });
}

/**
 * Einstiegspunkt des Worker-Containers (`prowiki-worker`).
 *
 * Läuft als eigener Prozess neben der API. Er hört auf keinem Port und
 * beantwortet keine Requests — er holt Jobs aus der Warteschlange und arbeitet
 * sie ab. Kaputt gehen darf er: pg-boss gibt einen Job, dessen Bearbeiter nicht
 * mehr antwortet, nach `expireInSeconds` erneut aus.
 *
 * ## Warum ein eigener Container und nicht ein Thread in der API
 *
 * Weil ein Import Minuten bis Stunden dauert und die API in dieser Zeit
 * neu startbar bleiben soll. Solange beides in einem Prozess lief, war jedes
 * Deployment eine Wette darauf, dass gerade nichts läuft. Jetzt ist die
 * Reihenfolge im `deploy.sh` frei wählbar, und ein Job, der beim Herunterfahren
 * des Workers abbricht, wird vom nächsten Worker erneut geholt statt vergessen.
 *
 * ## Abschalten
 *
 * `SIGTERM` (was `docker compose down` und `restart` schicken) beendet nicht
 * sofort: `stopBoss` lässt laufende Jobs zu Ende arbeiten und holt keine neuen.
 * Dockers Geduld dafür ist standardmäßig **zehn Sekunden**, danach folgt
 * `SIGKILL` — für einen laufenden Import zu kurz. Deshalb steht im Compose
 * `stop_grace_period`. Wird der Prozess trotzdem hart beendet, ist nichts
 * verloren, nur Arbeit doppelt: der Job läuft nach Ablauf erneut.
 */
import type { PgBoss } from "pg-boss";
import {
  QUEUE,
  QUEUE_OPTIONS,
  getBoss,
  stopBoss,
  setzeRolle,
  type JobPayloads,
} from "./queue.ts";
import { spoolLesen, spoolLöschen, spoolAufräumen } from "./spool.ts";
import {
  verarbeiteDatei,
  chunkeDokument,
  betteWikiEin,
  generiereWikiArtikel,
  importiereUrl,
} from "../service/ingest.ts";
import * as chatWiki from "../service/wiki-from-chat.ts";

/**
 * Registriert einen Bearbeiter für eine Warteschlange.
 *
 * pg-boss übergibt seit v10 immer ein **Feld** von Jobs, auch wenn nur einer
 * geholt wird. Die Schleife hier ist deshalb kein Stapelbetrieb, sondern die
 * Anpassung an diese Signatur; ein Fehler in einem Job lässt den ganzen Stapel
 * scheitern, was bei Stapelgröße 1 genau das Gewünschte ist.
 */
async function arbeite<N extends keyof JobPayloads & string>(
  boss: PgBoss,
  name: N,
  bearbeiter: (data: JobPayloads[N], jobId: string) => Promise<void>,
) {
  const { localConcurrency } = QUEUE_OPTIONS[name as keyof typeof QUEUE_OPTIONS];
  await boss.work<JobPayloads[N]>(
    name,
    { batchSize: 1, localConcurrency },
    async (jobs) => {
      for (const job of jobs) {
        const t0 = Date.now();
        console.log(`[worker] ${name} ${job.id} beginnt`);
        try {
          await bearbeiter(job.data, job.id);
          console.log(`[worker] ${name} ${job.id} fertig (${Date.now() - t0} ms)`);
        } catch (e: any) {
          // Bewusst weiterwerfen: pg-boss zählt den Versuch, wartet
          // `retryDelay` und gibt den Job erneut aus. Wer hier abfängt, baut
          // sich das alte Verhalten zurück — Fehler still, Job verloren.
          console.error(
            `[worker] ${name} ${job.id} gescheitert (${Date.now() - t0} ms):`,
            e?.message ?? e,
          );
          throw e;
        }
      }
    },
  );
  console.log(`[worker] hört auf ${name} (${localConcurrency} parallel)`);
}

async function main() {
  /**
   * Beim Start prüfen, was sonst erst beim ersten Job auffällt.
   *
   * Am 21. August 2026 lief der Worker fehlerfrei an und scheiterte dann an
   * jedem einzelnen Job nach 0,0 s mit „AUTH_SECRET fehlt" — er braucht ihn, um
   * die verschlüsselten API-Schlüssel der LLM-Anbieter zu lesen
   * (service/crypto.ts), und im Compose stand er nicht, weil der Worker keine
   * Anmeldung macht. Ein Prozess, der bereit meldet und nichts kann, ist die
   * unangenehmste Sorte Fehler: die Warteschlange füllt sich, der Container ist
   * „Up", und schuld scheint der Anbieter zu sein.
   */
  if (!process.env.AUTH_SECRET) {
    console.error(
      "[worker] AUTH_SECRET fehlt. Er wird gebraucht, um die API-Schlüssel der\n" +
        "         LLM-Anbieter zu entschlüsseln (service/crypto.ts) — ohne ihn\n" +
        "         scheitert jeder Generierungs- und Embedding-Job. Abbruch statt\n" +
        "         eines Workers, der bereit meldet und nichts kann.",
    );
    process.exit(1);
  }

  // Vor dem ersten getBoss(): nur diese Instanz darf die Warteschlange warten.
  setzeRolle("worker");
  const boss = await getBoss();

  await arbeite(boss, QUEUE.fileImport, async (d) => {
    // Die Bytes liegen im geteilten Spool, nicht in der Nutzlast (jobs/spool.ts).
    const bytes = await spoolLesen(d.spoolPath);
    try {
      await verarbeiteDatei(
        d.docId,
        d.wikiId,
        d.userId,
        d.fileName,
        d.fileType,
        bytes,
        d.providerId,
      );
    } finally {
      // Auch im Fehlerfall löschen: ein gescheiterter Import wird neu
      // angestoßen, nicht fortgesetzt, und eine 500-MB-PDF soll nicht liegen
      // bleiben, bis die Platte voll ist.
      await spoolLöschen(d.spoolPath);
    }
  });

  await arbeite(boss, QUEUE.urlImport, (d) =>
    importiereUrl(d.docId, d.url, d.wikiId, d.userId, d.providerId),
  );

  await arbeite(boss, QUEUE.chunk, (d) =>
    chunkeDokument(d.docId, d.wikiId, d.timeline ?? [], d.replace ?? false),
  );

  await arbeite(boss, QUEUE.embed, async (d) => {
    await betteWikiEin(d.wikiId);
  });

  await arbeite(boss, QUEUE.wikiGenerate, async (d) => {
    await generiereWikiArtikel(d.docId, d.wikiId, d.userId, d.providerId);
  });

  await arbeite(boss, QUEUE.chatCluster, async (d) => {
    await chatWiki.generateClusterFromChat({
      wikiId: d.wikiId,
      sessionId: d.sessionId,
      clusterId: d.clusterId,
      spec: d.spec as any,
      userId: d.userId,
    });
  });

  // Reste aus abgebrochenen Läufen. Beim Start einmal, danach stündlich —
  // nicht beim Start allein, weil ein Worker, der Wochen läuft, sonst nie
  // aufräumt.
  await spoolAufräumen();
  const aufräumUhr = setInterval(
    () => void spoolAufräumen(),
    60 * 60 * 1000,
  );

  console.log("[worker] bereit");

  let beendend = false;
  const beenden = async (signal: string) => {
    if (beendend) return;
    beendend = true;
    console.log(`[worker] ${signal} – laufende Jobs zu Ende bringen`);
    clearInterval(aufräumUhr);
    try {
      await stopBoss();
    } catch (e: any) {
      console.error("[worker] Fehler beim Abschalten:", e?.message ?? e);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void beenden("SIGTERM"));
  process.on("SIGINT", () => void beenden("SIGINT"));
}

main().catch((e) => {
  console.error("[worker] Start fehlgeschlagen:", e);
  process.exit(1);
});

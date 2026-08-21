/**
 * Ablage für hochgeladene Dateien zwischen API und Worker.
 *
 * ## Warum es das gibt
 *
 * Alle anderen Jobs kommen mit einer kleinen Nutzlast aus, weil ihre Daten
 * schon in der Datenbank stehen. Der Datei-Upload ist die Ausnahme: die Bytes
 * existieren nur im Request. Das `File`-Objekt gilt ausschließlich im
 * Request-Kontext, und wer bis zum Worker warten will, muss es vorher irgendwo
 * hinlegen.
 *
 * Drei Wege wären möglich gewesen:
 *
 * 1. **Bytes in die Job-Nutzlast.** Verworfen: erlaubt sind 512 MB pro Upload
 *    (`frontend/nginx.conf`), und eine Warteschlangentabelle ist der falsche
 *    Ort für eine halbe Gigabyte-PDF — sie landet dann auch im nächtlichen
 *    Dump, jede Nacht neu.
 * 2. **Bytes in eine eigene Tabelle.** Dasselbe Problem, nur mit mehr Code.
 * 3. **Datei in ein geteiltes Verzeichnis**, Job trägt den Pfad. So gemacht.
 *
 * Das Verzeichnis ist im Betrieb ein Docker-Volume, das in `prowiki-app` und
 * `prowiki-worker` hängt. Es ist damit ausdrücklich **kein** dauerhafter
 * Speicher, sondern eine Durchgangsstation: der Worker löscht die Datei, wenn
 * er fertig ist — auch im Fehlerfall, denn der Text steht dann entweder in
 * `documents.content` oder der Import ist gescheitert und wird neu angestoßen,
 * nicht fortgesetzt.
 *
 * ## Was hier absichtlich nicht passiert
 *
 * Kein Aufräumen alter Dateien beim Start. Das klingt nach einer guten Idee und
 * ist eine schlechte: der Worker startet auch dann neu, wenn ein Job gerade
 * läuft und pg-boss ihn nach dem Ablauf erneut ausliefern wird. Ein Start, der
 * den Spool leerfegt, würde genau diesem Job die Datei unter den Füßen
 * wegziehen. Aufgeräumt wird nach Alter, siehe `spoolAufräumen`.
 */
import { mkdir, writeFile, readFile, unlink, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * Wo die Dateien liegen.
 *
 * Der Vorgabewert hängt an `NODE_ENV`, und das ist kein Geschmack: `/app/spool`
 * ist der Pfad **im Container**, wo das Volume hängt. Als einziger Vorgabewert
 * wäre er lokal ein Fehler — `mkdir /app/spool` scheitert auf einem Mac an den
 * Rechten, und zwar erst beim ersten Upload, nicht beim Start.
 */
const SPOOL_DIR =
  process.env.SPOOL_DIR ||
  (process.env.NODE_ENV === "production" ? "/app/spool" : "./.spool");

/** Wie lange eine Spool-Datei höchstens liegen bleibt, bevor sie als Rest gilt. */
const MAX_ALTER_MS = 24 * 60 * 60 * 1000;

/**
 * Legt die Bytes ab und liefert den Pfad für die Job-Nutzlast.
 *
 * Der Dateiname ist die Dokument-ID, nicht der hochgeladene Name. Der käme aus
 * dem Browser und dürfte alles enthalten, auch `../`; und die Dokument-ID ist
 * eine UUID, also eindeutig und ohne Sonderzeichen. Die Endung kommt aus dem
 * geprüften `fileType`, damit der Parser sie am Namen erkennt.
 */
export async function spoolSchreiben(
  docId: string,
  fileType: string,
  bytes: ArrayBuffer,
): Promise<string> {
  await mkdir(SPOOL_DIR, { recursive: true });
  const pfad = join(SPOOL_DIR, `${docId}.${fileType}`);
  await writeFile(pfad, new Uint8Array(bytes));
  return pfad;
}

/**
 * Liest eine Spool-Datei.
 *
 * Der Pfad kommt aus einer Job-Nutzlast. Die stammt aus der eigenen API und ist
 * insofern vertrauenswürdig — aber sie liegt in einer Tabelle, und Nutzlasten
 * aus einer Tabelle als Dateipfad zu übernehmen, ohne den Rahmen zu prüfen, ist
 * genau die Sorte Abkürzung, die später jemand ausnutzt. Deshalb die Prüfung
 * gegen das Spool-Verzeichnis.
 */
export async function spoolLesen(pfad: string): Promise<Buffer> {
  const wurzel = resolve(SPOOL_DIR);
  const ziel = resolve(pfad);
  if (ziel !== wurzel && !ziel.startsWith(wurzel + sep)) {
    throw new Error(`Spool-Pfad liegt außerhalb von ${wurzel}: ${pfad}`);
  }
  return readFile(ziel);
}

/** Entfernt eine Spool-Datei. Ein fehlender Pfad ist kein Fehler. */
export async function spoolLöschen(pfad: string): Promise<void> {
  try {
    await unlink(pfad);
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      console.warn(`[spool] ${pfad} nicht gelöscht:`, e.message);
    }
  }
}

/**
 * Entfernt Dateien, die älter als 24 Stunden sind.
 *
 * Sie entstehen, wenn ein Job endgültig scheitert oder der Worker mitten in der
 * Arbeit stirbt. Ohne dieses Aufräumen wächst das Volume still, bis die Platte
 * voll ist — und weil `pg-shared` auf derselben Platte liegt, träfe das dann
 * auch das Backup und fünf fremde Apps.
 */
export async function spoolAufräumen(): Promise<number> {
  let entfernt = 0;
  try {
    const namen = await readdir(SPOOL_DIR);
    const grenze = Date.now() - MAX_ALTER_MS;
    for (const name of namen) {
      const pfad = join(SPOOL_DIR, name);
      try {
        const s = await stat(pfad);
        if (s.mtimeMs < grenze) {
          await unlink(pfad);
          entfernt++;
        }
      } catch {
        // Wettlauf mit einem laufenden Job: der hat die Datei gerade gelöscht.
      }
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") console.warn("[spool] Aufräumen:", e.message);
  }
  if (entfernt > 0) console.log(`[spool] ${entfernt} Restdatei(en) entfernt`);
  return entfernt;
}

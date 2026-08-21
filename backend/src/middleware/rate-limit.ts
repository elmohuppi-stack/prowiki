/**
 * Ratenbegrenzung für die teuren Routen.
 *
 * ## Was das ist und was es nicht ist
 *
 * Better Auth begrenzt schon die Auth-Routen (`auth/index.ts`) — Anmelden,
 * Registrieren, Passwort vergessen. Das ist Schutz gegen Fremde. Hier geht es um
 * etwas anderes: **Schutz gegen den eigenen Klick.** Import, Chat und
 * Generierung kosten LLM- und Apify-Guthaben, und heute gibt es zwischen einem
 * versehentlichen Doppelklick und zwei bezahlten Läufen nichts.
 *
 * Solange nur zwei bekannte Konten existieren, ist das ausdrücklich kein
 * Sicherheitsmechanismus. Es wird einer, sobald ein Wiki `public` wird oder ein
 * Fremdkunde ein Konto hat — dann muss dieser Zähler in die Datenbank, siehe
 * unten.
 *
 * ## Warum der Zähler im Speicher liegt
 *
 * Weil es genau einen API-Container gibt (`docker-compose.yml`). Ein Zähler in
 * Postgres wäre pro Anfrage ein Schreibvorgang auf einer Instanz, die sich fünf
 * Apps teilen — für einen Nutzen, den es bei einem Prozess nicht gibt.
 *
 * **Die Grenze dieser Entscheidung, ausdrücklich:** ein Neustart setzt alle
 * Zähler zurück, und ein zweiter API-Container hätte einen eigenen Satz, womit
 * das Limit sich verdoppelt. Beides ist heute richtig und wird falsch, sobald
 * die API mehrfach läuft. Wer sie skaliert, muss diesen Zähler austauschen —
 * die Warteschlangentabelle von pg-boss liegt ohnehin schon in der Datenbank,
 * ein `rate_limits`-Table wäre der naheliegende Ort.
 *
 * ## Warum kein Zurückweisen, wenn kein Nutzer feststeht
 *
 * Anonyme Zugriffe treffen diese Routen heute nicht — sie verlangen alle
 * `wiki.write` und scheitern vorher an der Capability-Prüfung. Der Fallback auf
 * die IP ist deshalb Vorsorge für Stufe 2 (anonymer Chat mit Deckel) und nicht
 * der heutige Weg.
 */
import { createMiddleware } from "hono/factory";
import type { Principal } from "./access.ts";

interface Eimer {
  /** Zeitpunkte der Zugriffe im laufenden Fenster, aufsteigend. */
  zeiten: number[];
}

const eimer = new Map<string, Eimer>();

/**
 * Wann zuletzt aufgeräumt wurde.
 *
 * Ohne Aufräumen wächst die Map mit jedem je gesehenen Nutzer und wird zum
 * Speicherleck, das erst nach Monaten auffällt. Aufgeräumt wird beiläufig beim
 * Zugriff und nicht per `setInterval`: ein Timer hielte den Prozess wach und
 * wäre eine weitere Sache, die beim Abschalten aufzuräumen ist.
 */
let letztesAufräumen = Date.now();
const AUFRÄUM_ABSTAND_MS = 10 * 60 * 1000;

function aufräumen(jetzt: number) {
  if (jetzt - letztesAufräumen < AUFRÄUM_ABSTAND_MS) return;
  letztesAufräumen = jetzt;
  // Ein Fenster ist nie länger als eine Stunde; was älter ist, kann niemanden
  // mehr begrenzen.
  const grenze = jetzt - 60 * 60 * 1000;
  for (const [k, e] of eimer) {
    if (e.zeiten.length === 0 || e.zeiten[e.zeiten.length - 1] < grenze) {
      eimer.delete(k);
    }
  }
}

export interface LimitOptions {
  /** Name des Eimers. Routen mit demselben Namen teilen ihr Budget. */
  name: string;
  /** Wie viele Zugriffe im Fenster erlaubt sind. */
  max: number;
  /** Fensterlänge in Sekunden. */
  fensterSekunden: number;
}

/**
 * Gleitendes Fenster statt fester Zeitscheiben.
 *
 * Feste Scheiben („höchstens 10 pro Minute, Zähler springt zur Minute auf 0")
 * erlauben am Scheibenrand das Doppelte: zehn um 11:59:59 und zehn um 12:00:00.
 * Bei einem Limit, das Geld schützt, ist das genau der Fall, der zählt.
 */
export function rateLimit(o: LimitOptions) {
  return createMiddleware(async (c, next) => {
    const jetzt = Date.now();
    aufräumen(jetzt);

    const principal = c.get("principal") as Principal | undefined;
    const wer =
      principal?.userId ??
      // Nur hinter dem eigenen nginx belastbar, der X-Forwarded-For setzt
      // (frontend/nginx.conf). Als Angreiferschutz taugt es nicht — als
      // Unterscheidung zwischen zwei anonymen Besuchern genügt es.
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unbekannt";
    const schlüssel = `${o.name}:${wer}`;

    const fensterMs = o.fensterSekunden * 1000;
    const e = eimer.get(schlüssel) ?? { zeiten: [] };
    // Alles außerhalb des Fensters verwerfen.
    e.zeiten = e.zeiten.filter((t) => jetzt - t < fensterMs);

    if (e.zeiten.length >= o.max) {
      const ältester = e.zeiten[0];
      const wartenSek = Math.max(1, Math.ceil((fensterMs - (jetzt - ältester)) / 1000));
      eimer.set(schlüssel, e);
      c.header("Retry-After", String(wartenSek));
      return c.json(
        {
          error: `Zu viele Anfragen. ${o.max} pro ${o.fensterSekunden} s sind erlaubt – in ${wartenSek} s wieder möglich.`,
          retry_after: wartenSek,
        },
        429,
      );
    }

    e.zeiten.push(jetzt);
    eimer.set(schlüssel, e);
    await next();
  });
}

/**
 * Die Grenzen, an einer Stelle.
 *
 * Nicht geraten, sondern an den Kosten entlang gewählt — je teurer ein Aufruf,
 * desto enger:
 *
 * - **`ingest`** (Datei, URL, YouTube): 30 in 10 Minuten. Ein Mensch, der von
 *   Hand importiert, kommt nie in die Nähe; ein durchgedrehtes Skript oder ein
 *   hängender „Importieren"-Knopf schon. Der Kanal-Import aus Stufe 1 läuft
 *   nicht über diese Routen, sondern über die Warteschlange — er darf hier
 *   also nicht anstoßen.
 * - **`transcript`**: 10 pro Stunde. Der einzige Aufruf, der *direkt* Apify-
 *   Guthaben verbrennt, und der einzige, den man versehentlich wiederholt, weil
 *   er lange dauert und der Browser nichts anzeigt.
 * - **`chat`**: 60 pro Minute. Hoch genug, dass Tippen und Nachfragen nie
 *   anstößt, tief genug gegen eine Schleife.
 * - **`generate`**: 10 in 10 Minuten. Der teuerste Vorgang überhaupt — ein
 *   Verbund aus einem Gespräch kostet mehrere LLM-Läufe.
 */
export const LIMITS = {
  ingest: rateLimit({ name: "ingest", max: 30, fensterSekunden: 600 }),
  transcript: rateLimit({ name: "transcript", max: 10, fensterSekunden: 3600 }),
  chat: rateLimit({ name: "chat", max: 60, fensterSekunden: 60 }),
  generate: rateLimit({ name: "generate", max: 10, fensterSekunden: 600 }),
};

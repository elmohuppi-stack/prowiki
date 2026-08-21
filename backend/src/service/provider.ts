/**
 * Welcher LLM-Anbieter für einen Aufruf benutzt wird.
 *
 * ## Der Befund, den diese Datei behebt
 *
 * Bis zum 21. August 2026 gab es diese Auswahl **dreimal** — in `service/llm.ts`,
 * `router/chat.ts` und `service/embedding.ts` — und alle drei sahen so aus:
 *
 * ```ts
 * .where(and(eq(modelProviders.is_active, true), eq(modelProviders.provider_type, "chat")))
 * .limit(1)
 * ```
 *
 * Kein `organization_id`, kein `ORDER BY`. Das Schema trennt die Schlüssel der
 * Mandanten seit dem Livegang (`organization_id`, „bring your own key",
 * KONZEPT 5.4) und die **Schreibseite** hält das auch ein (`service/model.ts`
 * filtert überall) — aber die Leseseite nahm die erste Zeile, die Postgres
 * herausgab. Mit einer Organisation fällt das nicht auf. Mit zwei bedeutet es:
 *
 * - Die Inhalte von Organisation A gehen über den **Schlüssel von B**, also auf
 *   deren Rechnung.
 * - Und an einen **Anbieter, den A nie gewählt hat** — womit jede Aussage über
 *   das Empfängerland falsch wird, auch die auf der Datenschutzseite.
 *
 * Ohne `ORDER BY` war das Ergebnis nicht einmal gleichbleibend: Postgres darf
 * die Zeilen in beliebiger Reihenfolge liefern, und tut es je nach Planwahl
 * auch.
 *
 * ## Die Regel jetzt
 *
 * 1. Ein aktiver Provider **dieser Organisation** mit passendem Typ.
 * 2. Sonst einer dieser Organisation mit Typ `both`.
 * 3. Sonst ein **Plattform-Provider** (`organization_id IS NULL`) — aber nur,
 *    wenn `ALLOW_PLATFORM_PROVIDER=1` steht.
 * 4. Sonst `null`, und der Aufrufer macht nichts.
 *
 * Nie ein Provider einer **anderen** Organisation. Das ist keine Einstellung,
 * das ist die Regel.
 *
 * ## Warum Schritt 3 an einem Schalter hängt und standardmäßig aus ist
 *
 * Ein Plattform-Provider ist im Schema ausdrücklich vorgesehen („von uns
 * gestellt") und für ein Tarifmodell mit Kontingent auch nötig. Er ist aber
 * genau das, was bei einem Drittlandtransfer nicht still passieren darf: wer
 * seinen eigenen Anbieter einträgt, weil er nicht nach China senden will, und
 * dessen Schlüssel läuft ab, soll **keine Antwort** bekommen — und nicht
 * unbemerkt doch auf dem Plattformweg landen. Ein leerer Chat ist ein Fehler,
 * den man sieht; eine stille Umleitung ist einer, den man nicht sieht.
 * Siehe docs/DRITTLAND-DEEPSEEK.md.
 */
import { db } from "../db/index.ts";
import { modelProviders, wikis, member } from "../db/schema.ts";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { entschlüssele } from "./crypto.ts";

export type ProviderKind = "chat" | "embedding";

/** Wie ein Provider bei den Aufrufern ankommt: Schlüssel im Klartext. */
export interface AufgelösterProvider {
  id: string;
  name: string;
  api_base_url: string;
  /**
   * Der entschlüsselte Schlüssel.
   *
   * Heißt bewusst so und nicht `api_key_encrypted` wie die Spalte: was hier
   * drin steht, ist Klartext. Die Spalte hieß jahrelang „encrypted" und enthielt
   * Klartext — dieser Name soll die Verwirrung nicht fortsetzen.
   */
  api_key: string;
  default_model: string;
  /** Gehört er der Organisation selbst oder ist es der Plattform-Provider? */
  herkunft: "organisation" | "plattform";
}

const plattformErlaubt = () => process.env.ALLOW_PLATFORM_PROVIDER === "1";

/** Die Organisation eines Wiki. */
export async function organisationFürWiki(wikiId: string): Promise<string | null> {
  const [w] = await db
    .select({ organization_id: wikis.organization_id })
    .from(wikis)
    .where(eq(wikis.id, wikiId))
    .limit(1);
  return w?.organization_id ?? null;
}

/**
 * Die Organisation eines Nutzers — nur für Aufrufe ohne Wiki-Bezug, heute
 * ausschließlich ein Chat ohne gewähltes Wiki.
 *
 * Bei **mehreren** Mitgliedschaften wird `null` geliefert und nicht geraten.
 * Raten ist genau der Fehler, den diese Datei behebt; ein Nutzer in zwei
 * Organisationen darf nicht per Zufall den Schlüssel der einen für die andere
 * verbrauchen. Der Aufrufer muss dann die Organisation mitgeben — das Frontend
 * hält sie ohnehin in `activeOrgId` (docs/LIVEGANG.md 6).
 */
export async function organisationFürNutzer(userId: string): Promise<string | null> {
  const rows = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(2);
  if (rows.length !== 1) return null;
  return rows[0].organizationId;
}

export interface ProviderKontext {
  organizationId?: string | null;
  wikiId?: string | null;
  userId?: string | null;
}

/**
 * Löst den Provider für einen Aufruf auf. `null` heißt: nicht aufrufen.
 *
 * Der Grund für ein `null` steht immer im Log — ein Chat, der ohne Erklärung
 * nichts sagt, ist bei knora mehrfach als „das LLM ist kaputt" gemeldet worden,
 * obwohl nur kein Provider konfiguriert war.
 */
export async function holeProvider(
  kind: ProviderKind,
  kontext: ProviderKontext,
): Promise<AufgelösterProvider | null> {
  let orgId = kontext.organizationId ?? null;
  if (!orgId && kontext.wikiId) orgId = await organisationFürWiki(kontext.wikiId);
  if (!orgId && kontext.userId) orgId = await organisationFürNutzer(kontext.userId);

  if (!orgId) {
    console.warn(
      `[provider] ${kind}: keine Organisation bestimmbar (wiki=${kontext.wikiId ?? "–"}, user=${kontext.userId ?? "–"}) – kein Aufruf`,
    );
    return null;
  }

  // `both` ist gleichwertig, aber zweite Wahl: ein ausdrücklich für diesen Zweck
  // eingetragener Provider soll gewinnen. Deshalb wird nach `provider_type`
  // sortiert — "chat" < "embedding" wäre alphabetisch zufällig, also über einen
  // ausdrücklichen Rang.
  const rang = (t: string) => (t === kind ? 0 : 1);

  const eigene = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.organization_id, orgId),
        eq(modelProviders.is_active, true),
        inArray(modelProviders.provider_type, [kind, "both"]),
      ),
    )
    // Gleichbleibende Reihenfolge, damit zwei Aufrufe hintereinander nicht
    // verschiedene Anbieter treffen.
    .orderBy(asc(modelProviders.created_at), asc(modelProviders.id));

  const gewählt = [...eigene].sort(
    (a, b) => rang(a.provider_type) - rang(b.provider_type),
  )[0];

  if (gewählt) return aufbereiten(gewählt, "organisation");

  if (!plattformErlaubt()) {
    console.warn(
      `[provider] ${kind}: Organisation ${orgId} hat keinen aktiven Provider, ` +
        `und ALLOW_PLATFORM_PROVIDER ist aus – kein Aufruf. Das ist Absicht: ` +
        `eine stille Umleitung auf einen fremden Anbieter wäre schlimmer als keine Antwort.`,
    );
    return null;
  }

  const [plattform] = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        isNull(modelProviders.organization_id),
        eq(modelProviders.is_active, true),
        or(
          eq(modelProviders.provider_type, kind),
          eq(modelProviders.provider_type, "both"),
        ),
      ),
    )
    .orderBy(asc(modelProviders.created_at), asc(modelProviders.id))
    .limit(1);

  if (!plattform) {
    console.warn(`[provider] ${kind}: auch kein Plattform-Provider aktiv – kein Aufruf`);
    return null;
  }
  console.log(
    `[provider] ${kind}: Organisation ${orgId} nutzt den Plattform-Provider ${plattform.name}`,
  );
  return aufbereiten(plattform, "plattform");
}

function aufbereiten(
  row: typeof modelProviders.$inferSelect,
  herkunft: "organisation" | "plattform",
): AufgelösterProvider {
  return {
    id: row.id,
    name: row.name,
    api_base_url: row.api_base_url,
    api_key: entschlüssele(row.api_key_encrypted),
    default_model: row.default_model,
    herkunft,
  };
}

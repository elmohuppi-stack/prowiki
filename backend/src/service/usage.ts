/**
 * Kostenzählung: schreibt `usage_events` (schema/tenancy.ts).
 *
 * ## Warum das vor dem Kanal-Import kommt
 *
 * knora protokollierte nur `duration_ms`. Niemand konnte sagen, was ein Import
 * gekostet hat — nicht ungefähr, sondern überhaupt nicht. Solange ein Mensch
 * einzelne Videos einzeln importiert, merkt man den Mangel nicht. Der Prüfstein
 * von Stufe 1 ist aber „Basta Berlin komplett, in einem Vorgang": dreihundert
 * Videos, jedes mit Transkriptabruf, Embeddings und mehreren LLM-Läufen. Wer
 * den ohne Zählung startet, erfährt den Preis, wenn das Guthaben leer ist.
 *
 * ## Was hier gezählt wird und was nicht
 *
 * Gezählt werden **Tokens und Aufrufe**, weil die aus der Antwort des Anbieters
 * kommen und damit Tatsachen sind. Der **Preis** ist eine Schätzung: er steht in
 * einer Tabelle im Code, die veraltet, sobald ein Anbieter seine Liste ändert.
 * Deshalb sind beide Felder getrennt — `tokens_in`/`tokens_out` bleiben richtig,
 * auch wenn `cost_micros` es nicht mehr ist, und eine korrigierte Preisliste
 * lässt sich rückwirkend über die Tokens rechnen.
 *
 * ## Warum nichts hier je einen Fehler wirft
 *
 * Buchhaltung darf die Arbeit nicht anhalten. Ein Fehler beim Schreiben eines
 * Zählwerts ist ärgerlich; ein Import, der daran abbricht, ist schlimmer. Alle
 * Funktionen fangen deshalb selbst ab und melden in der Konsole.
 */
import { db } from "../db/index.ts";
import { usageEvents, wikis, member } from "../db/schema.ts";
import { eq } from "drizzle-orm";

/** Die Arten, in denen bei prowiki Kosten anfallen. */
export const USAGE = {
  /** Antwort im Chat. */
  llmChat: "llm_chat",
  /** Artikel-Generierung aus einem Dokument. */
  llmWikiGenerate: "llm_wiki_generate",
  /** Artikelverbund aus einem Gespräch. */
  llmFromChat: "llm_from_chat",
  /** Themenvorschläge und -klassifikation. */
  llmTopic: "llm_topic",
  /** Einbettung von Chunks. */
  embedding: "embedding",
  /** Transkriptabruf bei Apify/Supadata. */
  transcriptFetch: "transcript_fetch",
} as const;

export type UsageKind = (typeof USAGE)[keyof typeof USAGE];

/**
 * Preisstand, der in `usage_events.price_version` mitgeschrieben wird.
 *
 * Bei jeder Änderung an `PREISE` mit hochziehen. Ohne diesen Vermerk lässt sich
 * an einer alten Zeile nicht mehr erkennen, mit welchen Zahlen sie bewertet
 * wurde — und eine Summe über einen Zeitraum, in dem sich der Preis geändert
 * hat, wäre nicht mehr erklärbar.
 */
export const PREIS_VERSION = "2026-08-23b";

/**
 * Umrechnungskurs Dollar → Euro.
 *
 * Die Preistabelle steht in **Dollar**, weil die Anbieter so veröffentlichen.
 * Sie hier umgerechnet zu führen war der Fehler der ersten Fassung: bei jeder
 * Kursbewegung hätte jemand fünf Zahlen nachrechnen müssen, und ob eine Zahl
 * eine Preisänderung oder eine Kursänderung abbildete, war ihr nicht mehr
 * anzusehen. Jetzt ist es eine Stellschraube, die niemand anfassen muss, um die
 * Preise zu pflegen.
 */
const EUR_JE_USD = Number(process.env.EUR_PER_USD ?? 0.92);

interface Preis {
  /** Dollar je 1 Mio Eingabetokens **ohne** Treffer im Prompt-Cache. */
  in: number;
  /** Dollar je 1 Mio Eingabetokens **mit** Treffer im Prompt-Cache. */
  in_cached: number;
  /** Dollar je 1 Mio Ausgabetokens. */
  out: number;
  /**
   * DeepSeek rechnet außerhalb seiner Stoßzeiten den halben Preis ab. Bei
   * anderen Anbietern fehlt das Feld — ein Embedding kostet rund um die Uhr
   * dasselbe.
   */
  offPeakHalb?: boolean;
}

/**
 * Listenpreise in **Dollar** je eine Million Tokens.
 *
 * Stand 23. August 2026 (api-docs.deepseek.com/quick_start/pricing sowie die
 * Preisliste von OpenAI). Weiterhin ausdrücklich Schätzwerte — der Abgleich mit
 * der Rechnung des Anbieters bleibt Pflicht —, aber drei Dinge, die die erste
 * Fassung falsch machte, sind jetzt richtig:
 *
 * - **Die Modellnamen stimmen wieder.** Dort standen `deepseek-chat` und
 *   `deepseek-reasoner`; abgerechnet wird längst `deepseek-v4-flash` bzw.
 *   `-pro`. Steht in der Provider-Zeile der neue Name, fand `kostenMicros`
 *   keinen Preis und schrieb 0 — die Kostenspalte war dann durchgehend leer,
 *   ohne dass das jemandem auffiel. Die alten Namen bleiben als Alias stehen,
 *   DeepSeek führt sie weiter.
 * - **Cache-Treffer sind getrennt.** Sie kosten rund ein Dreißigstel. Der alte
 *   Kommentar sagte, ein Treffer sei aus der Antwort nicht ablesbar; das gilt
 *   nicht mehr, DeepSeek liefert `prompt_cache_hit_tokens`. Aus der Obergrenze
 *   wird damit eine belastbare Zahl — und zwar gerade dort, wo es zählt: bei
 *   der Wiki-Generierung geht dasselbe Transkript mehrfach an das Modell.
 * - **pro ist dreimal teurer als flash.** Vorher stand da Faktor zwei. Wer
 *   wegen der Artikelqualität wechselt, soll den Unterschied sehen.
 *
 * Ein unbekanntes Modell wird weiterhin mit 0 bewertet und einmal gemeldet:
 * lieber eine Lücke, die auffällt, als eine erfundene Zahl, die nicht auffällt.
 * `unbepreisteModelle()` macht die Lücke auch in der Oberfläche sichtbar.
 */
const PREISE: Record<string, Preis> = {
  // DeepSeek — Preise der Stoßzeit; außerhalb die Hälfte, siehe istStoßzeit().
  "deepseek-v4-flash": { in: 0.44, in_cached: 0.014, out: 1.32, offPeakHalb: true },
  "deepseek-v4-flash-vision-exp": {
    in: 0.44,
    in_cached: 0.014,
    out: 1.32,
    offPeakHalb: true,
  },
  "deepseek-v4-pro": { in: 1.32, in_cached: 0.044, out: 3.96, offPeakHalb: true },
  // Ältere Namen, die DeepSeek als Alias weiterführt.
  "deepseek-chat": { in: 0.44, in_cached: 0.014, out: 1.32, offPeakHalb: true },
  "deepseek-reasoner": { in: 1.32, in_cached: 0.044, out: 3.96, offPeakHalb: true },
  // OpenRouter reicht DeepSeek durch, rechnet aber nach EIGENER Liste ab —
  // deshalb ein eigener Eintrag und kein Alias auf den Namen ohne Präfix. Die
  // Modell-ID trägt das Anbieter-Präfix so, wie OpenRouter sie verlangt und wie
  // sie in usage_events.model landet.
  //
  // Preise von openrouter.ai/models (DeepSeek V4 Flash, Stand 23. August 2026).
  // Zwei Abweichungen zum Eintrag oben sind Absicht, keine Schlamperei:
  //  - Kein offPeakHalb: OpenRouter weist einen festen Preis aus, der
  //    Nachtrabatt der DeepSeek-API gilt hier nicht.
  //  - in_cached = in: OpenRouter nennt auf der Modellseite keinen Preis für
  //    Cache-Treffer. Lieber ohne Rabatt rechnen und damit eine Obergrenze
  //    ausweisen, als das Dreißigstel der DeepSeek-Liste zu unterstellen und
  //    die Kosten zu niedrig anzuzeigen.
  "deepseek/deepseek-v4-flash": { in: 0.04, in_cached: 0.04, out: 0.13 },
  // OpenAI-Embeddings — nur Eingabe, kein Cache, keine Stoßzeit.
  "text-embedding-3-small": { in: 0.02, in_cached: 0.02, out: 0 },
  "text-embedding-3-large": { in: 0.13, in_cached: 0.13, out: 0 },
  "text-embedding-ada-002": { in: 0.1, in_cached: 0.1, out: 0 },
};

/**
 * Stoßzeit bei DeepSeek: Mo–Fr 01:00–04:00 und 06:00–10:00 UTC. Sonst kostet
 * alles die Hälfte.
 *
 * Bewusst aus dem **Zeitpunkt des Aufrufs** bestimmt und nicht aus „jetzt":
 * eine nachträgliche Neuberechnung über `usage_events.created_at` soll
 * dieselben Zahlen ergeben wie die Zählung von damals.
 */
export function istStoßzeit(zeitpunkt: Date): boolean {
  const tag = zeitpunkt.getUTCDay();
  if (tag === 0 || tag === 6) return false;
  const minuten = zeitpunkt.getUTCHours() * 60 + zeitpunkt.getUTCMinutes();
  return (
    (minuten >= 1 * 60 && minuten < 4 * 60) ||
    (minuten >= 6 * 60 && minuten < 10 * 60)
  );
}

/**
 * Was ein Transkriptabruf kostet, in Millionstel Euro.
 *
 * Nicht in `PREISE`, weil hier nicht nach Tokens abgerechnet wird, sondern je
 * Video. Konfigurierbar, weil der Preis vom gewählten Actor abhängt und keine
 * Zahl im Code für alle stimmt: bei dreihundert Videos ist der Unterschied
 * zwischen 0,01 € und 0,05 € der Unterschied zwischen drei und fünfzehn Euro.
 *
 * Der Vorgabewert stand auf 40 000 (rund 0,04 €) und war eine Schätzung. Die
 * Abrechnung sagt etwas anderes. Gemessen am Apify-Posten
 * `PAID_ACTORS_PER_EVENT` (Abrechnungszyklus ab 2026-09-07, ausgelesen am
 * 2026-09-09): $0,028134 auf zwölf Actor-Läufe, von denen drei tatsächlich ein
 * Transkript lieferten. Das sind zwei Lesarten — rund $0,0023 je Aufruf oder
 * rund $0,0094 je erfolgreich transkribiertem Video. Gezählt wird hier je
 * Video, also gilt die zweite; genommen ist sie aufgerundet, damit der Posten
 * eher zu hoch als zu niedrig steht.
 *
 * Bewusst nicht überinterpretiert: die Messung umfasst zwei Tage und einen
 * Actor-Wechsel. Wer den Wert genau haben will, liest ihn nach einem
 * vollständigen Abrechnungszyklus aus
 * `GET /v2/users/me/usage/monthly` und teilt durch die Zahl der Videos.
 */
export const TRANSKRIPT_KOSTEN_MICROS = Number(
  process.env.TRANSCRIPT_COST_MICROS ?? 10_000,
);

const unbekannteModelle = new Set<string>();

/** Ob für ein Modell ein Preis hinterlegt ist. Für die Oberfläche. */
export function istBepreist(model: string | null | undefined): boolean {
  return !!model && model in PREISE;
}

/**
 * Kosten in Millionstel Euro. 0 bei unbekanntem Modell.
 *
 * `tokensCached` ist eine **Teilmenge** von `tokensIn`, nicht ein Zusatz — so
 * liefert DeepSeek es auch (`prompt_tokens` enthält die Cache-Treffer bereits).
 * Ein Aufrufer, der die beiden addierte, käme auf das Doppelte.
 */
export function kostenMicros(
  model: string | null | undefined,
  tokensIn: number,
  tokensOut: number,
  tokensCached = 0,
  zeitpunkt: Date = new Date(),
): number {
  if (!model) return 0;
  const p = PREISE[model];
  if (!p) {
    // Nur einmal je Modell meckern, sonst füllt es bei einem Massenlauf das Log.
    if (!unbekannteModelle.has(model)) {
      unbekannteModelle.add(model);
      console.warn(
        `[usage] Kein Preis für Modell "${model}" – Tokens werden gezählt, cost_micros bleibt 0`,
      );
    }
    return 0;
  }

  // Mehr Cache-Treffer als Eingabetokens kann es nicht geben. Ein Anbieter, der
  // das doch meldet, soll die Summe nicht ins Negative ziehen.
  const cached = Math.min(Math.max(0, tokensCached), Math.max(0, tokensIn));
  const frisch = Math.max(0, tokensIn) - cached;

  const faktor = p.offPeakHalb && !istStoßzeit(zeitpunkt) ? 0.5 : 1;
  const usdJeMio = frisch * p.in + cached * p.in_cached + tokensOut * p.out;

  // usdJeMio ist „Dollar mal Tokens je Million"; geteilt durch 1e6 sind es
  // Dollar, mal 1e6 wieder Millionstel — die beiden kürzen sich weg.
  return Math.round(usdJeMio * faktor * EUR_JE_USD);
}

/**
 * Die Organisation zu einem Wiki. Gemerkt, weil bei einem Lauf über dreihundert
 * Videos sonst dreihundertmal dieselbe Zeile gelesen würde — und weil ein Wiki
 * seinen Mandanten nicht wechselt.
 */
const orgJeWiki = new Map<string, string>();

async function organisationFürWiki(wikiId: string): Promise<string | null> {
  const gemerkt = orgJeWiki.get(wikiId);
  if (gemerkt) return gemerkt;
  const [w] = await db
    .select({ organization_id: wikis.organization_id })
    .from(wikis)
    .where(eq(wikis.id, wikiId))
    .limit(1);
  if (!w?.organization_id) return null;
  orgJeWiki.set(wikiId, w.organization_id);
  return w.organization_id;
}

/**
 * Die Organisation zu einem Nutzer — aber nur, wenn sie eindeutig ist.
 *
 * Notlösung für Posten ohne Wiki, und der einzige Fall, in dem es sie gibt:
 * ein Chat ohne ausgewähltes Wiki. Der ist trotzdem bezahlt und soll nicht aus
 * der Abrechnung fallen.
 *
 * Bei **mehreren** Mitgliedschaften wird bewusst nichts geliefert. Eine davon
 * zu greifen hieße, den Posten einem Mandanten zuzuschlagen, der ihn
 * vielleicht nicht verursacht hat — und eine falsche Zuordnung ist in einer
 * Abrechnung schlimmer als eine fehlende: die eine sieht man, die andere
 * bezahlt jemand.
 */
const orgJeNutzer = new Map<string, string | null>();

async function organisationFürNutzer(userId: string): Promise<string | null> {
  if (orgJeNutzer.has(userId)) return orgJeNutzer.get(userId)!;
  const zeilen = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(2);
  const eindeutig = zeilen.length === 1 ? zeilen[0].organizationId : null;
  orgJeNutzer.set(userId, eindeutig);
  return eindeutig;
}

export interface Zählwert {
  kind: UsageKind;
  /** Eines von beiden genügt; ohne Wiki muss die Organisation dabeistehen. */
  wikiId?: string | null;
  organizationId?: string | null;
  /**
   * Letzter Ausweg, wenn weder Wiki noch Organisation feststehen: der
   * Verursacher. Greift nur bei eindeutiger Mitgliedschaft, siehe
   * organisationFürNutzer.
   */
  userId?: string | null;
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  /** Teilmenge von `tokensIn`, die aus dem Prompt-Cache kam. */
  tokensCached?: number;
  /** Dokument-, Sitzungs- oder Verbund-ID — womit der Posten zusammenhängt. */
  refId?: string | null;
  /**
   * Kosten direkt setzen, statt sie aus Tokens zu rechnen.
   *
   * Für alles, was nicht nach Tokens abgerechnet wird: Apify und Supadata
   * kosten **je Video**, unabhängig von der Länge des Transkripts. Ohne dieses
   * Feld wären genau die teuersten Posten des Kanal-Imports mit 0 bewertet.
   */
  costMicros?: number;
}

/**
 * Schreibt einen Zählwert. Wirft nie.
 *
 * Ein Ereignis ohne Organisation wird verworfen statt geschrieben:
 * `usage_events.organization_id` ist `NOT NULL`, und ein erfundener Mandant
 * wäre schlimmer als ein fehlender Posten — er verfälschte jede Summe.
 */
export async function zähleNutzung(w: Zählwert): Promise<void> {
  try {
    let orgId = w.organizationId ?? null;
    if (!orgId && w.wikiId) orgId = await organisationFürWiki(w.wikiId);
    if (!orgId && w.userId) orgId = await organisationFürNutzer(w.userId);
    if (!orgId) {
      console.warn(
        `[usage] ${w.kind} ohne Organisation – nicht gezählt (wiki=${w.wikiId ?? "–"})`,
      );
      return;
    }

    const tokensIn = Math.max(0, Math.round(w.tokensIn ?? 0));
    const tokensOut = Math.max(0, Math.round(w.tokensOut ?? 0));
    const tokensCached = Math.min(
      Math.max(0, Math.round(w.tokensCached ?? 0)),
      tokensIn,
    );
    const jetzt = new Date();

    await db.insert(usageEvents).values({
      id: crypto.randomUUID(),
      organization_id: orgId,
      wiki_id: w.wikiId ?? null,
      kind: w.kind,
      model: w.model ?? null,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_cached: tokensCached,
      cost_micros:
        w.costMicros !== undefined
          ? Math.max(0, Math.round(w.costMicros))
          : kostenMicros(w.model, tokensIn, tokensOut, tokensCached, jetzt),
      price_version: PREIS_VERSION,
      ref_id: w.refId ?? null,
      created_at: jetzt,
    });
  } catch (e: any) {
    console.warn(`[usage] ${w.kind} nicht gezählt:`, e?.message ?? e);
  }
}

/**
 * Liest `usage` aus einer OpenAI-kompatiblen Antwort.
 *
 * Alle hier benutzten Anbieter sprechen dieses Format, aber keiner garantiert
 * das Feld: DeepSeek liefert es, manche Gateways lassen es weg. Fehlt es, wird
 * nichts geschätzt — ein aus der Zeichenzahl gerechneter Tokenwert sieht wie
 * eine Messung aus und ist keine.
 *
 * `tokensCached` kommt aus `prompt_cache_hit_tokens` (DeepSeek) bzw.
 * `prompt_tokens_details.cached_tokens` (OpenAI-Format). Beide zählen eine
 * **Teilmenge** von `prompt_tokens`, keine zusätzlichen Tokens. Fehlt das Feld,
 * bleibt es 0 — dann ist die Kostenschätzung wieder eine Obergrenze, also in
 * der Richtung falsch, in der Falschheit ungefährlich ist.
 */
export function tokensAus(
  antwort: any,
): { tokensIn: number; tokensOut: number; tokensCached: number } | null {
  const u = antwort?.usage;
  if (!u) return null;
  const tokensIn = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const tokensOut = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  if (!Number.isFinite(tokensIn) || !Number.isFinite(tokensOut)) return null;
  if (tokensIn === 0 && tokensOut === 0) return null;
  const roh = Number(
    u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
  );
  const tokensCached = Number.isFinite(roh) ? Math.max(0, roh) : 0;
  return { tokensIn, tokensOut, tokensCached };
}

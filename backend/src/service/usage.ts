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
import { usageEvents, wikis } from "../db/schema.ts";
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
 * Preise in Millionstel Euro je **eine Million** Tokens.
 *
 * Stand 21. August 2026, aus den Listenpreisen der Anbieter, gerundet und in
 * Euro umgerechnet. Sie sind ausdrücklich Schätzwerte:
 *
 * - Der Wechselkurs schwankt; die Anbieter rechnen in Dollar.
 * - DeepSeek berechnet Treffer im Prompt-Cache günstiger. Ob ein Treffer
 *   vorlag, sagt die Antwort nicht verlässlich, also wird hier immer der
 *   teurere Fall angesetzt. Die Zahl ist damit eine **Obergrenze**, was für
 *   eine Kostenkontrolle die richtige Richtung ist.
 * - Ein unbekanntes Modell wird mit 0 bewertet und in der Konsole gemeldet.
 *   Lieber eine Lücke, die auffällt, als eine erfundene Zahl, die nicht
 *   auffällt.
 *
 * Der Abgleich mit der echten Rechnung des Anbieters bleibt Pflicht — diese
 * Tabelle ersetzt ihn nicht, sie macht nur die Größenordnung während eines
 * Laufs sichtbar.
 */
const PREISE: Record<string, { in: number; out: number }> = {
  // DeepSeek (Chat und Generierung)
  "deepseek-chat": { in: 250_000, out: 1_000_000 },
  "deepseek-reasoner": { in: 500_000, out: 2_000_000 },
  // OpenAI-Embeddings
  "text-embedding-3-small": { in: 19_000, out: 0 },
  "text-embedding-3-large": { in: 122_000, out: 0 },
  "text-embedding-ada-002": { in: 95_000, out: 0 },
};

/**
 * Was ein Transkriptabruf kostet, in Millionstel Euro.
 *
 * Nicht in `PREISE`, weil hier nicht nach Tokens abgerechnet wird, sondern je
 * Video. Der Vorgabewert entspricht rund 0,04 € — die Größenordnung der
 * Apify-Actors für YouTube-Transkripte. Konfigurierbar, weil der Preis vom
 * gewählten Actor abhängt und keine Zahl im Code für alle stimmt:
 * bei dreihundert Videos ist der Unterschied zwischen 0,01 € und 0,05 € der
 * Unterschied zwischen drei und fünfzehn Euro.
 */
export const TRANSKRIPT_KOSTEN_MICROS = Number(
  process.env.TRANSCRIPT_COST_MICROS ?? 40_000,
);

const unbekannteModelle = new Set<string>();

/** Kosten in Millionstel Euro. 0 bei unbekanntem Modell. */
export function kostenMicros(
  model: string | null | undefined,
  tokensIn: number,
  tokensOut: number,
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
  return Math.round((tokensIn * p.in + tokensOut * p.out) / 1_000_000);
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

export interface Zählwert {
  kind: UsageKind;
  /** Eines von beiden genügt; ohne Wiki muss die Organisation dabeistehen. */
  wikiId?: string | null;
  organizationId?: string | null;
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
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
    if (!orgId) {
      console.warn(
        `[usage] ${w.kind} ohne Organisation – nicht gezählt (wiki=${w.wikiId ?? "–"})`,
      );
      return;
    }

    const tokensIn = Math.max(0, Math.round(w.tokensIn ?? 0));
    const tokensOut = Math.max(0, Math.round(w.tokensOut ?? 0));

    await db.insert(usageEvents).values({
      id: crypto.randomUUID(),
      organization_id: orgId,
      wiki_id: w.wikiId ?? null,
      kind: w.kind,
      model: w.model ?? null,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_micros:
        w.costMicros !== undefined
          ? Math.max(0, Math.round(w.costMicros))
          : kostenMicros(w.model, tokensIn, tokensOut),
      ref_id: w.refId ?? null,
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
 */
export function tokensAus(antwort: any): { tokensIn: number; tokensOut: number } | null {
  const u = antwort?.usage;
  if (!u) return null;
  const tokensIn = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  const tokensOut = Number(u.completion_tokens ?? u.output_tokens ?? 0);
  if (!Number.isFinite(tokensIn) || !Number.isFinite(tokensOut)) return null;
  if (tokensIn === 0 && tokensOut === 0) return null;
  return { tokensIn, tokensOut };
}

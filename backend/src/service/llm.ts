// Gemeinsame LLM-Helfer (OpenAI-kompatibel, reiner fetch).
// Genutzt von wiki-generate.ts (Artikel-Generierung) und topic.ts
// (Themen-Vorschläge/Klassifikation). Als eigenes Modul, um Zirkelbezüge
// zwischen Generator und Topic-Service zu vermeiden.
import {
  holeProvider,
  type AufgelösterProvider,
  type ProviderKontext,
} from "./provider.ts";
import { zähleNutzung, tokensAus, type UsageKind } from "./usage.ts";

/**
 * Wem ein Aufruf zugerechnet wird.
 *
 * Optional, damit die vorhandenen Aufrufer weiter greifen — aber ohne ihn kann
 * kein Posten geschrieben werden, und der Aufruf ist in der Abrechnung
 * unsichtbar. Neue Aufrufstellen sollten ihn deshalb immer mitgeben.
 */
export interface LLMKontext {
  kind: UsageKind;
  wikiId?: string | null;
  organizationId?: string | null;
  /** Dokument, Sitzung oder Verbund, um den es geht. */
  refId?: string | null;
}

/**
 * Aktiven Chat-Provider ermitteln.
 *
 * Nur noch eine Weiterleitung an `service/provider.ts`. Vorher stand hier eine
 * eigene Abfrage ohne `organization_id` — mit zwei Mandanten hätte sie den
 * Schlüssel des einen für den anderen benutzt. Die Begründung steht dort.
 *
 * Der `kontext` ist Pflicht: ohne ihn ist nicht entscheidbar, wessen Provider
 * gemeint ist, und ein Vorgabewert wäre genau das Raten, das behoben wurde.
 */
export async function getActiveProvider(kontext: ProviderKontext) {
  return holeProvider("chat", kontext);
}

/**
 * Wie oft ein LLM-Aufruf bei vorübergehenden Fehlern wiederholt wird.
 *
 * Ohne Wiederholung fällt jede Störung des Anbieters lautlos als fehlender
 * Artikel durch: bei einem Lauf über 180 Protokolle riss der Provider für rund
 * 20 Minuten ab, 21 aufeinanderfolgende Sitzungen bekamen keinen Artikel – und
 * weil callLLM nur `null` lieferte, meldete der Lauf trotzdem Erfolg.
 */
const LLM_MAX_ATTEMPTS = parseInt(process.env.LLM_MAX_ATTEMPTS || "4");

/** Vorübergehend: Rate-Limit, Server-Fehler, Zeitüberschreitung. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callLLM(
  provider: AufgelösterProvider,
  prompt: string,
  kontext?: LLMKontext,
): Promise<string | null> {
  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
    const last = attempt === LLM_MAX_ATTEMPTS;
    try {
      const response = await fetch(`${provider.api_base_url}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.api_key}`,
        },
        body: JSON.stringify({
          model: provider.default_model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 8192,
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) {
        const err = await response.text().catch(() => "");
        // 4xx außer 408/429 sind Anfragefehler – eine Wiederholung ändert nichts.
        if (!isRetryable(response.status) || last) {
          console.warn(
            `[llm] error ${response.status} (Versuch ${attempt}/${LLM_MAX_ATTEMPTS}, kein weiterer): ${err.slice(0, 200)}`,
          );
          return null;
        }
        const waitMs = response.status === 429 ? 20000 : 3000 * attempt;
        console.warn(
          `[llm] error ${response.status}, warte ${waitMs / 1000}s (Versuch ${attempt}/${LLM_MAX_ATTEMPTS})`,
        );
        await sleep(waitMs);
        continue;
      }

      const data = await response.json();

      // Zählen, sobald die Antwort da ist — vor der Prüfung auf leeren Inhalt.
      // Eine leere Antwort ist trotzdem bezahlt, und ein Wiederholungsversuch
      // kostet ein zweites Mal: genau diese Fälle sollen in der Summe stehen,
      // sonst ist die Zählung immer zu niedrig, wenn es Probleme gab.
      if (kontext) {
        const t = tokensAus(data);
        if (t) {
          await zähleNutzung({
            kind: kontext.kind,
            wikiId: kontext.wikiId,
            organizationId: kontext.organizationId,
            model: provider?.default_model ?? null,
            tokensIn: t.tokensIn,
            tokensOut: t.tokensOut,
            refId: kontext.refId,
          });
        }
      }

      const content = data?.choices?.[0]?.message?.content || null;
      // Leere Antwort bei HTTP 200 kommt vor (abgeschnittener Stream) und ist
      // ebenfalls ein Wiederholungsgrund.
      if (!content && !last) {
        console.warn(
          `[llm] leere Antwort, wiederhole (Versuch ${attempt}/${LLM_MAX_ATTEMPTS})`,
        );
        await sleep(3000 * attempt);
        continue;
      }
      return content;
    } catch (e: any) {
      if (last) {
        console.warn(
          `[llm] call failed (Versuch ${attempt}/${LLM_MAX_ATTEMPTS}, kein weiterer): ${e.message}`,
        );
        return null;
      }
      console.warn(
        `[llm] call failed: ${e.message} – warte ${3 * attempt}s (Versuch ${attempt}/${LLM_MAX_ATTEMPTS})`,
      );
      await sleep(3000 * attempt);
    }
  }
  return null;
}

export async function callLLMJson<T>(
  provider: AufgelösterProvider,
  prompt: string,
  kontext?: LLMKontext,
): Promise<T | null> {
  const raw = await callLLM(provider, prompt, kontext);
  if (!raw) return null;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]) as T;
    return JSON.parse(raw) as T;
  } catch (e: any) {
    console.warn(`[llm] JSON parse failed: ${e.message}`);
    return null;
  }
}

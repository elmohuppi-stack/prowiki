// Gemeinsame LLM-Helfer (OpenAI-kompatibel, reiner fetch).
// Genutzt von wiki-generate.ts (Artikel-Generierung) und topic.ts
// (Themen-Vorschläge/Klassifikation). Als eigenes Modul, um Zirkelbezüge
// zwischen Generator und Topic-Service zu vermeiden.
import { db } from "../db/index.ts";
import { modelProviders } from "../db/schema.ts";
import { and, eq } from "drizzle-orm";

/** Aktiven Chat-Provider ermitteln (chat, sonst both). */
export async function getActiveProvider() {
  let providers = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.is_active, true),
        eq(modelProviders.provider_type, "chat"),
      ),
    )
    .limit(1);

  if (!providers[0]) {
    providers = await db
      .select()
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.is_active, true),
          eq(modelProviders.provider_type, "both"),
        ),
      )
      .limit(1);
  }
  return providers[0] || null;
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
  provider: any,
  prompt: string,
): Promise<string | null> {
  for (let attempt = 1; attempt <= LLM_MAX_ATTEMPTS; attempt++) {
    const last = attempt === LLM_MAX_ATTEMPTS;
    try {
      const response = await fetch(`${provider.api_base_url}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.api_key_encrypted}`,
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
  provider: any,
  prompt: string,
): Promise<T | null> {
  const raw = await callLLM(provider, prompt);
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

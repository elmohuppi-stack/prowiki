/**
 * Modell-Provider je Organisation.
 *
 * Jede Funktion nimmt die `organizationId` und filtert danach — auch die, bei
 * denen der Aufrufer die Rechte bereits geprüft hat. Der Grund: die
 * Capability-Prüfung sagt nur „darf in *dieser* Organisation Einstellungen
 * verwalten", nicht „darf *diesen* Provider anfassen". Ohne den Filter würde
 * eine erratene Provider-ID genügen, um an fremden Mandantendaten zu drehen.
 */
import { db } from "../db/index.ts";
import { modelProviders } from "../db/schema.ts";
import { and, eq, desc } from "drizzle-orm";
import { verschlüssele, entschlüssele } from "./crypto.ts";

function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "…" + key.slice(-4);
}

/**
 * Nie den Schlüssel selbst herausgeben, nur eine Wiedererkennungshilfe.
 *
 * Die Vorschau wird aus dem **entschlüsselten** Wert gebildet. Aus dem
 * Geheimtext gebildet wäre sie wertlos: „enc:…Xy4=" hilft niemandem, seinen
 * Schlüssel wiederzuerkennen, und genau dazu ist sie da. Herausgegeben werden
 * dabei acht Zeichen — bei einem Schlüssel mit über vierzig ist das keine
 * Preisgabe, sondern der Zweck.
 */
function present<T extends { api_key_encrypted: string }>(provider: T) {
  const { api_key_encrypted, ...rest } = provider;
  let klar = api_key_encrypted;
  try {
    klar = entschlüssele(api_key_encrypted);
  } catch {
    // Ein Wert, der sich nicht entschlüsseln lässt (falscher AUTH_SECRET,
    // beschädigte Zeile), darf die Liste nicht unbenutzbar machen — sonst kommt
    // man in der Oberfläche nicht mehr an den Provider, um ihn zu ersetzen.
    return { ...rest, api_key_preview: "!! nicht entschlüsselbar" };
  }
  return { ...rest, api_key_preview: maskKey(klar) };
}

export async function listProviders(organizationId: string) {
  const rows = await db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.organization_id, organizationId))
    .orderBy(desc(modelProviders.created_at));
  return rows.map(present);
}

export async function createProvider(
  organizationId: string,
  data: {
    name: string;
    provider_type: string;
    api_base_url: string;
    api_key: string;
    default_model: string;
    is_active?: boolean;
  },
) {
  const [provider] = await db
    .insert(modelProviders)
    .values({
      id: crypto.randomUUID(),
      organization_id: organizationId,
      name: data.name,
      provider_type: data.provider_type,
      api_base_url: data.api_base_url,
      // Verschlüsselt ablegen. Die Spalte hieß von Anfang an
      // `api_key_encrypted` und enthielt bis zum 21. August 2026 Klartext —
      // siehe service/crypto.ts.
      api_key_encrypted: verschlüssele(data.api_key),
      default_model: data.default_model,
      is_active: data.is_active ?? true,
    })
    .returning();
  return present(provider);
}

export async function updateProvider(
  organizationId: string,
  id: string,
  data: {
    name?: string;
    provider_type?: string;
    api_base_url?: string;
    api_key?: string;
    default_model?: string;
    is_active?: boolean;
  },
) {
  const updateData: Record<string, unknown> = { updated_at: new Date() };
  if (data.name) updateData.name = data.name;
  if (data.provider_type) updateData.provider_type = data.provider_type;
  if (data.api_base_url) updateData.api_base_url = data.api_base_url;
  if (data.api_key) updateData.api_key_encrypted = verschlüssele(data.api_key);
  if (data.default_model) updateData.default_model = data.default_model;
  if (data.is_active !== undefined) updateData.is_active = data.is_active;

  const [provider] = await db
    .update(modelProviders)
    .set(updateData)
    .where(
      and(
        eq(modelProviders.id, id),
        eq(modelProviders.organization_id, organizationId),
      ),
    )
    .returning();
  if (!provider) return null;
  return present(provider);
}

/** Gibt zurück, ob tatsächlich etwas gelöscht wurde. */
export async function deleteProvider(organizationId: string, id: string) {
  const deleted = await db
    .delete(modelProviders)
    .where(
      and(
        eq(modelProviders.id, id),
        eq(modelProviders.organization_id, organizationId),
      ),
    )
    .returning({ id: modelProviders.id });
  return deleted.length > 0;
}

/**
 * Einen Anbieter tatsächlich anrufen — der „Testen"-Knopf im Dialog.
 *
 * Warum das nötig ist: bis hierher konnte man eine Zeile speichern, die
 * syntaktisch tadellos und trotzdem unbrauchbar war, und es fiel erst Stunden
 * später auf — als Import ohne Wiki-Artikel und einer Zeile im Worker-Log, die
 * niemand liest. Der häufigste Fehler dabei ist nicht der Schlüssel, sondern
 * die Basis-URL: die Aufrufer hängen `/chat/completions` bzw. `/embeddings`
 * direkt an, `https://openrouter.ai` ergibt damit einen 404, richtig ist
 * `https://openrouter.ai/api/v1`. Genau diesen Unterschied zeigt der Test in
 * einer Sekunde.
 *
 * Der Test ruft **denselben Pfad** wie der Echtbetrieb auf und baut ihn nicht
 * nach; ein Test, der einen anderen Endpunkt prüft als der spätere Aufruf
 * benutzt, ist schlimmer als keiner.
 *
 * Der Schlüssel kommt entweder aus dem Dialog (neu eingetippt) oder — wenn das
 * Feld leer blieb — aus der gespeicherten Zeile. Herausgegeben wird er nie,
 * auch nicht in der Fehlermeldung: die Antwort des Anbieters wird auf 300
 * Zeichen gekürzt und der Schlüssel darin ersetzt, falls er doch auftaucht.
 */
export async function testProvider(
  organizationId: string,
  data: {
    provider_type: string;
    api_base_url: string;
    default_model: string;
    /** Leer lassen und `id` mitgeben, um den gespeicherten Schlüssel zu nehmen. */
    api_key?: string;
    id?: string;
  },
): Promise<{
  ok: boolean;
  status?: number;
  dauer_ms: number;
  modell?: string | null;
  antwort?: string | null;
  fehler?: string;
}> {
  const t0 = Date.now();

  let key = data.api_key?.trim() || "";
  if (!key && data.id) {
    const [row] = await db
      .select({ k: modelProviders.api_key_encrypted })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.id, data.id),
          eq(modelProviders.organization_id, organizationId),
        ),
      )
      .limit(1);
    if (!row) {
      return { ok: false, dauer_ms: 0, fehler: "Anbieter nicht gefunden" };
    }
    try {
      key = entschlüssele(row.k);
    } catch {
      return {
        ok: false,
        dauer_ms: 0,
        fehler:
          "Der gespeicherte Schlüssel lässt sich nicht entschlüsseln. Bitte neu eintragen.",
      };
    }
  }
  if (!key) {
    return { ok: false, dauer_ms: 0, fehler: "Kein Schlüssel angegeben" };
  }

  const basis = data.api_base_url.trim().replace(/\/+$/, "");
  const istEmbedding = data.provider_type === "embedding";
  const url = `${basis}${istEmbedding ? "/embeddings" : "/chat/completions"}`;

  // Kürzestmögliche echte Anfrage: sie kostet Bruchteile eines Cents und
  // beantwortet trotzdem alle drei Fragen (URL erreichbar, Schlüssel gültig,
  // Modellname bekannt).
  const body = istEmbedding
    ? { model: data.default_model, input: "prowiki test" }
    : {
        model: data.default_model,
        messages: [{ role: "user", content: "Antworte nur mit: ok" }],
        max_tokens: 5,
      };

  const entschärfen = (s: string) =>
    s.split(key).join("«Schlüssel»").slice(0, 300);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      // Kurz: der Knopf soll nicht zwei Minuten stehen bleiben. Der
      // Echtbetrieb darf länger warten (service/llm.ts), ein Test nicht.
      signal: AbortSignal.timeout(30000),
    });

    const text = await resp.text();
    const dauer_ms = Date.now() - t0;

    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        dauer_ms,
        fehler: deuteFehler(resp.status, url) + ` — ${entschärfen(text)}`,
      };
    }

    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: resp.status,
        dauer_ms,
        fehler: `Antwort ist kein JSON — ${entschärfen(text)}`,
      };
    }

    if (istEmbedding) {
      const vektor = json?.data?.[0]?.embedding;
      if (!Array.isArray(vektor)) {
        return {
          ok: false,
          status: resp.status,
          dauer_ms,
          fehler: `Kein Vektor in der Antwort — ${entschärfen(text)}`,
        };
      }
      return {
        ok: true,
        status: resp.status,
        dauer_ms,
        modell: json?.model ?? data.default_model,
        antwort: `${vektor.length} Dimensionen`,
      };
    }

    const inhalt = json?.choices?.[0]?.message?.content;
    if (typeof inhalt !== "string") {
      return {
        ok: false,
        status: resp.status,
        dauer_ms,
        fehler: `Keine Chat-Antwort in der Rückgabe — ${entschärfen(text)}`,
      };
    }
    return {
      ok: true,
      status: resp.status,
      dauer_ms,
      modell: json?.model ?? data.default_model,
      antwort: inhalt.trim().slice(0, 120) || "(leer)",
    };
  } catch (e: any) {
    return {
      ok: false,
      dauer_ms: Date.now() - t0,
      fehler:
        e?.name === "TimeoutError"
          ? "Zeitüberschreitung nach 30 s — Basis-URL erreichbar?"
          : `Aufruf fehlgeschlagen: ${entschärfen(String(e?.message ?? e))}`,
    };
  }
}

/**
 * Aus dem HTTP-Status einen Satz machen, mit dem man etwas anfangen kann.
 *
 * Der 404 bekommt dabei den ausführlichsten Hinweis, weil er hier fast immer
 * dasselbe bedeutet: in der Basis-URL fehlt der Versionspfad.
 */
function deuteFehler(status: number, url: string): string {
  if (status === 401 || status === 403) {
    return "Schlüssel abgelehnt (HTTP " + status + ")";
  }
  if (status === 404) {
    return (
      `HTTP 404 für ${url} — vermutlich fehlt der Versionspfad in der ` +
      `Basis-URL. Sie muss den Teil vor /chat/completions enthalten, ` +
      `also z. B. https://openrouter.ai/api/v1 statt https://openrouter.ai`
    );
  }
  if (status === 400) return "HTTP 400 — Modellname unbekannt?";
  if (status === 429) return "HTTP 429 — Ratenlimit oder Guthaben erschöpft";
  return `HTTP ${status}`;
}

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

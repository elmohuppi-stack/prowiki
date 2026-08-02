import { db } from "../db/index.ts";
import { modelProviders } from "../db/schema.ts";
import { eq, desc } from "drizzle-orm";
import { createHash } from "crypto";

function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "…" + key.slice(-4);
}

export async function listProviders() {
  const rows = await db
    .select()
    .from(modelProviders)
    .orderBy(desc(modelProviders.created_at));
  return rows.map((p) => ({
    ...p,
    api_key_preview: maskKey(p.api_key_encrypted),
    api_key_encrypted: undefined,
  }));
}

export async function createProvider(data: {
  name: string;
  provider_type: string;
  api_base_url: string;
  api_key: string;
  default_model: string;
  is_active?: boolean;
}) {
  const [provider] = await db
    .insert(modelProviders)
    .values({
      id: crypto.randomUUID(),
      name: data.name,
      provider_type: data.provider_type,
      api_base_url: data.api_base_url,
      api_key_encrypted: data.api_key,
      default_model: data.default_model,
      is_active: data.is_active ?? true,
    })
    .returning();
  return {
    ...provider,
    api_key_preview: maskKey(provider.api_key_encrypted),
    api_key_encrypted: undefined,
  };
}

export async function updateProvider(
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
  const updateData: Record<string, any> = { updated_at: new Date() };
  if (data.name) updateData.name = data.name;
  if (data.provider_type) updateData.provider_type = data.provider_type;
  if (data.api_base_url) updateData.api_base_url = data.api_base_url;
  if (data.api_key) updateData.api_key_encrypted = data.api_key;
  if (data.default_model) updateData.default_model = data.default_model;
  if (data.is_active !== undefined) updateData.is_active = data.is_active;

  const [provider] = await db
    .update(modelProviders)
    .set(updateData)
    .where(eq(modelProviders.id, id))
    .returning();
  if (!provider) return null;
  return {
    ...provider,
    api_key_preview: maskKey(provider.api_key_encrypted),
    api_key_encrypted: undefined,
  };
}

export async function deleteProvider(id: string) {
  await db.delete(modelProviders).where(eq(modelProviders.id, id));
}

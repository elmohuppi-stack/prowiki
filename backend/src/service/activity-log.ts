// Aktivitätslog – Zeichnet alle wichtigen Aktionen auf (YouTube-Import,
// Wiki-Generierung, Dokument-Upload etc.) für Transparenz & Debugging.
//
// Die Logs sind im Admin-Panel unter "Aktivitäten" einsehbar.

import { db } from "../db/index.ts";
import { activityLogs } from "../db/schema.ts";
import { eq, desc, and, like, sql } from "drizzle-orm";

export interface LogEntry {
  action: string;
  status?: "started" | "completed" | "failed";
  message?: string;
  details?: Record<string, unknown>;
  workspace_id?: string;
  document_id?: string;
  user_id?: number;
}

/**
 * Erzeugt einen Aktivitätslog-Eintrag.
 * Gibt die ID zurück, damit später duration_ms aktualisiert werden kann.
 */
export async function logActivity(entry: LogEntry): Promise<string> {
  const id = crypto.randomUUID();
  try {
    await db.insert(activityLogs).values({
      id,
      action: entry.action,
      status: entry.status || "started",
      message: entry.message || "",
      details: (entry.details as Record<string, unknown>) || {},
      workspace_id: entry.workspace_id || null,
      document_id: entry.document_id || null,
      user_id: entry.user_id || null,
      created_at: new Date(),
    });
  } catch (e: any) {
    console.error(`[activity-log] Fehler beim Schreiben:`, e.message);
  }
  return id;
}

/**
 * Aktualisiert einen bestehenden Log-Eintrag (z.B. um duration_ms zu setzen).
 */
export async function updateLog(
  id: string,
  updates: {
    status?: "started" | "completed" | "failed";
    message?: string;
    details?: Record<string, unknown>;
    duration_ms?: number;
  },
): Promise<void> {
  try {
    const updateData: Record<string, any> = {};
    if (updates.status) updateData.status = updates.status;
    if (updates.message !== undefined) updateData.message = updates.message;
    if (updates.details) updateData.details = updates.details;
    if (updates.duration_ms !== undefined)
      updateData.duration_ms = updates.duration_ms;

    await db
      .update(activityLogs)
      .set(updateData)
      .where(eq(activityLogs.id, id));
  } catch (e: any) {
    console.error(`[activity-log] Fehler beim Update:`, e.message);
  }
}

/**
 * Status der (jüngsten) Chat-Verbund-Generierung eines Clusters.
 * Liefert "started" | "completed" | "failed" oder null (kein Log gefunden).
 */
export async function getChatWikiStatus(
  clusterId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ status: activityLogs.status })
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.action, "chat_wiki"),
        sql`${activityLogs.details}->>'cluster_id' = ${clusterId}`,
      ),
    )
    .orderBy(desc(activityLogs.created_at))
    .limit(1);
  return row?.status || null;
}

/**
 * Aktivitätslogs abrufen (paginiert, gefiltert).
 */
export async function getLogs(options: {
  action?: string;
  status?: string;
  workspace_id?: string;
  document_id?: string;
  limit?: number;
  offset?: number;
}): Promise<{ logs: any[]; total: number }> {
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  let conditions = undefined;

  if (options.action) {
    conditions = and(
      conditions,
      eq(activityLogs.action, options.action),
    ) as any;
  }
  if (options.status) {
    conditions = and(
      conditions,
      eq(activityLogs.status, options.status),
    ) as any;
  }
  if (options.workspace_id) {
    conditions = and(
      conditions,
      eq(activityLogs.workspace_id, options.workspace_id),
    ) as any;
  }
  if (options.document_id) {
    conditions = and(
      conditions,
      eq(activityLogs.document_id, options.document_id),
    ) as any;
  }

  const rows = await db
    .select()
    .from(activityLogs)
    .where(conditions as any)
    .orderBy(desc(activityLogs.created_at))
    .limit(limit)
    .offset(offset);

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(activityLogs)
    .where(conditions as any);

  return {
    logs: rows,
    total: Number(countResult?.count || 0),
  };
}

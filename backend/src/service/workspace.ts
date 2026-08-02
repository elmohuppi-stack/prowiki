import { db } from "../db/index.ts";
import {
  users,
  workspaces,
  workspaceMembers,
  documents,
  documentTopics,
  topics,
  chunks,
  wikiPages,
  wikiPageRevisions,
  chatSessions,
  chatMessages,
  activityLogs,
} from "../db/schema.ts";
import { eq, and, desc, like, or, sql, inArray } from "drizzle-orm";
import {
  normalizeRole,
  type WorkspaceRole,
} from "../middleware/workspace-access.ts";

/** Generiert einen URL-freundlichen Slug aus einem Namen */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s-]/g, "")
    .replace(/[\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * Workspaces, die der User sehen darf – inklusive seiner Rolle darin.
 *
 * Globale Admins sehen alles. Alle anderen sehen, was sie selbst angelegt haben
 * (workspaces.created_by) plus alles, wo sie Mitglied sind – unabhängig von der
 * Mitglieds-Rolle. `can_write` fasst für das Frontend zusammen, ob Schreiben
 * erlaubt ist (globale Rolle viewer schreibt nirgends).
 */
export async function listWorkspaces(user: { id: number; role: string }) {
  const decorate = (w: typeof workspaces.$inferSelect, role: WorkspaceRole) => ({
    ...w,
    slug: slugify(w.name),
    my_role: role,
    can_write: user.role !== "viewer" && role !== "viewer",
  });

  if (user.role === "admin") {
    const all = await db
      .select()
      .from(workspaces)
      .orderBy(desc(workspaces.created_at));
    return all.map((w) => decorate(w, "owner"));
  }

  const owned = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.created_by, user.id))
    .orderBy(desc(workspaces.created_at));

  const memberRows = await db
    .select({
      workspace: workspaces,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspace_id, workspaces.id))
    .where(eq(workspaceMembers.user_id, user.id))
    .orderBy(desc(workspaces.created_at));

  const byId = new Map<string, ReturnType<typeof decorate>>();
  for (const w of owned) byId.set(w.id, decorate(w, "owner"));
  for (const row of memberRows) {
    // Eigene Workspaces bleiben owner, auch wenn zusätzlich eine schwächere
    // Mitgliedschaftszeile existiert.
    if (byId.has(row.workspace.id)) continue;
    byId.set(row.workspace.id, decorate(row.workspace, normalizeRole(row.role)));
  }

  return [...byId.values()];
}

export async function getWorkspace(id: string) {
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);
  return workspace ? { ...workspace, slug: slugify(workspace.name) } : null;
}

/** Findet einen Workspace anhand des generierten Slugs (aus dem Namen) */
export async function getWorkspaceBySlug(slug: string) {
  const all = await db.select().from(workspaces);
  const match = all.find((w) => slugify(w.name) === slug);
  return match ? { ...match, slug: slugify(match.name) } : null;
}

export async function createWorkspace(data: {
  name: string;
  description?: string;
  created_by: number;
  chunk_size?: number;
  chunk_overlap?: number;
}) {
  return await db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({
        id: crypto.randomUUID(),
        name: data.name,
        description: data.description || null,
        created_by: data.created_by,
        chunk_size: data.chunk_size || 512,
        chunk_overlap: data.chunk_overlap || 50,
      })
      .returning();

    // Der Ersteller wird direkt als owner eingetragen. Ohne diese Zeile hängt
    // der Zugriff allein an created_by und geht bei einem Ownership-Wechsel
    // verloren.
    await tx.insert(workspaceMembers).values({
      workspace_id: workspace.id,
      user_id: data.created_by,
      role: "owner",
    });

    return workspace;
  });
}

/**
 * Überträgt den Besitz auf einen anderen User. Der bisherige Besitzer bleibt
 * als editor-Mitglied erhalten, damit er den Workspace nicht schlagartig
 * verliert; der neue Besitzer wird owner-Mitglied.
 */
export async function transferOwnership(
  workspaceId: string,
  newOwnerId: number,
) {
  return await db.transaction(async (tx) => {
    const [ws] = await tx
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!ws) return null;

    const previousOwnerId = ws.created_by;

    const [updated] = await tx
      .update(workspaces)
      .set({ created_by: newOwnerId, updated_at: new Date() })
      .where(eq(workspaces.id, workspaceId))
      .returning();

    await upsertMember(tx, workspaceId, newOwnerId, "owner");
    if (previousOwnerId !== newOwnerId) {
      await upsertMember(tx, workspaceId, previousOwnerId, "editor");
    }

    return updated;
  });
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Legt eine Mitgliedschaft an oder aktualisiert deren Rolle. */
async function upsertMember(
  tx: Tx | typeof db,
  workspaceId: string,
  userId: number,
  role: string,
) {
  await tx
    .insert(workspaceMembers)
    .values({ workspace_id: workspaceId, user_id: userId, role })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspace_id, workspaceMembers.user_id],
      set: { role },
    });
}

export async function updateWorkspace(
  id: string,
  data: {
    name?: string;
    description?: string;
    chunk_size?: number;
    chunk_overlap?: number;
    wiki_depth?: string;
  },
) {
  const { wiki_depth, ...rest } = data;
  const setClause: Record<string, any> = { ...rest, updated_at: new Date() };
  // wiki_depth in das bestehende wiki_config-JSONB mergen (übrige Keys erhalten).
  if (wiki_depth !== undefined) {
    setClause.wiki_config = sql`coalesce(${workspaces.wiki_config}, '{}'::jsonb) || ${JSON.stringify(
      { wiki_depth },
    )}::jsonb`;
  }
  const [workspace] = await db
    .update(workspaces)
    .set(setClause)
    .where(eq(workspaces.id, id))
    .returning();
  return workspace || null;
}

export async function deleteWorkspace(id: string) {
  // Die abhängigen Tabellen haben Foreign Keys auf workspaces.id OHNE
  // ON DELETE CASCADE. Ein reines DELETE auf workspaces schlägt daher mit
  // einer FK-Verletzung fehl (500). Deshalb hier alle Kinder in FK-sicherer
  // Reihenfolge in EINER Transaktion löschen (Kinder vor Eltern).
  await db.transaction(async (tx) => {
    // Sub-Selects für die indirekt (über documents/chat_sessions) verknüpften
    // Tabellen. Alle betroffenen Zeilen gehören zu genau diesem Workspace.
    const docIds = tx
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.workspace_id, id));
    const sessionIds = tx
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(eq(chatSessions.workspace_id, id));

    await tx
      .delete(chatMessages)
      .where(inArray(chatMessages.session_id, sessionIds));
    await tx.delete(chatSessions).where(eq(chatSessions.workspace_id, id));

    await tx
      .delete(wikiPageRevisions)
      .where(eq(wikiPageRevisions.workspace_id, id));
    await tx.delete(wikiPages).where(eq(wikiPages.workspace_id, id));

    await tx
      .delete(documentTopics)
      .where(inArray(documentTopics.document_id, docIds));
    await tx.delete(chunks).where(eq(chunks.workspace_id, id));
    await tx.delete(topics).where(eq(topics.workspace_id, id));

    // activity_logs referenziert workspaces.id UND documents.id → vor documents
    // löschen und beide Bezüge abdecken (auch Logs mit nur document_id).
    await tx
      .delete(activityLogs)
      .where(
        or(
          eq(activityLogs.workspace_id, id),
          inArray(activityLogs.document_id, docIds),
        ),
      );
    await tx.delete(documents).where(eq(documents.workspace_id, id));

    await tx
      .delete(workspaceMembers)
      .where(eq(workspaceMembers.workspace_id, id));
    await tx.delete(workspaces).where(eq(workspaces.id, id));
  });
}

export async function listMembers(workspaceId: string) {
  const rows = await db
    .select({
      id: workspaceMembers.id,
      workspace_id: workspaceMembers.workspace_id,
      user_id: workspaceMembers.user_id,
      role: workspaceMembers.role,
      created_at: workspaceMembers.created_at,
      name: users.name,
      email: users.email,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(workspaceMembers.user_id, users.id))
    .where(eq(workspaceMembers.workspace_id, workspaceId));
  return rows;
}

export async function addMember(
  workspaceId: string,
  userId: number,
  role: string = "viewer",
) {
  // Upsert statt Insert: ein erneutes Einladen soll die Rolle ändern und nicht
  // am Unique-Index (workspace_id, user_id) scheitern.
  await upsertMember(db, workspaceId, userId, role);
  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspace_id, workspaceId),
        eq(workspaceMembers.user_id, userId),
      ),
    )
    .limit(1);
  return member;
}

export async function removeMember(workspaceId: string, userId: number) {
  // Der Besitzer darf sich nicht selbst entfernen – sonst hätte der Workspace
  // keinen Verantwortlichen mehr. Erst Ownership übertragen, dann entfernen.
  const [ws] = await db
    .select({ created_by: workspaces.created_by })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (ws && ws.created_by === userId) {
    throw new Error(
      "Der Besitzer kann nicht entfernt werden – übertrage zuerst die Ownership.",
    );
  }

  await db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspace_id, workspaceId),
        eq(workspaceMembers.user_id, userId),
      ),
    );
}

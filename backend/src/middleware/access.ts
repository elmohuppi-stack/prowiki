/**
 * Zugriffsauflösung — die einzige Stelle, an der über Rechte entschieden wird.
 *
 * knora prüfte an mehreren Stellen unterschiedlich (`canWrite()`, `requireRole()`,
 * ein Regex über dem Pfad in `workspaceParamAccess()`), und die globale Rolle
 * schlug dabei die lokale. Hier gibt es genau eine Funktion, die aus
 * Sitzung + Wiki eine Capability-Menge macht, und genau eine, die sie prüft.
 *
 * Reihenfolge der Auflösung:
 *
 *   1. Wiki existiert?                       nein → 404
 *   2. Wiki-Override für diesen Nutzer?      ja   → dessen Rolle gewinnt
 *   3. sonst Organisationsrolle aus `member`
 *   4. kein Mitglied, aber Wiki öffentlich?  → anonyme Capabilities
 *   5. sonst kein Zugriff
 *
 * Warum der Wiki-Override *vor* der Organisationsrolle greift: nur so lässt sich
 * jemandem in einem einzelnen Wiki gezielt weniger geben als in der Organisation
 * (Praktikant, externer Gastautor). Eine reine Vereinigung beider Rollen könnte
 * Rechte nur addieren, nie einschränken.
 */
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { wikis, wikiMembers, member, documents } from "../db/schema.ts";
import {
  capabilitiesOf,
  isRoleName,
  ANONYMOUS_CAPABILITIES,
  type Capability,
  type RoleName,
} from "../auth/permissions.ts";

export interface Principal {
  userId: string | null;
  email: string | null;
  /** Gesetzt, wenn der Zugriff über einen API-Schlüssel statt eine Sitzung kommt. */
  apiKeyId?: string | null;
}

export const ANONYMOUS: Principal = { userId: null, email: null };

export interface WikiAccess {
  wikiId: string;
  organizationId: string;
  visibility: string;
  anonymousChatEnabled: boolean;
  /** null bei anonymem Zugriff auf ein öffentliches Wiki. */
  role: RoleName | null;
  capabilities: ReadonlySet<string>;
}

/**
 * Bewusst 404 statt 403, wenn jemand gar keinen Zugriff hat: ein 403 bestätigt
 * die Existenz des Wikis und macht fremde IDs durchprobierbar.
 */
function notFound(): HTTPException {
  return new HTTPException(404, {
    res: Response.json({ error: "Wiki nicht gefunden" }, { status: 404 }),
  });
}

function notFoundOrg(): HTTPException {
  return new HTTPException(404, {
    res: Response.json({ error: "Organisation nicht gefunden" }, { status: 404 }),
  });
}

function forbidden(capability: Capability): HTTPException {
  return new HTTPException(403, {
    res: Response.json(
      { error: "Fehlende Berechtigung", required: capability },
      { status: 403 },
    ),
  });
}

/** Rolle → Capabilities, mit sicherem Rückfall bei unbekanntem Rollennamen. */
function capabilitiesForRole(role: string): {
  role: RoleName | null;
  capabilities: ReadonlySet<string>;
} {
  if (!isRoleName(role)) {
    // Kann durch eine spätere Better-Auth-Rolle oder einen Datenfehler entstehen.
    // Dann lieber nichts erlauben als raten.
    console.warn(`[access] Unbekannte Rolle "${role}" — Zugriff verweigert`);
    return { role: null, capabilities: new Set() };
  }
  return { role, capabilities: capabilitiesOf(role) };
}

export interface OrgAccess {
  organizationId: string;
  role: RoleName;
  capabilities: ReadonlySet<string>;
}

/**
 * Rechte auf **Organisationsebene** — für alles, was nicht an einem einzelnen
 * Wiki hängt: ein Wiki anlegen (`wiki.create`), Mitglieder verwalten,
 * Modell-Provider und Abrechnung (`settings.manage`, `billing.manage`).
 *
 * Anonym gibt es hier nichts: eine Organisation ist nie öffentlich, nur einzelne
 * Wikis darin sind es.
 */
export async function resolveOrgAccess(
  principal: Principal,
  organizationId: string,
): Promise<OrgAccess> {
  if (!principal.userId) throw notFoundOrg();

  const [orgMember] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, principal.userId),
      ),
    )
    .limit(1);

  if (!orgMember) throw notFoundOrg();

  const resolved = capabilitiesForRole(orgMember.role);
  if (!resolved.role) throw notFoundOrg();

  return {
    organizationId,
    role: resolved.role,
    capabilities: resolved.capabilities,
  };
}

export async function requireOrgCapability(
  principal: Principal,
  organizationId: string,
  capability: Capability,
): Promise<OrgAccess> {
  const access = await resolveOrgAccess(principal, organizationId);
  if (!access.capabilities.has(capability)) throw forbidden(capability);
  return access;
}

/**
 * Ermittelt, was `principal` in diesem Wiki darf. Wirft 404, wenn das Wiki nicht
 * existiert oder der Zugreifende nichts davon wissen soll.
 */
export async function resolveWikiAccess(
  principal: Principal,
  wikiId: string,
): Promise<WikiAccess> {
  const [wiki] = await db
    .select({
      id: wikis.id,
      organization_id: wikis.organization_id,
      visibility: wikis.visibility,
      anonymous_chat_enabled: wikis.anonymous_chat_enabled,
    })
    .from(wikis)
    .where(eq(wikis.id, wikiId))
    .limit(1);

  if (!wiki) throw notFound();

  const base = {
    wikiId: wiki.id,
    organizationId: wiki.organization_id,
    visibility: wiki.visibility,
    anonymousChatEnabled: wiki.anonymous_chat_enabled,
  };

  const publiclyReadable =
    wiki.visibility === "public" || wiki.visibility === "link";

  if (!principal.userId) {
    if (!publiclyReadable) throw notFound();
    return {
      ...base,
      role: null,
      capabilities: anonymousCapabilities(wiki.anonymous_chat_enabled),
    };
  }

  // 2. Wiki-Override
  const [override] = await db
    .select({ role: wikiMembers.role })
    .from(wikiMembers)
    .where(
      and(
        eq(wikiMembers.wiki_id, wikiId),
        eq(wikiMembers.user_id, principal.userId),
      ),
    )
    .limit(1);

  if (override) return { ...base, ...capabilitiesForRole(override.role) };

  // 3. Organisationsrolle
  const [orgMember] = await db
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.organizationId, wiki.organization_id),
        eq(member.userId, principal.userId),
      ),
    )
    .limit(1);

  if (orgMember) return { ...base, ...capabilitiesForRole(orgMember.role) };

  // 4. Angemeldet, aber kein Mitglied — auf öffentlichen Wikis wie ein Gast.
  if (publiclyReadable) {
    return {
      ...base,
      role: null,
      capabilities: anonymousCapabilities(wiki.anonymous_chat_enabled),
    };
  }

  throw notFound();
}

function anonymousCapabilities(chatEnabled: boolean): ReadonlySet<string> {
  if (!chatEnabled) return ANONYMOUS_CAPABILITIES;
  return new Set([...ANONYMOUS_CAPABILITIES, "chat.use"]);
}

/** Prüft eine Capability und wirft 403, wenn sie fehlt. */
export function assertCapability(
  access: WikiAccess,
  capability: Capability,
): void {
  if (!access.capabilities.has(capability)) throw forbidden(capability);
}

/** Auflösen und prüfen in einem Schritt — der Normalfall im Router. */
export async function requireWikiCapability(
  principal: Principal,
  wikiId: string,
  capability: Capability,
): Promise<WikiAccess> {
  const access = await resolveWikiAccess(principal, wikiId);
  assertCapability(access, capability);
  return access;
}

/** Wie oben, ausgehend von einer Dokument-ID. */
export async function requireDocumentCapability(
  principal: Principal,
  documentId: string,
  capability: Capability,
): Promise<{ access: WikiAccess; wikiId: string }> {
  const [doc] = await db
    .select({ wiki_id: documents.wiki_id })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!doc) {
    throw new HTTPException(404, {
      res: Response.json({ error: "Dokument nicht gefunden" }, { status: 404 }),
    });
  }
  const access = await requireWikiCapability(principal, doc.wiki_id, capability);
  return { access, wikiId: doc.wiki_id };
}

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal;
    wikiAccess: WikiAccess;
  }
}

/**
 * Für Router, deren Routen alle mit /:wikiId beginnen. Das Zugriffslevel ergibt
 * sich aus der HTTP-Methode.
 *
 * Anders als knoras `workspaceParamAccess()` gibt es hier **keinen Rückfall auf
 * die erste UUID im Pfad**: fehlt der Parameter, ist das ein Programmierfehler
 * und wird als 400 sichtbar, statt die Autorisierung an einem Regex über dem
 * Pfad hängen zu lassen.
 */
export function wikiParamAccess(paramName = "wikiId") {
  return createMiddleware(async (c, next) => {
    const wikiId = c.req.param(paramName);
    if (!wikiId) {
      return c.json({ error: `${paramName} fehlt in der Route` }, 400);
    }
    const read = c.req.method === "GET" || c.req.method === "HEAD";
    const access = await requireWikiCapability(
      c.get("principal") ?? ANONYMOUS,
      wikiId,
      read ? "wiki.read" : "wiki.write",
    );
    c.set("wikiAccess", access);
    await next();
  });
}

/**
 * Rechtemodell prowiki — Capabilities statt Rollen-Vergleiche.
 *
 * In knora war das Recht über zwei verkoppelte Rollenfelder verteilt
 * (`user.role` global + `workspace_members.role` lokal) und die Prüfung stand
 * als `if (user.role === "viewer") return false` mitten in der Middleware. Das
 * hatte zwei Folgen: ein global als Viewer angelegter Nutzer konnte im *eigenen*
 * Workspace nichts schreiben, und jede neue Abstufung (Autor darf schreiben,
 * aber nicht veröffentlichen) hätte die Prüffunktion selbst ändern müssen.
 *
 * Hier ist die Rolle nur noch ein *benanntes Bündel* von Capabilities. Geprüft
 * wird immer eine Capability, nie eine Rolle. Neue Rollen sind damit reine
 * Datenänderung.
 *
 * Die Vergabe passiert auf zwei Ebenen (siehe access.ts):
 *   organization → Rolle gilt für alle Wikis der Organisation
 *   wiki         → optionaler Override für ein einzelnes Wiki
 */
import { createAccessControl } from "better-auth/plugins/access";
import {
  defaultStatements,
  adminAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

/**
 * Ressourcen und die darauf möglichen Aktionen. `defaultStatements` bringt die
 * Organisationsverwaltung von Better Auth mit (organization/member/invitation);
 * alles darunter ist prowiki-eigen.
 */
export const statement = {
  ...defaultStatements,
  wiki: ["create", "read", "write", "publish", "delete"],
  source: ["import", "delete"],
  chat: ["use"],
  billing: ["manage"],
  settings: ["manage"],
} as const;

export const ac = createAccessControl(statement);

/** Voller Zugriff inklusive Abrechnung und Löschen der Organisation. */
export const owner = ac.newRole({
  ...ownerAc.statements,
  wiki: ["create", "read", "write", "publish", "delete"],
  source: ["import", "delete"],
  chat: ["use"],
  billing: ["manage"],
  settings: ["manage"],
});

/** Wie owner, aber ohne Abrechnung — die bleibt beim Inhaber. */
export const admin = ac.newRole({
  ...adminAc.statements,
  wiki: ["create", "read", "write", "publish", "delete"],
  source: ["import", "delete"],
  chat: ["use"],
  settings: ["manage"],
});

/** Redaktionsleitung: darf importieren und veröffentlichen, aber nicht verwalten. */
export const editor = ac.newRole({
  wiki: ["create", "read", "write", "publish"],
  source: ["import"],
  chat: ["use"],
});

/** Schreibt Artikel, veröffentlicht sie aber nicht selbst. */
export const author = ac.newRole({
  wiki: ["read", "write"],
  chat: ["use"],
});

/** Gibt fremde Artikel frei, schreibt selbst nicht. */
export const reviewer = ac.newRole({
  wiki: ["read", "publish"],
  chat: ["use"],
});

/** Liest und fragt, ändert nichts. */
export const viewer = ac.newRole({
  wiki: ["read"],
  chat: ["use"],
});

export const roles = { owner, admin, editor, author, reviewer, viewer };

export type RoleName = keyof typeof roles;

export const ROLE_NAMES = Object.keys(roles) as RoleName[];

export function isRoleName(value: string): value is RoleName {
  return (ROLE_NAMES as string[]).includes(value);
}

/**
 * Capability-Schreibweise für die Prüfung im Code: `"wiki.read"`, `"chat.use"` …
 * Wird aus `statement` abgeleitet, damit Tippfehler beim Kompilieren auffallen
 * statt zur Laufzeit stillschweigend `false` zu liefern.
 */
export type Capability = {
  [R in keyof typeof statement]: `${R & string}.${(typeof statement)[R][number] & string}`;
}[keyof typeof statement];

/**
 * Flache Capability-Menge einer Rolle. Die Auflösung passiert einmal beim Start,
 * nicht bei jeder Anfrage — die Rollen sind statisch.
 */
function expand(role: { statements: Record<string, readonly string[]> }): Set<string> {
  const out = new Set<string>();
  for (const [resource, actions] of Object.entries(role.statements)) {
    for (const action of actions) out.add(`${resource}.${action}`);
  }
  return out;
}

const CAPABILITIES_BY_ROLE: Record<RoleName, Set<string>> = {
  owner: expand(owner),
  admin: expand(admin),
  editor: expand(editor),
  author: expand(author),
  reviewer: expand(reviewer),
  viewer: expand(viewer),
};

export function capabilitiesOf(role: RoleName): ReadonlySet<string> {
  return CAPABILITIES_BY_ROLE[role];
}

export function roleHas(role: RoleName, capability: Capability): boolean {
  return CAPABILITIES_BY_ROLE[role].has(capability);
}

/**
 * Was ein *nicht angemeldeter* Besucher auf einem öffentlichen Wiki darf.
 * `chat.use` ist bewusst nicht enthalten: anonymer Chat kostet Geld und wird
 * pro Wiki einzeln freigeschaltet (siehe access.ts), nicht pauschal.
 */
export const ANONYMOUS_CAPABILITIES: ReadonlySet<string> = new Set(["wiki.read"]);

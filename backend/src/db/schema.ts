/**
 * Sammelpunkt für das gesamte Schema. Bleibt bestehen, damit Importe der Form
 * `import { documents } from "../db/schema.ts"` weiter greifen und der
 * Drizzle-Adapter von Better Auth alle Tabellen in einem Objekt sieht.
 *
 *   auth.ts     Nutzer, Sitzungen, Organisationen — von Better Auth verwaltet
 *   tenancy.ts  Wikis, Sichtbarkeit, Zählung, Audit, API-Schlüssel
 *   content.ts  Quellen, Transkripte, Chunks, Wiki-Seiten, Chat
 */
export * from "./schema/auth.ts";
export * from "./schema/tenancy.ts";
export * from "./schema/content.ts";

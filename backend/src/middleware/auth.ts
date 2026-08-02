/**
 * Sitzungserkennung. Ersetzt die JWT-Middleware aus knora.
 *
 * Zwei Unterschiede, die zählen:
 *
 *   - Die Sitzung wird gegen die Tabelle `session` aufgelöst, nicht gegen eine
 *     Signatur. Ein widerrufenes Token ist damit sofort ungültig, statt bis zum
 *     Ablauf weiterzugelten (Befund 2.2).
 *   - Es gibt keine globale Rolle mehr am Nutzer. Was jemand darf, ergibt sich
 *     ausschließlich aus Organisations- und Wiki-Mitgliedschaft — aufgelöst in
 *     middleware/access.ts. Ein `ADMIN_EMAIL`-Sonderweg existiert nicht mehr
 *     (Befund 2.1).
 */
import { createMiddleware } from "hono/factory";
import { auth } from "../auth/index.ts";
import { ANONYMOUS, type Principal } from "./access.ts";

/**
 * Setzt `principal` auf die angemeldete Person oder auf ANONYMOUS. Blockiert
 * bewusst nicht — öffentliche Wikis müssen ohne Anmeldung lesbar sein. Die
 * Entscheidung fällt erst in der Capability-Prüfung.
 */
export const sessionMiddleware = createMiddleware(async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const principal: Principal = session?.user
    ? { userId: session.user.id, email: session.user.email }
    : ANONYMOUS;
  c.set("principal", principal);
  await next();
});

/** Für Routen, die ohne Anmeldung sinnlos sind (eigene Organisationen o. ä.). */
export const requireUser = createMiddleware(async (c, next) => {
  const principal = c.get("principal");
  if (!principal?.userId) {
    return c.json({ error: "Nicht angemeldet" }, 401);
  }
  await next();
});

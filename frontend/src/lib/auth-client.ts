/**
 * Better-Auth-Client. Ersetzt das handgeschriebene Token-Handling aus knora.
 *
 * Der wesentliche Unterschied: es gibt kein Token mehr, das das Frontend
 * verwaltet. Die Sitzung steckt in einem httpOnly-Cookie, das der Browser
 * selbst mitschickt — unlesbar für JavaScript und damit auch für ein
 * XSS-Skript. knora legte das JWT im localStorage ab; bei einer App, die
 * fremdes Markdown rendert, ist das die falsche Ablage (Befund 2.8).
 *
 * Folge fürs Frontend: `axios.defaults.withCredentials = true` genügt, kein
 * Authorization-Header, kein manuelles Setzen nach dem Login.
 */
import { createAuthClient } from "better-auth/vue";
import { organizationClient } from "better-auth/client/plugins";
import { ac, roles } from "./permissions";

export const authClient = createAuthClient({
  // Leer = gleiche Herkunft. Im Dev leitet der Vite-Proxy /api weiter, in
  // Produktion liegt das Frontend-nginx vor derselben Domain.
  baseURL: import.meta.env.VITE_AUTH_BASE_URL ?? "",
  plugins: [organizationClient({ ac, roles })],
});

export const { signIn, signUp, signOut, useSession, organization } = authClient;

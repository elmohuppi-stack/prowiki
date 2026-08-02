/**
 * Rollennamen robust einlesen.
 *
 * Getrennt von permissions.ts, damit Services die Normalisierung benutzen
 * können, ohne die Middleware zu importieren (und damit einen Zyklus zu bauen).
 */
import { isRoleName, type RoleName } from "./permissions.ts";

/**
 * Wandelt einen gespeicherten Rollenwert in eine bekannte Rolle. Unbekanntes
 * fällt auf `viewer` zurück — die Rolle mit den wenigsten Rechten.
 *
 * `"member"` ist Better Auths Standardrolle für neue Organisationsmitglieder
 * und entspricht bei uns `viewer`. `"admin"` aus knoras Wiki-Mitgliedschaften
 * meinte den Besitzer.
 */
export function normalizeRole(role: string | null | undefined): RoleName {
  if (!role) return "viewer";
  if (role === "member") return "viewer";
  if (isRoleName(role)) return role;
  return "viewer";
}

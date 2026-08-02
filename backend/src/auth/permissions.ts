/**
 * Das Rechtemodell liegt in `@prowiki/shared`, weil Backend und Frontend
 * dieselben Rollen und Capabilities kennen müssen: Better Auth verlangt die
 * Access-Control-Definition auf beiden Seiten, und zwei Kopien wären genau die
 * Art von Duplikat, das irgendwann auseinanderläuft — mit dem Ergebnis, dass
 * die Oberfläche einen Knopf zeigt, den das Backend verweigert.
 *
 * Diese Datei bleibt als Re-Export bestehen, damit die Importpfade im Backend
 * kurz sind (`../auth/permissions.ts`).
 */
export * from "@prowiki/shared/permissions";

/**
 * Sicherheitsprotokoll: schreibt `audit_events` (schema/tenancy.ts).
 *
 * ## Warum getrennt von `activity_logs`
 *
 * `activity_logs` beantwortet „was hat die Anwendung getan" — Importe,
 * Wiki-Läufe, Dauer. `audit_events` beantwortet „wer hat wann eine
 * Berechtigung oder einen Inhalt verändert". Das sind zwei verschiedene
 * Fragen mit zwei verschiedenen Lesern: die eine stellt man beim Debuggen,
 * die andere nach einem Vorfall oder auf Nachfrage eines Kunden. Sie in
 * einer Tabelle zu mischen hieße, das Protokoll, das man im Ernstfall
 * braucht, in dem zu suchen, das bei jedem Import volläuft.
 *
 * Die Tabelle stand seit dem Livegang am 16. August leer — sie war angelegt,
 * aber keine Zeile Code schrieb sie (KONZEPT §6, Stufe 0, letzter offener
 * Punkt). Dieses Modul ist die fehlende Schreibseite.
 *
 * ## Was protokolliert wird
 *
 * Die vier Ereignisarten aus dem Konzept, plus die fehlgeschlagene Anmeldung:
 *
 *   - **Anmeldung** — erfolgreich und fehlgeschlagen. Der Fehlschlag ist die
 *     wertvollere Zeile: eine Reihe davon auf dieselbe Adresse ist der
 *     einzige Hinweis auf einen Angriff, den wir überhaupt bekommen.
 *   - **Rollenwechsel** — auf Organisations- wie auf Wiki-Ebene.
 *   - **Freigabe** — Entwürfe werden veröffentlicht.
 *   - **Löschung** — Seite, Dokument, Wiki.
 *
 * ## Warum nichts hier je einen Fehler wirft
 *
 * Dieselbe Regel wie bei der Kostenzählung (service/usage.ts): ein Protokoll
 * darf die Arbeit nicht anhalten. Eine fehlende Audit-Zeile ist ärgerlich;
 * eine Anmeldung, die scheitert, weil das Protokollieren scheiterte, ist
 * schlimmer. Alle Funktionen fangen selbst ab und melden in der Konsole.
 *
 * Die Kehrseite ist bewusst in Kauf genommen: das Protokoll ist damit kein
 * lückenloser Beweis, sondern eine sehr gute Aufzeichnung. Wer Lückenlosigkeit
 * braucht, müsste in derselben Transaktion schreiben wie die Änderung — das
 * ist eine Umstellung wert, wenn ein Kunde sie verlangt, aber nicht vorher.
 */
import type { Context } from "hono";
import { db } from "../db/index.ts";
import { auditEvents } from "../db/schema.ts";

/**
 * Die protokollierten Aktionen. Feste Zeichenketten statt freier Texte, damit
 * `where action = …` etwas findet und eine spätere Auswertung nicht an
 * Schreibweisen scheitert.
 */
export const AUDIT = {
  /** Sitzung entstanden — Anmeldung, auch nach Verifikation oder Registrierung. */
  anmeldung: "auth.login",
  /** Anmeldung abgelehnt (falsches Passwort, unbestätigte Adresse, gesperrt). */
  anmeldungFehlgeschlagen: "auth.login_failed",
  /** Rolle eines Mitglieds in der Organisation geändert. */
  orgRolleGeändert: "org.member_role_changed",
  /** Mitglied aus der Organisation entfernt. */
  orgMitgliedEntfernt: "org.member_removed",
  /** Abweichende Rolle für ein einzelnes Wiki gesetzt. */
  wikiRolleGesetzt: "wiki.member_role_set",
  /** Abweichende Rolle für ein einzelnes Wiki aufgehoben. */
  wikiRolleEntfernt: "wiki.member_role_removed",
  /** Artikelverbund freigegeben (Entwürfe → veröffentlicht). */
  freigabe: "page.published",
  /** Wiki-Seite gelöscht. */
  seiteGelöscht: "page.deleted",
  /** Dokument samt Chunks gelöscht. */
  dokumentGelöscht: "document.deleted",
  /** Ganzes Wiki gelöscht. */
  wikiGelöscht: "wiki.deleted",
} as const;

export type AuditAktion = (typeof AUDIT)[keyof typeof AUDIT];

export interface Auditereignis {
  action: AuditAktion;
  organizationId?: string | null;
  actorId?: string | null;
  /**
   * Wird mitgeschrieben, obwohl `actor_id` auf `user` zeigt: die Referenz steht
   * auf `set null`, ein gelöschtes Konto würde sonst alle seine Zeilen
   * anonymisieren. Genau dann will man wissen, wer gehandelt hat.
   */
  actorEmail?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Schreibt eine Zeile. Wirft nie. */
export async function protokolliere(e: Auditereignis): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      id: crypto.randomUUID(),
      organization_id: e.organizationId ?? null,
      actor_id: e.actorId ?? null,
      actor_email: e.actorEmail ?? null,
      action: e.action,
      target_type: e.targetType ?? null,
      target_id: e.targetId ? String(e.targetId).slice(0, 64) : null,
      details: e.details ?? {},
      ip_address: e.ip ?? null,
      user_agent: e.userAgent ?? null,
      created_at: new Date(),
    });
  } catch (fehler) {
    console.error(
      `[audit] ${e.action} nicht protokolliert:`,
      fehler instanceof Error ? fehler.message : fehler,
    );
  }
}

/**
 * Herkunft eines Aufrufs aus den Kopfzeilen.
 *
 * `x-forwarded-for` ist nur belastbar, weil der eigene nginx davorsteht und
 * ihn setzt (frontend/nginx.conf) — dieselbe Einschränkung wie beim
 * Rate-Limit. Für ein Protokoll genügt das: es soll erkennbar machen, von wo
 * eine Reihe fehlgeschlagener Anmeldungen kam, nicht vor Gericht bestehen.
 */
export function herkunft(kopfzeilen: Headers | Context["req"]): {
  ip: string | null;
  userAgent: string | null;
} {
  const lies = (name: string): string | null => {
    const wert =
      kopfzeilen instanceof Headers
        ? kopfzeilen.get(name)
        : kopfzeilen.header(name);
    return wert ?? null;
  };
  return {
    ip:
      lies("x-forwarded-for")?.split(",")[0]?.trim() ??
      lies("x-real-ip") ??
      null,
    // Die Spalte ist `text`, aber ein absurd langer Wert gehört trotzdem
    // nicht in die Datenbank.
    userAgent: lies("user-agent")?.slice(0, 512) ?? null,
  };
}

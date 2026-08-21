/**
 * Mailversand über SMTP.
 *
 * ## Was hier gelöst wird
 *
 * Bis zum 21. August 2026 standen Verifikations- und Passwort-Reset-Links **nur
 * im Container-Log** (`auth/index.ts`). Für zwei bekannte Nutzer war das
 * tragbar, hatte aber eine unangenehme Folge: ein vergessenes Passwort war ohne
 * SSH-Zugang zum Server nicht zurücksetzbar. Wer den Zugang nicht hat, kommt
 * nicht mehr in sein Konto — und das ist genau die Person, die einen Reset
 * braucht.
 *
 * ## Warum SMTP und kein API-Dienst
 *
 * SMTP ist der einzige Weg, der ohne eine Anbieterentscheidung funktioniert.
 * Ein API-Dienst (Resend, Postmark, SES) bedeutet ein Konto, eine
 * Domain-Verifikation, einen Schlüssel und einen weiteren Drittempfänger für
 * die Datenschutzseite. SMTP-Zugangsdaten hat dagegen jeder Mailanbieter, auch
 * der, bei dem `elmarhepp.de` schon liegt. Wenn später ein API-Dienst dazukommt,
 * ist `sendeMail` die Stelle, an der er eingehängt wird — die Aufrufer merken
 * nichts.
 *
 * ## Verhalten ohne Konfiguration
 *
 * Ohne `SMTP_HOST` wird **nicht** geschwiegen und nicht geworfen: der Link
 * landet weiter im Log, mit einem deutlichen Hinweis, dass keine Mail
 * rausgegangen ist. Das ist der lokale Entwicklungsfall, und es ist auch der
 * Zustand, in dem prowiki heute läuft — ein Wechsel, der eine Registrierung
 * abbrechen ließe, weil eine Umgebungsvariable fehlt, wäre schlechter als der
 * Zustand vorher.
 *
 * ## Warum ein Fehler beim Versand nicht durchschlägt
 *
 * `sendeMail` wirft nie. Ein Mailserver, der gerade nicht antwortet, darf keine
 * Registrierung mit einem 500 beenden — das Konto ist dann angelegt, die Mail
 * nicht raus, und ein zweiter Versuch scheitert an der schon belegten Adresse.
 * Stattdessen: Fehler ins Log, Link ins Log, Vorgang läuft weiter.
 */
import { createTransport, type Transporter } from "nodemailer";

const HOST = process.env.SMTP_HOST;
const PORT = Number(process.env.SMTP_PORT ?? 587);
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASSWORD;
const VON = process.env.MAIL_FROM ?? "prowiki <noreply@elmarhepp.de>";

let transport: Transporter | null = null;

/** Ist Versand konfiguriert? Sonst wird geloggt statt gesendet. */
export function mailVersandAktiv(): boolean {
  return Boolean(HOST);
}

function holeTransport(): Transporter | null {
  if (!HOST) return null;
  if (transport) return transport;
  transport = createTransport({
    host: HOST,
    port: PORT,
    // Port 465 ist implizites TLS, 587 beginnt im Klartext und wechselt per
    // STARTTLS. Das automatisch aus dem Port zu schließen, ist die Konvention,
    // an die sich alle Anbieter halten — und ein falsch gesetztes `secure` ist
    // der häufigste Grund, warum SMTP „einfach nicht geht".
    secure: PORT === 465,
    auth: USER && PASS ? { user: USER, pass: PASS } : undefined,
    // Ohne Deckel hängt ein Request bis zum Bun-Leerlauftimeout, wenn der
    // Mailserver stumm bleibt.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transport;
}

export interface Mail {
  an: string;
  betreff: string;
  text: string;
  /** Optional; ohne HTML-Teil ist die Mail reiner Text, was hier genügt. */
  html?: string;
}

/**
 * Verschickt eine Mail. Wirft nie.
 *
 * Liefert `true`, wenn sie tatsächlich rausgegangen ist — nicht, wenn sie nur
 * geloggt wurde. Der Aufrufer kann das unterscheiden, muss aber nicht.
 */
export async function sendeMail(m: Mail): Promise<boolean> {
  const t = holeTransport();
  if (!t) {
    console.warn(
      `[mail] SMTP_HOST nicht gesetzt – keine Mail an ${m.an} verschickt. ` +
        `Inhalt steht unten im Log.\n[mail] ${m.betreff}\n${m.text}`,
    );
    return false;
  }
  try {
    const info = await t.sendMail({
      from: VON,
      to: m.an,
      subject: m.betreff,
      text: m.text,
      html: m.html,
    });
    console.log(`[mail] an ${m.an}: ${m.betreff} (${info.messageId})`);
    return true;
  } catch (e: any) {
    // Link zusätzlich ins Log: sonst ist er verloren, und der Nutzer sitzt vor
    // einem Konto, das er nicht bestätigen kann.
    console.error(
      `[mail] Versand an ${m.an} fehlgeschlagen: ${e?.message ?? e}\n` +
        `[mail] Inhalt zur Hand: ${m.text}`,
    );
    return false;
  }
}

/** Adresse bestätigen. */
export function verifikationsMail(url: string): Omit<Mail, "an"> {
  return {
    betreff: "prowiki: Adresse bestätigen",
    text: `Willkommen bei prowiki.

Bitte bestätige diese Adresse, um dein Konto zu aktivieren:

${url}

Wenn du dich nicht registriert hast, ignoriere diese Mail — ohne Bestätigung
entsteht kein Zugang.`,
  };
}

/** Passwort zurücksetzen. */
export function resetMail(url: string): Omit<Mail, "an"> {
  return {
    betreff: "prowiki: Passwort zurücksetzen",
    text: `Für dieses Konto wurde ein neues Passwort angefordert.

${url}

Der Link ist zeitlich begrenzt und nur einmal verwendbar. Hast du das nicht
angefordert, ist nichts zu tun: ohne Aufruf des Links bleibt das alte Passwort
gültig.`,
  };
}

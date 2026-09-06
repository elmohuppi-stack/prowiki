/**
 * Identität und Sitzungen — Better Auth über den vorhandenen Drizzle-Pool.
 *
 * Was hier bewusst NICHT mehr existiert (Befunde 2.1–2.4 in docs/KONZEPT.md):
 *
 *   - Kein `ADMIN_EMAIL`/`ADMIN_PASSWORD`-Klartextvergleich vor der DB-Abfrage
 *     und keine Erhebung zum Admin allein anhand der E-Mail-Adresse. In knora
 *     war jeder, der diese Adresse benutzte, Admin über alles.
 *   - Keine zustandslosen 7-Tage-JWTs. Sitzungen liegen in der Tabelle `session`
 *     und sind damit einzeln widerrufbar ("auf allen Geräten abmelden",
 *     Rauswurf eines Mitarbeiters, Passwortwechsel).
 *   - Keine offene Registrierung ohne Verifikation und ohne Passwort-Reset.
 *
 * Wer Betreiber-Admin sein soll, bekommt das über eine Zeile in `member` bzw.
 * über die Organisationsrolle — nicht über eine Umgebungsvariable.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { ac, roles } from "./permissions.ts";
import { sendeMail, resetMail, verifikationsMail } from "../service/mail.ts";
import { AUDIT, protokolliere, herkunft } from "../service/audit.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Bewusst harter Abbruch: knora startete bei fehlendem JWT_SECRET still mit
    // einem Default aus dem Repository weiter. Ein Secret, das im Repo steht,
    // erlaubt jedem das Ausstellen gültiger Sitzungen.
    throw new Error(`${name} fehlt — Start abgebrochen`);
  }
  return value;
}

const BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:5173";

/** Erlaubte Absender für Cookies/CORS. Kundendomänen kommen in Stufe 2 dazu. */
export const trustedOrigins = (process.env.TRUSTED_ORIGINS ?? BASE_URL)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Selbstregistrierung — standardmäßig **aus**.
 *
 * `POST /sign-up/email` ist sonst für jeden offen, auch ohne Link in der
 * Oberfläche; die Betriebsregel des Servers verlangt sie deshalb geschlossen
 * (platform/NEUE-APP.md 4.1). Nötig ist sie trotzdem einmal: die ersten Konten
 * entstehen genau darüber, weil weder bootstrap-org.ts noch das
 * Migrationsskript Konten anlegen dürfen.
 *
 * Deshalb ein Schalter statt eines zweiten Deploys — `ALLOW_SIGNUP=1` für den
 * Bootstrap, danach zurück auf 0 und `docker compose up -d`. Ohne den Schalter
 * stünde die App zwischen Start und Nachbesserung offen im Netz.
 *
 * Der reguläre Weg für weitere Nutzer sind Einladungen (Stufe 3, braucht Mail).
 */
const allowSignup = process.env.ALLOW_SIGNUP === "1";

/** In Produktion gehen Cookies nur über TLS raus. Siehe `advanced` unten. */
const useSecureCookies = process.env.NODE_ENV === "production";

export const auth = betterAuth({
  appName: "prowiki",
  baseURL: BASE_URL,
  secret: required("AUTH_SECRET"),
  trustedOrigins,

  database: drizzleAdapter(db, { provider: "pg", schema }),

  emailAndPassword: {
    enabled: true,
    disableSignUp: !allowSignup,
    // Ohne bestätigte Adresse kein Login. Verhindert, dass sich jemand mit einer
    // fremden Adresse registriert und über den Einladungs-Flow Zugriff erbt.
    requireEmailVerification: true,
    minPasswordLength: 12,
    async sendResetPassword({ user, url }) {
      // Ohne SMTP_HOST landet der Link im Log statt in einer Mail — service/mail.ts
      // erklärt, warum das der richtige Rückfall ist und nicht ein Fehler.
      await sendeMail({ an: user.email, ...resetMail(url) });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user, url }) {
      await sendeMail({ an: user.email, ...verifikationsMail(url) });
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },

  /**
   * Anmeldungen ins Sicherheitsprotokoll (service/audit.ts).
   *
   * Warum am Entstehen der Sitzung und nicht an der Route `/sign-in/email`:
   * eine Sitzung entsteht auch nach der Mail-Verifikation
   * (`autoSignInAfterVerification`) und beim Bootstrap-Konto. Wer nur die
   * Anmelderoute beobachtet, verpasst ausgerechnet die erste Benutzung eines
   * neuen Kontos.
   *
   * Die Sitzungszeile führt IP und User-Agent bereits mit (schema/auth.ts) —
   * beides muss hier nicht aus Kopfzeilen geraten werden.
   */
  databaseHooks: {
    session: {
      create: {
        async after(sitzung) {
          try {
            const [konto] = await db
              .select({ email: schema.user.email })
              .from(schema.user)
              .where(eq(schema.user.id, sitzung.userId))
              .limit(1);
            await protokolliere({
              action: AUDIT.anmeldung,
              // Better Auth typisiert Zusatzfelder der Sitzung als `{}`; beim
              // ersten Login ist noch keine Organisation gewählt.
              organizationId:
                typeof sitzung.activeOrganizationId === "string"
                  ? sitzung.activeOrganizationId
                  : null,
              actorId: sitzung.userId,
              actorEmail: konto?.email ?? null,
              targetType: "session",
              targetId: sitzung.id,
              ip: sitzung.ipAddress ?? null,
              userAgent: sitzung.userAgent ?? null,
            });
          } catch (fehler) {
            // Eine Anmeldung darf nicht daran scheitern, dass sie sich nicht
            // protokollieren ließ. Siehe Kopf von service/audit.ts.
            console.error("[audit] Anmeldung nicht protokolliert:", fehler);
          }
        },
      },
    },
  },

  /**
   * Fehlgeschlagene Anmeldungen und Rollenwechsel auf Organisationsebene.
   *
   * Diese beiden gehen nur hier: Mitgliederverwaltung läuft vollständig über
   * die Endpunkte des `organization`-Plugins (`/api/auth/organization/*`) und
   * kommt nie an unseren eigenen Routern vorbei. Der Nachlauf-Hook ist der
   * einzige Punkt, an dem prowiki davon erfährt.
   *
   * `ctx.context.returned` ist bei einem abgewiesenen Aufruf der `APIError` —
   * daran hängt die Unterscheidung zwischen „Rolle geändert" und „Versuch,
   * eine Rolle zu ändern, abgelehnt". Protokolliert wird der Fehlschlag nur
   * bei der Anmeldung: dort ist die Reihe der Versuche das Signal. Eine
   * abgelehnte Rollenänderung hat nichts geändert und gehört nicht in ein
   * Protokoll, das Änderungen nachweisen soll.
   */
  hooks: {
    /**
     * Alles hierin ist Protokoll, nichts davon ist die eigentliche Arbeit —
     * und dieser Hook läuft auf **jeder** Auth-Route, auch auf `/get-session`,
     * das die Oberfläche laufend aufruft. Ein Nachlauf-Hook, der wirft, reißt
     * die Route mit, an der er hängt; das wären hier Anmeldung und
     * Sitzungsprüfung. Ein Fehler beim Protokollieren darf niemanden
     * aussperren, deshalb fängt der ganze Block selbst ab.
     */
    after: createAuthMiddleware(async (ctx) => {
      try {
        const gescheitert = isAPIError(ctx.context.returned);
        const körper = (ctx.body ?? {}) as Record<string, unknown>;
        const text = (wert: unknown): string | null =>
          typeof wert === "string" && wert.length > 0 ? wert : null;

        if (ctx.path === "/sign-in/email") {
          // Der Erfolg steht bereits über den Sitzungs-Hook im Protokoll.
          if (!gescheitert) return;
          await protokolliere({
            action: AUDIT.anmeldungFehlgeschlagen,
            actorEmail: text(körper.email),
            details: {
              grund:
                (ctx.context.returned as { message?: string } | undefined)
                  ?.message ?? "unbekannt",
            },
            ...herkunft(ctx.headers ?? new Headers()),
          });
          return;
        }

        // Pfad zuerst, Sitzung danach: bei jedem anderen Aufruf ist hier
        // Schluss, ohne dass irgendetwas angefasst wurde.
        if (
          ctx.path !== "/organization/update-member-role" &&
          ctx.path !== "/organization/remove-member"
        ) {
          return;
        }
        // Ein abgewiesener Versuch hat nichts geändert und gehört nicht in ein
        // Protokoll, das Änderungen nachweisen soll.
        if (gescheitert) return;

        const sitzung = ctx.context.session;
        if (!sitzung?.user) return;
        const gemeinsam = {
          organizationId:
            text(körper.organizationId) ??
            text(sitzung.session?.activeOrganizationId),
          actorId: sitzung.user.id,
          actorEmail: sitzung.user.email,
          targetType: "member",
          ...herkunft(ctx.headers ?? new Headers()),
        };

        if (ctx.path === "/organization/update-member-role") {
          await protokolliere({
            ...gemeinsam,
            action: AUDIT.orgRolleGeändert,
            targetId: text(körper.memberId),
            details: { rolle: körper.role },
          });
          return;
        }

        await protokolliere({
          ...gemeinsam,
          action: AUDIT.orgMitgliedEntfernt,
          targetId: text(körper.memberIdOrEmail),
        });
      } catch (fehler) {
        console.error("[audit] Auth-Ereignis nicht protokolliert:", fehler);
      }
    }),
  },

  advanced: {
    // httpOnly-Cookie statt Token im localStorage (Befund 2.8): ein Wiki rendert
    // fremdes Markdown, XSS ist damit ein reales Risiko und ein auslesbares
    // Token die falsche Ablage.
    useSecureCookies,
    // `secure` muss hier **noch einmal** stehen. `defaultCookieAttributes`
    // ersetzt die Vorgaben, statt sie zu ergänzen — ohne diese Zeile gewinnt das
    // Objekt gegen `useSecureCookies`, und der Sitzungscookie geht ohne
    // Secure-Flag raus. Am 16. August live nachgemessen: NODE_ENV stand auf
    // production, der Set-Cookie-Header lautete trotzdem
    // `HttpOnly; SameSite=Lax` — ohne `Secure`.
    defaultCookieAttributes: {
      sameSite: "lax",
      httpOnly: true,
      secure: useSecureCookies,
    },
  },

  rateLimit: {
    // Gilt für alle Auth-Routen; /sign-in ist zusätzlich enger gefasst, weil
    // knora dort gar kein Limit hatte (Befund 2.4).
    enabled: true,
    window: 60,
    max: 30,
    customRules: {
      "/sign-in/email": { window: 60, max: 5 },
      "/sign-up/email": { window: 3600, max: 5 },
      "/forget-password": { window: 3600, max: 5 },
    },
  },

  plugins: [
    organization({
      ac,
      roles,
      creatorRole: "owner",
      // Jede Selbstregistrierung soll ihre eigene Organisation betreiben können.
      // Der Deckel verhindert nur das massenhafte Anlegen durch Bots.
      organizationLimit: 5,
      membershipLimit: 100,
      invitationExpiresIn: 60 * 60 * 48,
      async sendInvitationEmail(data) {
        const url = `${BASE_URL}/accept-invitation/${data.id}`;
        console.log(`[auth] Einladung an ${data.email} (${data.role}): ${url}`);
      },
    }),
  ],
});

export type Auth = typeof auth;
export type AuthSession = typeof auth.$Infer.Session;

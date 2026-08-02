/**
 * Tabellen, die Better Auth verwaltet (Kern + organization-Plugin).
 *
 * Diese Datei ist an das Better-Auth-Schema gebunden: Spaltennamen und -typen
 * müssen zu dem passen, was der Adapter erwartet. Nach einem Update von
 * better-auth mit `bunx @better-auth/cli generate` gegengeprüft werden — nicht
 * von Hand raten.
 *
 * IDs sind `text`, nicht `serial`. Das ist Better-Auth-Vorgabe und zugleich
 * richtig: fortlaufende Nutzer-IDs verraten die Nutzerzahl und laden zum
 * Durchprobieren ein.
 */
import {
  pgTable,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    // Der Grund, warum Sitzungen überhaupt in der Datenbank stehen: ein Token
    // hier zu löschen beendet die Sitzung sofort. Bei knoras zustandslosem JWT
    // galt ein abgegriffenes Token sieben Tage weiter (Befund 2.2).
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    // bcrypt/scrypt-Hash bei E-Mail+Passwort; null bei OAuth-Konten.
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// --- organization-Plugin ---------------------------------------------------

/**
 * Die Mandanten- und Abrechnungsgrenze: ein Kanal, eine Redaktion, eine Agentur.
 * knora kannte diese Ebene nicht — dort gehörte ein Workspace einer Person
 * (`created_by`), womit weder Teams noch Eigentumsübertragung noch Abrechnung
 * abbildbar waren (Befund 2.6).
 */
export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // owner | admin | editor | author | reviewer | viewer — die Bündel aus
    // auth/permissions.ts. Kein Constraint, weil Better Auth den Wert schreibt;
    // unbekannte Werte fallen in resolveAccess() auf "kein Zugriff" zurück.
    role: text("role").notNull().default("viewer"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("member_org_user_unique").on(t.organizationId, t.userId),
    index("member_user_idx").on(t.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at").notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("invitation_email_idx").on(t.email)],
);

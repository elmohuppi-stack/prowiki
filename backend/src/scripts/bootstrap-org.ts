#!/usr/bin/env bun
/**
 * Legt eine Organisation an und macht einen **bereits registrierten** Nutzer zu
 * ihrem Inhaber. Optional gleich ein erstes Wiki dazu.
 *
 * Ersetzt knoras `db/seed.ts`. Das legte einen Admin mit `ADMIN_PASSWORD ??
 * "admin123"` an — Zugangsdaten aus einer Umgebungsvariablen mit Default im
 * Repository, und die dazugehörige Rolle `admin` galt global über alles
 * (Befund 2.1 in docs/KONZEPT.md).
 *
 * Hier gibt es das nicht: Konten entstehen ausschließlich über die reguläre
 * Registrierung samt E-Mail-Verifikation. Dieses Skript vergibt nur
 * Mitgliedschaft — es kann kein Konto erzeugen und kein Passwort setzen.
 *
 * Aufruf:
 *   bun run src/scripts/bootstrap-org.ts --email you@example.com \
 *     --org "Basta Berlin" [--slug basta-berlin] [--wiki "Archiv"] [--dry-run]
 */
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.ts";
import { user, organization, member, wikis } from "../db/schema.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dryRun = process.argv.includes("--dry-run");
const email = arg("email");
const orgName = arg("org");
const wikiName = arg("wiki");

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function main() {
  if (!email || !orgName) {
    console.error(
      'Aufruf: --email <adresse> --org "<Name>" [--slug <slug>] [--wiki "<Name>"] [--dry-run]',
    );
    process.exit(1);
  }

  const orgSlug = arg("slug") ?? slugify(orgName);

  const [owner] = await db
    .select({ id: user.id, email: user.email, verified: user.emailVerified })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  if (!owner) {
    console.error(
      `❌ Kein Konto für ${email}. Erst regulär registrieren — dieses Skript legt bewusst keine Konten an.`,
    );
    process.exit(1);
  }
  if (!owner.verified) {
    // Kein harter Abbruch: in der Entwicklung steht der Verifikationslink im
    // Log, und eine halbfertige Registrierung soll den Bootstrap nicht blocken.
    console.warn(`⚠️  ${email} ist noch nicht verifiziert — Login schlägt bis dahin fehl.`);
  }

  const [existingOrg] = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, orgSlug))
    .limit(1);

  if (existingOrg) {
    console.error(`❌ Organisation mit Slug "${orgSlug}" existiert bereits.`);
    process.exit(1);
  }

  const orgId = crypto.randomUUID();
  const wikiId = crypto.randomUUID();

  console.log(`Organisation : ${orgName} (${orgSlug})`);
  console.log(`Inhaber      : ${owner.email}`);
  if (wikiName) console.log(`Wiki         : ${wikiName} (${slugify(wikiName)}, private)`);

  if (dryRun) {
    console.log("\n(DRY-RUN — nichts geschrieben)");
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    await tx.insert(organization).values({
      id: orgId,
      name: orgName,
      slug: orgSlug,
    });

    await tx.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: owner.id,
      role: "owner",
    });

    if (wikiName) {
      await tx.insert(wikis).values({
        id: wikiId,
        organization_id: orgId,
        slug: slugify(wikiName),
        name: wikiName,
        // Neue Wikis sind privat. Öffentlich wird bewusst geschaltet, nicht
        // aus Versehen geerbt.
        visibility: "private",
        created_by: owner.id,
      });
    }
  });

  console.log(`\n✅ Angelegt. Organisation ${orgId}`);
  if (wikiName) console.log(`   Wiki ${wikiId}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Bootstrap fehlgeschlagen:", err);
  process.exit(1);
});

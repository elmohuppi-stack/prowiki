import { db } from "./index.ts";
import { users } from "./schema.ts";
import bcrypt from "bcryptjs";

async function seed() {
  console.log("🌱 Seeding database...");

  const email = process.env.ADMIN_EMAIL ?? "admin@knora.app";
  const password = process.env.ADMIN_PASSWORD ?? "admin123";
  const name = process.env.ADMIN_NAME ?? "Admin";

  const password_hash = await bcrypt.hash(password, 12);

  const [admin] = await db
    .insert(users)
    .values({
      email,
      password_hash,
      name,
      role: "admin",
    })
    .onConflictDoNothing()
    .returning();

  if (admin) {
    console.log(`✅ Created admin user: ${admin.email}`);
  } else {
    console.log(`ℹ️  Admin user already exists (${email})`);
  }

  console.log("🌱 Seed complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed!", err);
  process.exit(1);
});

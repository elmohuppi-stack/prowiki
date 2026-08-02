// Migrator passend zum Treiber: `db` ist über `drizzle-orm/node-postgres`
// gebaut (pg.Pool). Der Import aus `postgres-js` stand hier aus knora und
// passte nie zum Pool — aufgefallen ist es nicht, weil in der Praxis
// `drizzle-kit migrate` benutzt wird (package.json: db:migrate).
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./index.ts";

async function main() {
  console.log("Running migrations...");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations complete!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed!", err);
  process.exit(1);
});

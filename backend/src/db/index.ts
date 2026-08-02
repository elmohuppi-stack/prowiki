import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

const connectionString = process.env.DATABASE_URL!;

const pool = new Pool({
  connectionString,
  // Höher als die Zahl paralleler Hintergrund-Tasks (Chunking, Embedding,
  // Wiki-Generierung) + Frontend-Polling, damit Lese-Requests nicht hinter
  // dem Import verhungern und die UI responsiv bleibt.
  max: 20,
  idleTimeoutMillis: 30000,
  // Großzügiger, damit kurzzeitige Lastspitzen nicht sofort in
  // Connection-Timeouts umschlagen.
  connectionTimeoutMillis: 10000,
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;

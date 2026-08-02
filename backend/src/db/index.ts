import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

const connectionString = process.env.DATABASE_URL!;

/**
 * Pool-Obergrenze. Gilt pro Prozess — API und Worker zählen getrennt.
 *
 * Auf einer geteilten Postgres-Instanz ist das ein Budget, kein Wunsch:
 * `max_connections` liegt dort bei 100 für alle Apps zusammen, und `work_mem`
 * fällt pro Verbindung und Sortierknoten an. Der Leitfaden des Servers
 * (optimize-hetzner/ARCHITEKTUR.md 4.2) gibt einer neuen App 5–10 und sagt:
 * erst messen, dann erhöhen. Ein ORM ohne Konfiguration öffnet sonst so viele
 * Verbindungen wie Worker-Threads, und bei drei Apps mit dieser Haltung fallen
 * alle gleichzeitig aus.
 *
 * Deshalb konfigurierbar statt fest verdrahtet: lokal und auf eigener Instanz
 * darf der Wert höher stehen als auf `pg-shared`.
 */
const poolMax = Number(process.env.DB_POOL_MAX ?? 10);

const pool = new Pool({
  connectionString,
  max: poolMax,
  idleTimeoutMillis: 30000,
  // Großzügiger, damit kurzzeitige Lastspitzen nicht sofort in
  // Connection-Timeouts umschlagen.
  connectionTimeoutMillis: 10000,
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;

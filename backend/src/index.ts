import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import { auth, trustedOrigins } from "./auth/index.ts";
import { sessionMiddleware } from "./middleware/auth.ts";
import { wikisRouter } from "./router/wikis.ts";
import { userRouter } from "./router/user.ts";
import { modelRouter } from "./router/model.ts";
import { documentRouter } from "./router/document.ts";
import { searchRouter } from "./router/search.ts";
import { chatRouter } from "./router/chat.ts";
import { pageRouter } from "./router/page.ts";
import { topicRouter } from "./router/topic.ts";
import { activityRouter } from "./router/activity.ts";

const app = new Hono();

/**
 * CORS mit Herkunftsliste statt `origin: "*"`.
 *
 * knora stand auf `*`. Mit einem Bearer-Token im localStorage war das nicht
 * direkt ausnutzbar, weil der Browser das Token nicht selbst mitschickt — aber
 * prowiki nutzt httpOnly-Cookies, und `credentials: true` ist zusammen mit `*`
 * schlicht nicht erlaubt. Die Liste kommt aus TRUSTED_ORIGINS; Kundendomänen
 * kommen in Stufe 2 dazu.
 */
app.use(
  "/*",
  cors({
    origin: (origin) => (trustedOrigins.includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length"],
    credentials: true,
    maxAge: 86400,
  }),
);

/**
 * Health — prüft die Datenbankverbindung mit. Ein Endpunkt, der nur "ok" sagt,
 * meldet auch dann Gesundheit, wenn die App keine Anfrage mehr beantworten
 * kann: beim Umzug auf die gemeinsame Postgres-Instanz lieferte knora eine
 * Minute lang 500er, während /health weiter "ok" meldete. Der Docker-Healthcheck
 * hängt hier dran und wäre sonst wertlos.
 *
 * Ohne Auth erreichbar, damit nginx und Docker ihn abfragen können.
 */
app.get("/health", async (c) => {
  try {
    await db.execute(sql`select 1`);
    return c.json({ status: "ok", db: "ok" });
  } catch (err) {
    console.error("[health] Datenbank nicht erreichbar:", err);
    return c.json({ status: "degraded", db: "unreachable" }, 503);
  }
});

/**
 * Better Auth bedient Registrierung, Login, Verifikation, Passwort-Reset,
 * Sitzungen und die Organisationsverwaltung selbst. Muss VOR der
 * Session-Middleware stehen: diese Routen erzeugen die Sitzung erst.
 */
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

/**
 * Ab hier trägt jeder Request einen `principal` — angemeldet oder anonym.
 * Bewusst nicht blockierend: öffentliche Wikis müssen ohne Anmeldung lesbar
 * sein, die Entscheidung fällt in der Capability-Prüfung (middleware/access.ts).
 */
app.use("/api/v1/*", sessionMiddleware);

app.route("/api/v1/wikis", wikisRouter);
app.route("/api/v1/users", userRouter);
app.route("/api/v1/orgs", modelRouter);
app.route("/api/v1/documents", documentRouter);
app.route("/api/v1/search", searchRouter);
app.route("/api/v1/chat", chatRouter);
app.route("/api/v1/pages", pageRouter);
app.route("/api/v1/topics", topicRouter);
app.route("/api/v1/activity", activityRouter);

const port = parseInt(process.env.PORT || "3000");

// Bun-Default für maxRequestBodySize ist 128 MB – zu klein für große
// Dokument-Uploads. Muss zum client_max_body_size im nginx passen.
const maxUploadMb = parseInt(process.env.MAX_UPLOAD_MB || "512");

console.log(`🚀 prowiki API auf Port ${port} (max Upload ${maxUploadMb} MB)`);

Bun.serve({
  port,
  maxRequestBodySize: maxUploadMb * 1024 * 1024,
  fetch: app.fetch,
});

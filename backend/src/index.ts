import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import { authRouter } from "./router/auth.ts";
import { workspaceRouter } from "./router/workspace.ts";
import { adminRouter } from "./router/admin.ts";
import { userRouter } from "./router/user.ts";
import { modelRouter } from "./router/model.ts";
import { documentRouter } from "./router/document.ts";
import { searchRouter } from "./router/search.ts";
import { chatRouter } from "./router/chat.ts";
import { wikiRouter } from "./router/wiki.ts";
import { topicRouter } from "./router/topic.ts";
import { activityRouter } from "./router/activity.ts";

const app = new Hono();

app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length"],
    maxAge: 86400,
  }),
);

// Health – prüft bewusst die Datenbankverbindung mit. Ein Endpunkt, der nur
// "ok" zurückgibt, meldet auch dann Gesundheit, wenn die App keine einzige
// Anfrage mehr beantworten kann: Beim Umzug auf die gemeinsame Postgres-Instanz
// lieferte knora eine Minute lang 500er, während /health weiter "ok" sagte.
// Der Docker-Healthcheck hängt an diesem Endpunkt und wäre sonst wertlos.
app.get("/health", async (c) => {
  try {
    await db.execute(sql`select 1`);
    return c.json({ status: "ok", db: "ok" });
  } catch (err) {
    console.error("[health] Datenbank nicht erreichbar:", err);
    return c.json({ status: "degraded", db: "unreachable" }, 503);
  }
});

// Auth Routes
app.route("/api/v1/auth", authRouter);

// Workspace Routes
app.route("/api/v1/workspaces", workspaceRouter);

// Admin Routes (User-Management)
app.route("/api/v1/admin", adminRouter);

// User Routes (schlanke Liste für Auswahlfelder)
app.route("/api/v1/users", userRouter);

// Model Provider Routes
app.route("/api/v1/models", modelRouter);

// Document Routes (Upload, Import)
app.route("/api/v1/documents", documentRouter);

// Search Routes (Hybrid Search)
app.route("/api/v1/search", searchRouter);

// Chat Routes (RAG Chat)
app.route("/api/v1/chat", chatRouter);

// Wiki Routes
app.route("/api/v1/wiki", wikiRouter);

// Topic Routes (Themen pro Workspace, Ebene 1)
app.route("/api/v1/topics", topicRouter);

// Activity-Log Routes (für eingeloggte User, workspace-gefiltert)
app.route("/api/v1/activity", activityRouter);

// Future routes will be added here:
// app.route("/api/v1/users", userRouter);
// app.route("/api/v1/workspaces", workspaceRouter);
// app.route("/api/v1/documents", documentRouter);
// app.route("/api/v1/wiki", wikiRouter);
// app.route("/api/v1/chat", chatRouter);
// app.route("/api/v1/models", modelRouter);
// app.route("/api/v1/search", searchRouter);

const port = parseInt(process.env.PORT || "3000");

// Bun-Default für maxRequestBodySize ist 128 MB – zu klein für große Dokument-
// Uploads (z.B. mehrhundert-MB-PDFs). Über MAX_UPLOAD_MB konfigurierbar, Default
// 512 MB. Muss zum client_max_body_size im nginx (frontend/nginx.conf) passen.
const maxUploadMb = parseInt(process.env.MAX_UPLOAD_MB || "512");

console.log(`🚀 Wiki-Chat API running on port ${port} (max upload ${maxUploadMb} MB)`);

Bun.serve({
  port,
  maxRequestBodySize: maxUploadMb * 1024 * 1024,
  fetch: app.fetch,
});

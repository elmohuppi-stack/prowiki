import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { authMiddleware } from "../middleware/auth.ts";
import { assertWorkspaceAccess } from "../middleware/workspace-access.ts";
import { hybridSearch } from "../service/search.ts";
import { db } from "../db/index.ts";
import { chatSessions, chatMessages, modelProviders } from "../db/schema.ts";
import { eq, desc, and } from "drizzle-orm";
import { streamText, createTextStreamResponse } from "ai";
import { openai } from "@ai-sdk/openai";

const chatRouter = new Hono();
chatRouter.use("*", authMiddleware);

const chatSchema = z.object({
  workspace_id: z.string().uuid().optional(),
  message: z.string().min(1),
  session_id: z.string().uuid().optional(),
});

// Session helper
async function getOrCreateSession(
  userId: number,
  workspaceId: string | undefined,
  message: string,
  sessionId: string | undefined,
) {
  if (sessionId) {
    const sessions = await db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    if (sessions[0]) return sessions[0];
  }

  const [newSession] = await db
    .insert(chatSessions)
    .values({
      id: crypto.randomUUID(),
      workspace_id: workspaceId || null,
      user_id: userId,
      title: message.slice(0, 80),
    })
    .returning();
  return newSession;
}

// Bisherigen Gesprächsverlauf der Session laden (chronologisch, gedeckelt).
// Wird VOR dem Speichern der aktuellen User-Nachricht aufgerufen, enthält sie
// also noch nicht.
async function loadHistory(
  sessionId: string,
  limit = 20,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const rows = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(eq(chatMessages.session_id, sessionId))
    .orderBy(desc(chatMessages.created_at))
    .limit(limit);
  return rows
    .reverse()
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

// Aktiven LLM-Provider laden
async function getActiveProvider() {
  let providers = await db
    .select()
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.is_active, true),
        eq(modelProviders.provider_type, "chat"),
      ),
    )
    .limit(1);

  if (!providers[0]) {
    providers = await db
      .select()
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.is_active, true),
          eq(modelProviders.provider_type, "both"),
        ),
      )
      .limit(1);
  }
  return providers[0] || null;
}

// System-Prompt bauen. Weiches Grounding: der Workspace-Kontext wird bevorzugt
// genutzt, wenn er zur Frage passt – ansonsten antwortet das Modell mit seinem
// eigenen Wissen, statt zu verweigern. (Frühere strikte Variante blockierte
// Themen, die nicht in der Wissensdatenbank stehen.)
function buildSystemPrompt(context: string): string {
  if (!context)
    return "Du bist ein hilfreicher Assistent. Antworte auf Deutsch.";
  return `Du bist ein hilfreicher Assistent mit Zugriff auf eine Wissensdatenbank.
Antworte auf Deutsch. Nutze den folgenden Kontext, wenn er zur Frage passt, und
weise dann darauf hin. Passt der Kontext nicht oder reicht er nicht aus, nutze
dein eigenes Wissen und beantworte die Frage trotzdem. Erfinde keine Fakten.

Jeder Kontext-Abschnitt beginnt mit seiner Quelle in eckigen Klammern. Nenne
diese Quelle wörtlich hinter jeder Aussage, die du daraus übernimmst
(z.B. „[2020-03-04 · Krisenstab]"). Ohne diese Angabe ist die Antwort nicht
überprüfbar.

KONTEXT:
${context}`;
}

/**
 * Anzahl der Chunks für den RAG-Kontext. Der frühere Festwert 5 war für einen
 * Bestand aus wenigen Dokumenten gedacht; bei mehreren hundert Dokumenten und
 * größeren Chunks reicht das nicht, um eine Frage über mehrere Sitzungen hinweg
 * zu beantworten.
 */
const CHAT_TOP_K = parseInt(process.env.CHAT_TOP_K || "12");

// Nicht-streaming Chat-Nachricht senden (für History-Kompatibilität)
chatRouter.post("/", zValidator("json", chatSchema), async (c) => {
  const user = c.get("user");
  const { workspace_id, message, session_id } = c.req.valid("json");
  // Ohne workspace_id chattet der User über "Alle Workspaces" – dann greift
  // keine Suche und es gibt nichts zu prüfen.
  if (workspace_id) {
    await assertWorkspaceAccess(user, workspace_id, "read");
  }

  const session = await getOrCreateSession(
    user.id,
    workspace_id,
    message,
    session_id,
  );

  // Bisherigen Verlauf laden, BEVOR die aktuelle Nachricht gespeichert wird.
  const history = await loadHistory(session.id);

  // User-Nachricht speichern
  await db.insert(chatMessages).values({
    id: crypto.randomUUID(),
    session_id: session.id,
    role: "user",
    content: message,
  });

  // RAG: Suche nach relevanten Chunks
  let searchResults: any[] = [];
  if (workspace_id) {
    searchResults = await hybridSearch(workspace_id, message, CHAT_TOP_K);
  }

  const context = searchResults
    .map((r) => `[${r.document_title}]: ${r.content}`)
    .join("\n\n");

  const provider = await getActiveProvider();

  let reply = "";
  if (provider) {
    reply = await callLLM(provider, message, context, history);
  } else {
    reply =
      "Kein Chat-Provider konfiguriert. Bitte im Admin einen Provider anlegen.";
  }

  const [assistantMsg] = await db
    .insert(chatMessages)
    .values({
      id: crypto.randomUUID(),
      session_id: session.id,
      role: "assistant",
      content: reply,
      knowledge_refs: searchResults.map((r) => ({
        chunk_id: r.chunk_id,
        document_title: r.document_title,
        score: r.score,
      })),
    })
    .returning();

  return c.json({
    session_id: session.id,
    message: {
      id: assistantMsg.id,
      role: "assistant",
      content: reply,
      knowledge_refs: assistantMsg.knowledge_refs,
    },
    sources: searchResults.map((r) => ({
      title: r.document_title,
      score: r.score,
    })),
  });
});

// Streaming Chat-Endpunkt (SSE)
chatRouter.post("/stream", zValidator("json", chatSchema), async (c) => {
  const user = c.get("user");
  const { workspace_id, message, session_id } = c.req.valid("json");
  if (workspace_id) {
    await assertWorkspaceAccess(user, workspace_id, "read");
  }

  const session = await getOrCreateSession(
    user.id,
    workspace_id,
    message,
    session_id,
  );

  // Bisherigen Verlauf laden, BEVOR die aktuelle Nachricht gespeichert wird.
  const history = await loadHistory(session.id);

  // User-Nachricht speichern
  const userMsgId = crypto.randomUUID();
  await db.insert(chatMessages).values({
    id: userMsgId,
    session_id: session.id,
    role: "user",
    content: message,
  });

  // RAG: Suche nach relevanten Chunks
  let searchResults: any[] = [];
  if (workspace_id) {
    searchResults = await hybridSearch(workspace_id, message, CHAT_TOP_K);
  }

  const context = searchResults
    .map((r) => `[${r.document_title}]: ${r.content}`)
    .join("\n\n");

  const provider = await getActiveProvider();

  if (!provider) {
    return c.json({
      session_id: session.id,
      message: {
        id: crypto.randomUUID(),
        role: "assistant",
        content:
          "Kein Chat-Provider konfiguriert. Bitte im Admin einen Provider anlegen.",
        knowledge_refs: [],
      },
      sources: [],
    });
  }

  // Stream mit rohem fetch (OpenAI-kompatibel)
  const systemPrompt = buildSystemPrompt(context);

  const response = await fetch(`${provider.api_base_url}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.api_key_encrypted}`,
    },
    body: JSON.stringify({
      model: provider.default_model,
      stream: true,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: message },
      ],
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    return c.json({
      session_id: session.id,
      message: {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `❌ API-Fehler (${response.status}): ${errText.slice(0, 200)}`,
        knowledge_refs: [],
      },
      sources: [],
    });
  }

  // SSE-Stream parsen und als Text-Stream ausgeben
  let fullReply = "";
  const { readable, writable } = new TransformStream<string, string>({
    transform(chunk, controller) {
      fullReply += chunk;
      controller.enqueue(chunk);
    },
    flush() {
      db.insert(chatMessages)
        .values({
          id: crypto.randomUUID(),
          session_id: session.id,
          role: "assistant",
          content: fullReply,
          knowledge_refs: searchResults.map((r) => ({
            chunk_id: r.chunk_id,
            document_title: r.document_title,
            score: r.score,
          })),
        })
        .then(() =>
          // Session-Zeitstempel für Recency-Sortierung der Historie aktualisieren
          db
            .update(chatSessions)
            .set({ updated_at: new Date() })
            .where(eq(chatSessions.id, session.id)),
        )
        .catch(console.error);
    },
  });

  // SSE-Datenstrom parsen: "data: {...}" → Text extrahieren
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const textWriter = writable.getWriter();

  if (reader) {
    (async () => {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const json = JSON.parse(data);
                const delta =
                  json.choices?.[0]?.delta?.content ||
                  json.choices?.[0]?.text ||
                  "";
                if (delta) textWriter.write(delta);
              } catch {
                // JSON-Parse-Fehler ignorieren
              }
            }
          }
        }
      } finally {
        textWriter.close();
      }
    })();
  } else {
    textWriter.close();
  }

  return createTextStreamResponse({
    stream: readable,
    headers: {
      "X-Session-Id": session.id,
      // encodeURIComponent, damit non-Latin-1-Zeichen (z.B. „ ") den HTTP-Header nicht sprengen
      "X-Sources": encodeURIComponent(
        JSON.stringify(
          searchResults.map((r) => ({
            title: r.document_title,
            score: r.score,
          })),
        ),
      ),
    },
  });
});

// Sessions auflisten
chatRouter.get("/sessions", async (c) => {
  const user = c.get("user");
  const sessions = await db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.user_id, user.id))
    .orderBy(desc(chatSessions.updated_at))
    .limit(50);
  return c.json({ sessions });
});

// Messages einer Session. Nur eigene Sessions – sonst wären fremde Chats über
// eine geratene Session-ID lesbar.
chatRouter.get("/sessions/:id/messages", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const [session] = await db
    .select({ user_id: chatSessions.user_id })
    .from(chatSessions)
    .where(eq(chatSessions.id, id))
    .limit(1);
  if (!session) return c.json({ error: "Session not found" }, 404);
  if (session.user_id !== user.id) return c.json({ error: "Forbidden" }, 403);

  const msgs = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.session_id, id))
    .orderBy(chatMessages.created_at);
  return c.json({ messages: msgs });
});

// Session löschen (inkl. Nachrichten). Nur eigene Sessions.
chatRouter.delete("/sessions/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const [session] = await db
    .select({ id: chatSessions.id, user_id: chatSessions.user_id })
    .from(chatSessions)
    .where(eq(chatSessions.id, id))
    .limit(1);

  if (!session) return c.json({ error: "Session not found" }, 404);
  if (session.user_id !== user.id) return c.json({ error: "Forbidden" }, 403);

  // Erst Nachrichten (FK), dann Session.
  await db.delete(chatMessages).where(eq(chatMessages.session_id, id));
  await db.delete(chatSessions).where(eq(chatSessions.id, id));

  return c.json({ deleted: true });
});

async function callLLM(
  provider: typeof modelProviders.$inferSelect,
  message: string,
  context: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
): Promise<string> {
  const systemPrompt = context
    ? `Du bist ein hilfreicher Assistent mit Zugriff auf eine Wissensdatenbank.
Antworte auf Deutsch. Nutze den folgenden Kontext, wenn er zur Frage passt, und
weise dann darauf hin. Passt der Kontext nicht oder reicht er nicht aus, nutze
dein eigenes Wissen und beantworte die Frage trotzdem. Erfinde keine Fakten.

KONTEXT:
${context}`
    : "Du bist ein hilfreicher Assistent. Antworte auf Deutsch.";

  try {
    const response = await fetch(`${provider.api_base_url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.api_key_encrypted}`,
      },
      body: JSON.stringify({
        model: provider.default_model,
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "user", content: message },
        ],
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!response.ok) {
      const errText = await response.text();
      return `❌ API-Fehler (${response.status}): ${errText.slice(0, 200)}`;
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content || "❌ Leere Antwort vom LLM";
  } catch (e: any) {
    return `❌ Fehler bei der LLM-Anfrage: ${e.message}`;
  }
}

export { chatRouter };

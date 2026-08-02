<template>
  <main class="chat-layout">
    <!-- Backdrop für den mobilen History-Drawer -->
    <div
      v-if="historyOpen"
      class="chat-sidebar-backdrop"
      @click="historyOpen = false"
    ></div>

    <!-- Historie-Sidebar -->
    <aside class="chat-sidebar" :class="{ open: historyOpen }">
      <button class="new-chat-btn" @click="newChat">
        <span>＋</span> Neuer Chat
      </button>

      <div class="session-list">
        <div v-if="sessions.length === 0" class="session-empty">
          Noch keine Unterhaltungen.
        </div>
        <template v-for="group in groupedSessions" :key="group.label">
          <div v-if="group.sessions.length" class="session-group-label">
            {{ group.label }}
          </div>
          <div
            v-for="s in group.sessions"
            :key="s.id"
            :class="['session-row', { active: s.id === sessionId }]"
          >
            <button
              class="session-item"
              @click="openSession(s)"
              :title="s.title || 'Unterhaltung'"
            >
              {{ s.title || "Unterhaltung" }}
            </button>
            <button
              class="session-delete"
              @click.stop="deleteSession(s)"
              title="Unterhaltung löschen"
            >
              <i class="pi pi-trash"></i>
            </button>
          </div>
        </template>
      </div>
    </aside>

    <!-- Chat-Bereich -->
    <section class="chat-main">
      <div class="chat-header">
        <button
          class="history-toggle"
          @click="historyOpen = true"
          title="Verlauf"
        >
          <i class="pi pi-bars"></i>
        </button>
        <h3>Chat</h3>
        <button
          class="article-btn"
          :disabled="!canGenerateArticle"
          :title="
            canGenerateArticle
              ? 'Artikel-Verbund aus diesem Gespräch erzeugen'
              : 'Wähle einen Workspace und führe zuerst ein Gespräch'
          "
          @click="openArticleDialog"
        >
          <i class="pi pi-book"></i>
          <span>Artikel-Verbund</span>
        </button>
      </div>

      <div class="messages" ref="messagesRef">
        <div v-if="messages.length === 0" class="empty-state">
          <p>Starte eine Unterhaltung mit deinem Wiki-Wissen.</p>
        </div>
        <div
          v-for="msg in messages"
          :key="msg.id"
          :class="['message', msg.role]"
        >
          <div class="avatar">
            <i
              v-if="msg.id === streamingId"
              class="pi pi-spin pi-spinner avatar-spin"
            ></i>
            <template v-else>{{ msg.role === "user" ? "👤" : "🤖" }}</template>
          </div>
          <div class="bubble">
            <!-- Phase 1: noch kein Text – „denkt nach" mit pulsierenden Punkten -->
            <div v-if="msg.id === streamingId && !msg.content" class="thinking">
              <span class="dots"><span></span><span></span><span></span></span>
              <span class="thinking-label">KI denkt nach …</span>
            </div>
            <!-- Phase 2: Text streamt (mit „schreibt …"-Hinweis) -->
            <template v-else>
              <div v-html="renderMarkdown(msg.content)"></div>
              <div v-if="msg.id === streamingId" class="writing-hint">
                <span class="pulse-dot"></span> KI schreibt …
              </div>
            </template>
            <div v-if="msg.knowledge_refs?.length" class="refs">
              <small>Quellen: {{ msg.knowledge_refs.length }} Chunks</small>
            </div>
          </div>
        </div>
      </div>

      <div class="input-bar">
        <select v-model="workspaceId" class="ws-select">
          <option value="">— Alle Workspaces —</option>
          <option v-for="ws in workspaces" :key="ws.id" :value="ws.id">
            {{ ws.name }}
          </option>
        </select>
        <textarea
          ref="inputRef"
          v-model="input"
          @keydown.enter.exact.prevent="sendMessage"
          @input="autoGrow"
          rows="1"
          placeholder="Nachricht eingeben..."
          class="msg-input"
          :disabled="isStreaming"
        ></textarea>
        <button
          @click="sendMessage"
          :disabled="!input.trim() || isStreaming"
          class="send-btn"
        >
          Senden
        </button>
      </div>
    </section>

    <!-- Dialog: Artikel-Verbund aus dem Gespräch -->
    <div v-if="articleDialog" class="modal-overlay" @click.self="articleDialog = false">
      <div class="modal">
        <h3>Artikel-Verbund erzeugen</h3>
        <p class="modal-sub">
          Aus dem aktuellen Gespräch wird ein Hauptartikel mit verlinkten
          Unterartikeln (Entwurf) erstellt.
        </p>

        <label class="fld">
          <span>Zielgruppe</span>
          <input v-model="spec.audience" placeholder="z.B. Schüler der Mittelstufe" />
        </label>
        <label class="fld">
          <span>Stil / Sprache</span>
          <input v-model="spec.style" placeholder="z.B. einfache, anschauliche Sprache" />
        </label>
        <label class="fld">
          <span>Max. Themen-Artikel (Concepts)</span>
          <input type="number" min="0" max="12" v-model.number="spec.max_subpages" />
        </label>
        <label class="fld">
          <span>Max. Begriffs-Artikel (Entities: Personen, Orte, Begriffe)</span>
          <input type="number" min="0" max="30" v-model.number="spec.max_entities" />
        </label>
        <label class="fld">
          <span>Zusätzliche Anweisungen (optional)</span>
          <textarea
            v-model="spec.instructions"
            rows="3"
            placeholder="z.B. Fokus auf wirtschaftliche Folgen und die Rolle einzelner Personen"
          ></textarea>
        </label>
        <label class="fld-check">
          <input type="checkbox" v-model="spec.use_rag" />
          <span>Workspace-Dokumente als Kontext nutzen (RAG)</span>
        </label>
        <p class="fld-hint">
          Wenn aktiv, werden vorhandene Dokumente dieses Workspace durchsucht und
          passende Stellen als Quelle einbezogen. Bei leerem Workspace ohne
          Wirkung – dann aus lassen.
        </p>

        <div class="modal-actions">
          <button class="btn-secondary" @click="articleDialog = false">
            Abbrechen
          </button>
          <button class="btn-primary" :disabled="generating" @click="generateArticleCluster">
            {{ generating ? "Starte …" : "Erzeugen" }}
          </button>
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="showConfirm"
      :options="confirmOptions"
      :on-confirm="onConfirm"
      :on-cancel="onCancel"
    />
  </main>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import { useConfirm } from "../../composables/useConfirm";
import ConfirmModal from "../../components/ConfirmModal.vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import axios from "axios";

const auth = useAuthStore();
const router = useRouter();
const {
  show: showConfirm,
  options: confirmOptions,
  ask: askConfirm,
  onConfirm,
  onCancel,
} = useConfirm();
const messages = ref<any[]>([]);
const input = ref("");
const inputRef = ref<HTMLTextAreaElement>();
// ID der Assistant-Nachricht, die gerade gestreamt wird (für Typing-Indikator).
const streamingId = ref<string | null>(null);

// Textarea an den Inhalt anpassen (mitwachsend bis zu einer Maximalhöhe).
function autoGrow() {
  const el = inputRef.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}
function resetInputHeight() {
  const el = inputRef.value;
  if (el) el.style.height = "auto";
}
const workspaceId = ref("");
const workspaces = ref<any[]>([]);
const isStreaming = ref(false);
const messagesRef = ref<HTMLDivElement>();
const sessions = ref<any[]>([]);
const sessionId = ref<string | null>(null);
// Steuert den ausklappbaren Verlauf-Drawer auf dem Handy
const historyOpen = ref(false);

onMounted(() => {
  if (!auth.isAuthenticated) {
    router.push("/login");
    return;
  }
  loadWorkspaces();
  loadSessions();
});

async function loadWorkspaces() {
  try {
    const res = await axios.get("/api/v1/workspaces");
    workspaces.value = res.data.workspaces;
    // Zuletzt verwendeten Workspace vorauswählen (analog zum Workspace-Tab)
    const last = localStorage.getItem("lastWorkspaceId");
    if (last && workspaces.value.some((w: any) => w.id === last)) {
      workspaceId.value = last;
    }
  } catch {}
}

// Auswahl im Chat ebenfalls als "zuletzt verwendet" merken
watch(workspaceId, (v) => {
  if (v) localStorage.setItem("lastWorkspaceId", v);
});

async function loadSessions() {
  try {
    const res = await axios.get("/api/v1/chat/sessions");
    sessions.value = res.data.sessions || [];
  } catch {}
}

// Sessions nach Aktualität gruppieren (Heute / Letzte 30 Tage / Älter)
const groupedSessions = computed(() => {
  const now = Date.now();
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const groups: Record<string, any[]> = { today: [], month: [], older: [] };
  for (const s of sessions.value) {
    const t = new Date(s.updated_at || s.created_at).getTime();
    if (t >= startOfToday) groups.today.push(s);
    else if (now - t < 30 * 24 * 3600 * 1000) groups.month.push(s);
    else groups.older.push(s);
  }
  return [
    { label: "Heute", sessions: groups.today },
    { label: "Letzte 30 Tage", sessions: groups.month },
    { label: "Älter", sessions: groups.older },
  ];
});

function newChat() {
  sessionId.value = null;
  messages.value = [];
  input.value = "";
  historyOpen.value = false;
}

async function openSession(s: any) {
  if (isStreaming.value) return;
  historyOpen.value = false;
  sessionId.value = s.id;
  if (s.workspace_id) workspaceId.value = s.workspace_id;
  try {
    const res = await axios.get(`/api/v1/chat/sessions/${s.id}/messages`);
    messages.value = (res.data.messages || []).map((m: any) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      knowledge_refs: m.knowledge_refs || [],
    }));
    scrollToBottom();
  } catch {}
}

async function deleteSession(s: any) {
  const ok = await askConfirm({
    title: "Unterhaltung löschen?",
    message: `„${s.title || "Unterhaltung"}" wird endgültig gelöscht. Das kann nicht rückgängig gemacht werden.`,
    confirmText: "Löschen",
    danger: true,
  });
  if (!ok) return;
  try {
    await axios.delete(`/api/v1/chat/sessions/${s.id}`);
    sessions.value = sessions.value.filter((x: any) => x.id !== s.id);
    // War es die gerade offene Unterhaltung? Dann Ansicht leeren.
    if (sessionId.value === s.id) {
      sessionId.value = null;
      messages.value = [];
    }
  } catch (e: any) {
    alert("Löschen fehlgeschlagen: " + (e?.message || e));
  }
}

function renderMarkdown(text: string) {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

function scrollToBottom() {
  setTimeout(() => {
    messagesRef.value?.scrollTo({
      top: messagesRef.value.scrollHeight,
      behavior: "smooth",
    });
  }, 50);
}

async function sendMessage() {
  if (!input.value.trim() || isStreaming.value) return;

  const userMsg = {
    id: crypto.randomUUID(),
    role: "user",
    content: input.value,
    knowledge_refs: [],
  };
  messages.value.push(userMsg);
  const query = input.value;
  input.value = "";
  resetInputHeight();
  isStreaming.value = true;

  // Streaming-Assistant-Nachricht vorbereiten
  const assistantMsg = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: "",
    knowledge_refs: [],
  };
  messages.value.push(assistantMsg);
  streamingId.value = assistantMsg.id;

  try {
    const res = await fetch("/api/v1/chat/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      },
      body: JSON.stringify({
        workspace_id: workspaceId.value || undefined,
        message: query,
        session_id: sessionId.value || undefined,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(err);
    }

    // Session-ID aus Header lesen (bei neuer Session gesetzt)
    const returnedSession = res.headers.get("X-Session-Id");
    if (returnedSession) sessionId.value = returnedSession;

    // SSE-Stream lesen
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        assistantMsg.content += text;
        // Scrollen bei jedem Chunk
        messagesRef.value?.scrollTo({
          top: messagesRef.value.scrollHeight,
          behavior: "smooth",
        });
      }
    }
  } catch (e: any) {
    assistantMsg.content = "❌ Fehler bei der Anfrage: " + e.message;
  } finally {
    isStreaming.value = false;
    streamingId.value = null;
    scrollToBottom();
    // Sidebar aktualisieren: neue Session einfügen bzw. Reihenfolge auffrischen
    loadSessions();
  }
}

// --- Artikel-Verbund aus dem Gespräch ---
const articleDialog = ref(false);
const generating = ref(false);
const spec = ref<{
  audience: string;
  style: string;
  max_subpages: number;
  max_entities: number;
  instructions: string;
  use_rag: boolean;
}>({
  audience: "Interessierter Laie (kein Experte)",
  style: "anschauliche, verständliche Sprache in Prosa, keine Stichpunkte",
  max_subpages: 5,
  max_entities: 12,
  instructions: "",
  use_rag: false,
});

// Nur möglich, wenn ein Workspace gewählt ist und ein Gespräch existiert.
const canGenerateArticle = computed(
  () => !!workspaceId.value && !!sessionId.value && messages.value.length > 0,
);

function openArticleDialog() {
  if (!canGenerateArticle.value) return;
  articleDialog.value = true;
}

async function generateArticleCluster() {
  if (!canGenerateArticle.value || generating.value) return;
  generating.value = true;
  try {
    const res = await axios.post(`/api/v1/wiki/${workspaceId.value}/from-chat`, {
      session_id: sessionId.value,
      audience: spec.value.audience || undefined,
      style: spec.value.style || undefined,
      max_subpages: spec.value.max_subpages,
      max_entities: spec.value.max_entities,
      instructions: spec.value.instructions || undefined,
      use_rag: spec.value.use_rag,
    });
    const clusterId = res.data.cluster_id;
    articleDialog.value = false;
    router.push(`/workspaces/${workspaceId.value}/wiki-review/${clusterId}`);
  } catch (e: any) {
    alert("Fehler beim Starten der Generierung: " + (e?.message || e));
  } finally {
    generating.value = false;
  }
}
</script>

<style scoped>
.chat-layout {
  /* Feste Höhe (statt mitwachsend), damit nur die Nachrichtenliste scrollt und
     die Eingabeleiste immer unten sichtbar bleibt. */
  height: 100%;
  flex: 1;
  display: flex;
  min-height: 0;
}

/* Historie-Sidebar */
.chat-sidebar {
  width: 240px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  background: var(--color-bg-secondary);
}

.new-chat-btn {
  margin: 0.75rem;
  padding: 0.6rem 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: var(--color-primary);
  color: #fff;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 600;
}
.new-chat-btn span {
  font-size: 1.1rem;
  line-height: 1;
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 0.5rem 0.75rem;
}

.session-empty {
  padding: 1rem 0.75rem;
  color: var(--color-text-secondary);
  font-size: 0.85rem;
}

.session-group-label {
  padding: 0.75rem 0.5rem 0.25rem;
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--color-text-secondary);
}

.session-row {
  display: flex;
  align-items: center;
  border-radius: 6px;
  margin-bottom: 0.1rem;
}
.session-row:hover {
  background: var(--color-border);
}
.session-row.active {
  background: var(--color-primary);
}
.session-row.active .session-item {
  color: #fff;
}
.session-item {
  flex: 1;
  min-width: 0;
  text-align: left;
  padding: 0.5rem;
  background: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-delete {
  flex-shrink: 0;
  visibility: hidden;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.4rem 0.5rem;
  border-radius: 6px;
  color: var(--color-text);
  opacity: 0.7;
  font-size: 0.85rem;
}
.session-row:hover .session-delete {
  visibility: visible;
}
.session-delete:hover {
  opacity: 1;
  color: #ef4444;
}
.session-row.active .session-delete {
  visibility: visible;
  color: #fff;
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chat-header {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

/* Artikel-Verbund-Button (rechts im Header) */
.article-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.8rem;
  border: 1px solid var(--color-primary);
  background: none;
  color: var(--color-primary);
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.88rem;
  font-weight: 600;
}
.article-btn:hover:not(:disabled) {
  background: var(--color-primary);
  color: #fff;
}
.article-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* Modal: Artikel-Verbund-Spec */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 1rem;
}
.modal {
  background: var(--color-bg, #fff);
  color: var(--color-text, #111);
  border-radius: 12px;
  padding: 1.5rem;
  width: 100%;
  max-width: 620px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
}
.modal h3 {
  margin: 0 0 0.25rem;
}
.modal-sub {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  color: var(--color-text-muted, #6b7280);
}
.fld {
  display: block;
  margin-bottom: 0.85rem;
}
.fld > span {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  margin-bottom: 0.3rem;
}
.fld input,
.fld textarea {
  width: 100%;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--color-border, #d1d5db);
  border-radius: 6px;
  font: inherit;
  background: var(--color-bg-secondary, #f9fafb);
  color: inherit;
  box-sizing: border-box;
}
.fld-check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.88rem;
  margin-bottom: 0.35rem;
}
.fld-hint {
  margin: 0 0 1rem;
  font-size: 0.78rem;
  line-height: 1.4;
  color: var(--color-text-muted, #6b7280);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
.modal-actions .btn-primary,
.modal-actions .btn-secondary {
  padding: 0.55rem 1rem;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  border: 1px solid var(--color-border, #d1d5db);
}
.modal-actions .btn-primary {
  background: var(--color-primary);
  color: #fff;
  border-color: transparent;
}
.modal-actions .btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.modal-actions .btn-secondary {
  background: var(--color-bg-secondary, #f3f4f6);
  color: var(--color-text, #111);
}

/* Verlauf-Toggle + Backdrop: nur auf dem Handy sichtbar */
.history-toggle {
  display: none;
  background: none;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 0.35rem 0.55rem;
  font-size: 1.1rem;
  line-height: 1;
  color: var(--color-text);
}
.chat-sidebar-backdrop {
  display: none;
}

.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 1.5rem;
}

.empty-state {
  text-align: center;
  padding: 4rem 2rem;
  color: var(--color-text-secondary);
}

.message {
  display: flex;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}

.avatar {
  font-size: 1.5rem;
  line-height: 1;
}

.bubble {
  max-width: 70%;
  padding: 0.75rem 1rem;
  border-radius: 12px;
  background: var(--color-bg-secondary);
  line-height: 1.5;
}

.message.user {
  flex-direction: row-reverse;
}

.message.user .bubble {
  background: var(--color-primary);
  color: white;
}

.refs {
  margin-top: 0.5rem;
  opacity: 0.6;
}

/* Spinner im Avatar während des Streamens */
.avatar-spin {
  font-size: 1.1rem;
  color: var(--color-primary);
}

/* Phase 1: „KI denkt nach …" mit pulsierenden Punkten */
.thinking {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.thinking-label {
  color: var(--color-text-secondary, #6b7280);
  font-size: 0.9rem;
}
.dots {
  display: inline-flex;
  gap: 0.25rem;
}
.dots span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-primary);
  opacity: 0.4;
  animation: dot-bounce 1.2s infinite ease-in-out both;
}
.dots span:nth-child(1) {
  animation-delay: -0.24s;
}
.dots span:nth-child(2) {
  animation-delay: -0.12s;
}
@keyframes dot-bounce {
  0%,
  80%,
  100% {
    transform: translateY(0);
    opacity: 0.4;
  }
  40% {
    transform: translateY(-5px);
    opacity: 1;
  }
}

/* Phase 2: Text streamt – dezenter „schreibt …"-Hinweis */
.writing-hint {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.4rem;
  font-size: 0.8rem;
  color: var(--color-text-secondary, #6b7280);
}
.pulse-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
  animation: pulse 1s infinite ease-in-out;
}
@keyframes pulse {
  0%,
  100% {
    transform: scale(0.7);
    opacity: 0.5;
  }
  50% {
    transform: scale(1);
    opacity: 1;
  }
}

.input-bar {
  display: flex;
  gap: 0.5rem;
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--color-border);
  align-items: flex-end;
}

.ws-select {
  padding: 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.875rem;
}

.msg-input {
  flex: 1;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 1rem;
  font-family: inherit;
  line-height: 1.4;
  resize: none;
  overflow-y: auto;
  max-height: 200px;
  min-height: 2.6rem;
  box-sizing: border-box;
}

.msg-input:focus {
  outline: none;
  border-color: var(--color-primary);
}

.send-btn {
  padding: 0.625rem 1.25rem;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  /* Verlauf als einschiebbarer Drawer statt fester Spalte */
  .history-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .chat-sidebar {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 60;
    width: 80vw;
    max-width: 320px;
    transform: translateX(-100%);
    transition: transform 0.2s ease;
    box-shadow: 2px 0 12px rgba(0, 0, 0, 0.2);
  }
  .chat-sidebar.open {
    transform: translateX(0);
  }
  .chat-sidebar-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 55;
    background: rgba(0, 0, 0, 0.4);
  }

  .chat-header {
    padding: 0.75rem 1rem;
  }
  .messages {
    padding: 0.75rem 1rem;
  }
  .bubble {
    max-width: 85%;
  }
  .input-bar {
    flex-wrap: wrap;
    padding: 0.6rem 0.75rem;
    padding-bottom: calc(0.6rem + env(safe-area-inset-bottom, 0px));
  }
  .ws-select {
    order: -1;
    width: 100%;
  }
  .msg-input {
    flex: 1;
    min-width: 0;
  }
}
</style>

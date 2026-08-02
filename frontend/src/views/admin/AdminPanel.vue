<template>
  <main class="main-content">
    <!-- Tabs -->
    <div class="tabs">
      <button
        :class="['tab', { active: tab === 'users' }]"
        @click="tab = 'users'"
      >
        👥 Benutzer
      </button>
      <button
        :class="['tab', { active: tab === 'models' }]"
        @click="tab = 'models'"
      >
        🤖 Model-Provider
      </button>
      <button
        :class="['tab', { active: tab === 'logs' }]"
        @click="
          tab = 'logs';
          loadLogs();
        "
      >
        📋 Aktivitäten
      </button>
    </div>

    <!-- User Management -->
    <div v-if="tab === 'users'" class="content">
      <div class="section-header">
        <h3>👥 Benutzer</h3>
        <button class="btn-primary" @click="openCreateUser">+ Neu</button>
      </div>
      <table class="table" v-if="users.length">
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>E-Mail</th>
            <th>Rolle</th>
            <th>Erstellt</th>
            <th>Aktion</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>{{ u.id }}</td>
            <td>{{ u.name }}</td>
            <td>{{ u.email }}</td>
            <td>
              <select
                v-model="u.role"
                @change="updateRole(u)"
                :disabled="u.id === auth.user?.id"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="admin">Admin</option>
              </select>
            </td>
            <td>{{ formatDate(u.created_at) }}</td>
            <td>
              <button
                class="btn-danger-sm"
                @click="deleteUser(u)"
                :disabled="u.id === auth.user?.id"
              >
                ✕
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty">Lade Benutzer...</p>

      <!-- Create User Dialog -->
      <div
        v-if="showCreateUser"
        class="dialog-overlay"
        @click.self="showCreateUser = false"
      >
        <div class="dialog">
          <h3>Neuen Benutzer anlegen</h3>
          <div class="field">
            <label>Name *</label>
            <input v-model="userForm.name" placeholder="z.B. Anna Muster" />
          </div>
          <div class="field">
            <label>E-Mail *</label>
            <input
              v-model="userForm.email"
              type="email"
              autocomplete="off"
              placeholder="anna@example.com"
            />
          </div>
          <div class="field">
            <label>Passwort * (min. 8 Zeichen)</label>
            <input
              v-model="userForm.password"
              type="password"
              autocomplete="new-password"
              placeholder="••••••••"
            />
          </div>
          <div class="field">
            <label>Rolle *</label>
            <select v-model="userForm.role">
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div class="dialog-actions">
            <button class="btn-secondary" @click="showCreateUser = false">
              Abbrechen
            </button>
            <button
              class="btn-primary"
              @click="createUser"
              :disabled="!canCreateUser || creatingUser"
            >
              {{ creatingUser ? "Speichert..." : "Anlegen" }}
            </button>
          </div>
          <p v-if="createUserError" class="error">{{ createUserError }}</p>
        </div>
      </div>
    </div>

    <!-- Model Provider Management -->
    <div v-if="tab === 'models'" class="content">
      <div class="section-header">
        <h3>🤖 Model-Provider</h3>
        <button class="btn-primary" @click="showCreate = true">+ Neu</button>
      </div>

      <div v-if="providers.length" class="provider-list">
        <div v-for="p in providers" :key="p.id" class="provider-card">
          <div class="provider-info">
            <strong>{{ p.name }}</strong>
            <span class="provider-type">{{ p.provider_type }}</span>
            <span class="provider-model">{{ p.default_model }}</span>
            <span class="provider-url">{{ p.api_base_url }}</span>
            <span class="provider-key">🔑 {{ p.api_key_preview }}</span>
          </div>
          <div class="provider-actions">
            <span
              :class="['status-dot', p.is_active ? 'active' : 'inactive']"
            ></span>
            <button class="btn-danger-sm" @click="deleteProvider(p.id)">
              ✕
            </button>
          </div>
        </div>
      </div>
      <p v-else class="empty">Noch keine Provider konfiguriert.</p>

      <!-- Create Provider Dialog -->
      <div
        v-if="showCreate"
        class="dialog-overlay"
        @click.self="showCreate = false"
      >
        <div class="dialog">
          <h3>Neuen Model-Provider erstellen</h3>
          <div class="field">
            <label>Name *</label>
            <input v-model="form.name" placeholder="z.B. OpenAI, DeepSeek" />
          </div>
          <div class="field">
            <label>Typ *</label>
            <select v-model="form.provider_type">
              <option value="chat">Chat</option>
              <option value="embedding">Embedding</option>
              <option value="both">Beides</option>
            </select>
          </div>
          <div class="field">
            <label>API Base URL *</label>
            <input
              v-model="form.api_base_url"
              placeholder="https://api.openai.com/v1"
            />
          </div>
          <div class="field">
            <label>API Key *</label>
            <input
              v-model="form.api_key"
              type="password"
              placeholder="sk-..."
            />
          </div>
          <div class="field">
            <label>Default Model *</label>
            <input
              v-model="form.default_model"
              placeholder="gpt-4o, deepseek-chat"
            />
          </div>
          <div class="dialog-actions">
            <button class="btn-secondary" @click="showCreate = false">
              Abbrechen
            </button>
            <button
              class="btn-primary"
              @click="createProvider"
              :disabled="!form.name || !form.api_key"
            >
              Erstellen
            </button>
          </div>
          <p v-if="createError" class="error">{{ createError }}</p>
        </div>
      </div>
    </div>

    <!-- Activity Log -->
    <div v-if="tab === 'logs'" class="content">
      <div class="section-header">
        <h3>📋 Aktivitäten</h3>
        <button class="btn-secondary" @click="loadLogs">
          🔄 Aktualisieren
        </button>
      </div>

      <div class="log-filters">
        <select v-model="logFilter.action" @change="loadLogs">
          <option value="">Alle Aktionen</option>
          <option value="youtube_import">▶️ YouTube-Import</option>
          <option value="wiki_generate">📖 Wiki-Generierung</option>
        </select>
        <select v-model="logFilter.status" @change="loadLogs">
          <option value="">Alle Status</option>
          <option value="started">🔄 Gestartet</option>
          <option value="completed">✅ Erfolgreich</option>
          <option value="failed">❌ Fehlgeschlagen</option>
        </select>
      </div>

      <div v-if="logs.length === 0" class="empty">
        <p v-if="loadingLogs">Lade Aktivitäten...</p>
        <p v-else>
          Noch keine Aktivitäten. Führe einen YouTube-Import oder eine
          Wiki-Generierung durch.
        </p>
      </div>

      <div v-else class="log-list">
        <div
          v-for="log in logs"
          :key="log.id"
          class="log-entry"
          :class="log.status"
        >
          <div class="log-header">
            <span class="log-action"
              >{{ actionIcon(log.action) }} {{ log.action }}</span
            >
            <span class="log-status" :class="log.status">{{
              statusLabel(log.status)
            }}</span>
            <span class="log-time">{{ formatDateTime(log.created_at) }}</span>
          </div>
          <div class="log-message">{{ log.message }}</div>
          <div class="log-meta" v-if="log.duration_ms">
            ⏱️ {{ (log.duration_ms / 1000).toFixed(1) }}s
          </div>
          <div
            class="log-details"
            v-if="log.details && Object.keys(log.details).length"
          >
            <details>
              <summary>Details</summary>
              <pre>{{ JSON.stringify(log.details, null, 2) }}</pre>
            </details>
          </div>
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
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import { useConfirm } from "../../composables/useConfirm";
import ConfirmModal from "../../components/ConfirmModal.vue";
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
const tab = ref("users");
const users = ref<any[]>([]);
const providers = ref<any[]>([]);
const showCreate = ref(false);
const createError = ref("");
const form = ref({
  name: "",
  provider_type: "chat",
  api_base_url: "",
  api_key: "",
  default_model: "",
});

// Benutzer anlegen
const showCreateUser = ref(false);
const creatingUser = ref(false);
const createUserError = ref("");
const userForm = ref({
  name: "",
  email: "",
  password: "",
  role: "viewer",
});
const canCreateUser = computed(
  () =>
    userForm.value.name.trim().length > 0 &&
    /^\S+@\S+\.\S+$/.test(userForm.value.email.trim()) &&
    userForm.value.password.length >= 8,
);

// Activity Log
const logs = ref<any[]>([]);
const loadingLogs = ref(false);
const logFilter = ref({ action: "", status: "" });

onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.push("/login");
    return;
  }
  if (!auth.isAdmin) {
    router.push("/chat");
    return;
  }
  await loadUsers();
  await loadProviders();
});

async function loadUsers() {
  try {
    const res = await axios.get("/api/v1/admin/users");
    users.value = res.data.users || [];

    // .env-Admin (Elmo) zur Liste hinzufügen falls nicht in DB
    const envAdmin = auth.user;
    if (envAdmin && !users.value.find((u: any) => u.email === envAdmin.email)) {
      users.value.unshift({
        id: 0,
        name: envAdmin.name,
        email: envAdmin.email,
        role: "admin",
        created_at: new Date().toISOString(),
        _env: true, // Markierung für .env-User
      });
    }
  } catch (e: any) {
    console.error("Failed to load users", e);
  }
}

function openCreateUser() {
  createUserError.value = "";
  userForm.value = { name: "", email: "", password: "", role: "viewer" };
  showCreateUser.value = true;
}

async function createUser() {
  createUserError.value = "";
  creatingUser.value = true;
  try {
    const res = await axios.post("/api/v1/admin/users", {
      name: userForm.value.name.trim(),
      email: userForm.value.email.trim().toLowerCase(),
      password: userForm.value.password,
      role: userForm.value.role,
    });
    users.value.unshift(res.data.user);
    showCreateUser.value = false;
  } catch (e: any) {
    const msg = e.response?.data?.error;
    createUserError.value =
      msg === "Email already registered"
        ? "Diese E-Mail ist bereits registriert."
        : msg || "Fehler beim Anlegen";
  } finally {
    creatingUser.value = false;
  }
}

async function updateRole(u: any) {
  try {
    await axios.put(`/api/v1/admin/users/${u.id}/role`, { role: u.role });
  } catch {
    alert("Fehler beim Ändern der Rolle");
  }
}

async function deleteUser(u: any) {
  const ok = await askConfirm({
    title: "Benutzer löschen",
    message: `Soll der Benutzer „${u.name}” gelöscht werden?`,
    confirmText: "Löschen",
  });
  if (!ok) return;
  try {
    await axios.delete(`/api/v1/admin/users/${u.id}`);
    users.value = users.value.filter((x: any) => x.id !== u.id);
  } catch {
    alert("Fehler beim Löschen");
  }
}

async function loadProviders() {
  try {
    const res = await axios.get("/api/v1/models");
    providers.value = res.data.providers || [];
  } catch (e: any) {
    console.error("Failed to load providers", e);
  }
}

async function createProvider() {
  createError.value = "";
  try {
    const res = await axios.post("/api/v1/models", { ...form.value });
    providers.value.push(res.data.provider);
    showCreate.value = false;
    form.value = {
      name: "",
      provider_type: "chat",
      api_base_url: "",
      api_key: "",
      default_model: "",
    };
  } catch (e: any) {
    createError.value = e.response?.data?.error || "Fehler beim Erstellen";
  }
}

async function deleteProvider(id: string) {
  const ok = await askConfirm({
    title: "Provider löschen",
    message: "Soll dieser Model-Provider gelöscht werden?",
    confirmText: "Löschen",
  });
  if (!ok) return;
  try {
    await axios.delete(`/api/v1/models/${id}`);
    providers.value = providers.value.filter((p: any) => p.id !== id);
  } catch {
    alert("Fehler beim Löschen");
  }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatDateTime(dateStr: string) {
  return new Date(dateStr).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function actionIcon(action: string) {
  const icons: Record<string, string> = {
    youtube_import: "▶️",
    wiki_generate: "📖",
  };
  return icons[action] || "🔹";
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    started: "🔄 Gestartet",
    completed: "✅ Erfolgreich",
    failed: "❌ Fehlgeschlagen",
  };
  return map[status] || status;
}

async function loadLogs() {
  loadingLogs.value = true;
  try {
    const params: any = { limit: 50 };
    if (logFilter.value.action) params.action = logFilter.value.action;
    if (logFilter.value.status) params.status = logFilter.value.status;
    const res = await axios.get("/api/v1/admin/activity-logs", { params });
    logs.value = res.data.logs || [];
  } catch (e: any) {
    console.error("Failed to load logs", e);
  } finally {
    loadingLogs.value = false;
  }
}
</script>

<style scoped>
.main-content {
  flex: 1;
  overflow-y: auto;
}

.tabs {
  display: flex;
  border-bottom: 1px solid var(--color-border);
}
.tab {
  padding: 0.75rem 1.5rem;
  border: none;
  background: none;
  font-size: 0.9rem;
  cursor: pointer;
  color: var(--color-text);
  border-bottom: 2px solid transparent;
}
.tab.active {
  border-bottom-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: 500;
}

.content {
  padding: 1.5rem;
}
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.table {
  width: 100%;
  border-collapse: collapse;
}
.table th,
.table td {
  text-align: left;
  padding: 0.625rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
  font-size: 0.875rem;
}
.table th {
  font-weight: 600;
  color: var(--color-text-secondary);
  font-size: 0.8rem;
  text-transform: uppercase;
}
.table select {
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 0.875rem;
}

.provider-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.provider-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}
.provider-info {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.provider-info strong {
  min-width: 100px;
}
.provider-type,
.provider-model,
.provider-url,
.provider-key {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
}
.provider-type {
  background: var(--color-bg-secondary);
  padding: 0.125rem 0.5rem;
  border-radius: 4px;
}
.provider-url {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.status-dot.active {
  background: #4caf50;
}
.status-dot.inactive {
  background: #f44336;
}

.empty {
  color: var(--color-text-secondary);
  padding: 2rem 0;
}

/* Activity Log */
.log-filters {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.log-filters select {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.85rem;
}
.log-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.log-entry {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  background: white;
}
.log-entry.failed {
  border-left: 3px solid #ef4444;
}
.log-entry.completed {
  border-left: 3px solid #22c55e;
}
.log-entry.started {
  border-left: 3px solid #f59e0b;
}
.log-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.25rem;
}
.log-action {
  font-weight: 600;
  font-size: 0.85rem;
}
.log-status {
  font-size: 0.75rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  background: var(--color-bg-secondary);
}
.log-status.failed {
  color: #ef4444;
}
.log-status.completed {
  color: #22c55e;
}
.log-time {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin-left: auto;
}
.log-message {
  font-size: 0.85rem;
  color: var(--color-text);
  margin-bottom: 0.2rem;
}
.log-meta {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}
.log-details {
  margin-top: 0.3rem;
}
.log-details summary {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.log-details pre {
  font-size: 0.75rem;
  background: var(--color-bg-secondary);
  padding: 0.5rem;
  border-radius: 4px;
  overflow-x: auto;
  margin-top: 0.3rem;
}

.btn-primary {
  padding: 0.5rem 1rem;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
}
.btn-primary:disabled {
  opacity: 0.5;
}
.btn-secondary {
  padding: 0.5rem 1rem;
  background: var(--color-bg-secondary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.9rem;
  cursor: pointer;
}
.btn-danger-sm {
  padding: 0.25rem 0.5rem;
  background: none;
  border: 1px solid #f44336;
  color: #f44336;
  border-radius: 4px;
  font-size: 0.8rem;
  cursor: pointer;
}

.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  background: white;
  padding: 2rem;
  border-radius: 12px;
  width: 100%;
  max-width: 500px;
}
.dialog h3 {
  margin-bottom: 1rem;
}
.field {
  margin-bottom: 1rem;
}
.field label {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
  color: var(--color-text-secondary);
}
.field input,
.field select {
  width: 100%;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 1rem;
  font-family: inherit;
}
.dialog-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 1.5rem;
}
.error {
  color: #d32f2f;
  font-size: 0.875rem;
  margin-top: 0.5rem;
}

@media (max-width: 768px) {
  .tabs {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tab {
    padding: 0.7rem 1rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .content {
    padding: 1rem;
  }
  .section-header {
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .provider-card {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .dialog {
    width: calc(100vw - 2rem);
    max-width: calc(100vw - 2rem);
    padding: 1.25rem;
  }
}
</style>

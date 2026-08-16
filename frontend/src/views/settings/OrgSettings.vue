<template>
  <main class="main-content">
    <div class="header">
      <h3>⚙️ Einstellungen<span v-if="auth.activeOrg"> · {{ auth.activeOrg.name }}</span></h3>
    </div>

    <!--
      knora hatte hier eine globale Admin-Seite mit einem Reiter "Benutzer", auf
      dem der Betreiber Konten anlegte und Rollen setzte. Beides gibt es hier
      bewusst nicht: Konten entstehen über die Registrierung, Mitgliedschaft
      über Einladungen (Stufe 3). Diese Seite zeigt daher, was heute wirklich
      pro Organisation verwaltbar ist.
    -->
    <div v-if="!auth.can('settings.manage')" class="empty">
      <p>
        Für die Einstellungen dieser Organisation fehlt dir die Berechtigung
        <code>settings.manage</code>.
      </p>
    </div>

    <template v-else>
      <div class="tabs">
        <button
          :class="['tab', { active: tab === 'models' }]"
          @click="tab = 'models'"
        >
          🤖 Modelle
        </button>
        <button
          :class="['tab', { active: tab === 'members' }]"
          @click="tab = 'members'"
        >
          👥 Mitglieder
        </button>
      </div>

      <!-- ------------------------------------------------------ Modelle -->
      <div v-if="tab === 'models'" class="content">
        <div class="section-head">
          <p class="hint">
            Chat- und Embedding-Anbieter dieser Organisation. Der Schlüssel wird
            nur maskiert angezeigt — gespeichert ist er verschlüsselt und wird
            nie zurückgegeben.
          </p>
          <button class="btn-primary" @click="openCreate">+ Anbieter</button>
        </div>

        <div v-if="loadingModels" class="loading">Lade Anbieter …</div>
        <div v-else-if="providers.length === 0" class="empty">
          <p>Noch kein Modell-Anbieter hinterlegt.</p>
        </div>

        <table v-else class="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Typ</th>
              <th>Modell</th>
              <th>Schlüssel</th>
              <th>Aktiv</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in providers" :key="p.id">
              <td>
                <strong>{{ p.name }}</strong>
                <div class="sub">{{ p.api_base_url }}</div>
              </td>
              <td>{{ TYPE_LABELS[p.provider_type] ?? p.provider_type }}</td>
              <td>{{ p.default_model }}</td>
              <td><code>{{ p.api_key_preview }}</code></td>
              <td>
                <button
                  class="pill"
                  :class="p.is_active ? 'on' : 'off'"
                  @click="toggleActive(p)"
                >
                  {{ p.is_active ? "aktiv" : "inaktiv" }}
                </button>
              </td>
              <td class="right">
                <button class="btn-link" @click="openEdit(p)">Bearbeiten</button>
                <button class="btn-link danger" @click="removeProvider(p)">
                  Löschen
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="modelError" class="error">{{ modelError }}</p>
      </div>

      <!-- --------------------------------------------------- Mitglieder -->
      <div v-if="tab === 'members'" class="content">
        <p class="hint">
          Mitglieder dieser Organisation. Die Rolle bestimmt, was jemand in
          allen Wikis darf; einzelne Wikis können sie überschreiben. Einladen
          und Rollen ändern kommt mit dem Mailversand.
        </p>

        <div v-if="loadingMembers" class="loading">Lade Mitglieder …</div>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>E-Mail</th>
              <th>Rolle</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in members" :key="m.id">
              <td>
                <strong>{{ m.name }}</strong>
                <span v-if="m.id === auth.user?.id" class="sub"> (du)</span>
              </td>
              <td>{{ m.email }}</td>
              <td><span class="pill role">{{ m.role }}</span></td>
              <td class="right">
                <button
                  v-if="auth.can('member.delete') && m.id !== auth.user?.id"
                  class="btn-link danger"
                  @click="removeMember(m)"
                >
                  Entfernen
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="memberError" class="error">{{ memberError }}</p>
      </div>
    </template>

    <!-- ------------------------------------------------ Anbieter-Dialog -->
    <div v-if="showForm" class="dialog-overlay" @click.self="showForm = false">
      <div class="dialog">
        <h3>{{ editId ? "Anbieter bearbeiten" : "Neuer Anbieter" }}</h3>
        <div class="field">
          <label>Name *</label>
          <input v-model="form.name" placeholder="z.B. deepseek-chat" />
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
          <label>API-Basis-URL *</label>
          <input v-model="form.api_base_url" placeholder="https://api.deepseek.com" />
        </div>
        <div class="field">
          <label>Standardmodell *</label>
          <input v-model="form.default_model" placeholder="deepseek-chat" />
        </div>
        <div class="field">
          <label>
            API-Schlüssel {{ editId ? "" : "*" }}
          </label>
          <input
            v-model="form.api_key"
            type="password"
            :placeholder="editId ? 'Leer lassen, um ihn nicht zu ändern' : 'sk-…'"
          />
        </div>
        <div class="dialog-actions">
          <button class="btn-secondary" @click="showForm = false">
            Abbrechen
          </button>
          <button class="btn-primary" :disabled="!formValid" @click="saveProvider">
            Speichern
          </button>
        </div>
        <p v-if="formError" class="error">{{ formError }}</p>
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
import { ref, computed, watch, onMounted } from "vue";
import axios from "axios";
import { useAuthStore } from "../../stores/auth";
import { useConfirm } from "../../composables/useConfirm";
import { authClient } from "../../lib/auth-client";
import ConfirmModal from "../../components/ConfirmModal.vue";

const auth = useAuthStore();
const {
  show: showConfirm,
  options: confirmOptions,
  ask: askConfirm,
  onConfirm,
  onCancel,
} = useConfirm();

const TYPE_LABELS: Record<string, string> = {
  chat: "Chat",
  embedding: "Embedding",
  both: "Beides",
};

const tab = ref<"models" | "members">("models");

const providers = ref<any[]>([]);
const members = ref<any[]>([]);
const loadingModels = ref(true);
const loadingMembers = ref(true);
const modelError = ref("");
const memberError = ref("");

const orgId = computed(() => auth.activeOrgId);

const showForm = ref(false);
const editId = ref<string | null>(null);
const formError = ref("");
const form = ref({
  name: "",
  provider_type: "chat",
  api_base_url: "",
  default_model: "",
  api_key: "",
});

// Beim Bearbeiten darf der Schlüssel leer bleiben — dann wird er nicht ersetzt.
const formValid = computed(
  () =>
    form.value.name.trim() &&
    form.value.api_base_url.trim() &&
    form.value.default_model.trim() &&
    (editId.value || form.value.api_key.trim()),
);

onMounted(load);
// Beim Wechsel der aktiven Organisation neu laden — sonst zeigt die Seite
// weiter die Anbieter der vorherigen.
watch(orgId, load);

async function load() {
  if (!orgId.value || !auth.can("settings.manage")) {
    loadingModels.value = false;
    loadingMembers.value = false;
    return;
  }
  await Promise.all([loadProviders(), loadMembers()]);
}

async function loadProviders() {
  loadingModels.value = true;
  modelError.value = "";
  try {
    const res = await axios.get(`/api/v1/orgs/${orgId.value}/models`);
    providers.value = res.data.providers || [];
  } catch (e: any) {
    modelError.value = e.response?.data?.error || "Anbieter nicht ladbar";
  } finally {
    loadingModels.value = false;
  }
}

async function loadMembers() {
  loadingMembers.value = true;
  memberError.value = "";
  try {
    const res = await axios.get(`/api/v1/orgs/${orgId.value}/users`);
    members.value = res.data.users || [];
  } catch (e: any) {
    memberError.value = e.response?.data?.error || "Mitglieder nicht ladbar";
  } finally {
    loadingMembers.value = false;
  }
}

function openCreate() {
  editId.value = null;
  formError.value = "";
  form.value = {
    name: "",
    provider_type: "chat",
    api_base_url: "",
    default_model: "",
    api_key: "",
  };
  showForm.value = true;
}

function openEdit(p: any) {
  editId.value = p.id;
  formError.value = "";
  form.value = {
    name: p.name,
    provider_type: p.provider_type,
    api_base_url: p.api_base_url,
    default_model: p.default_model,
    api_key: "",
  };
  showForm.value = true;
}

async function saveProvider() {
  formError.value = "";
  const payload: Record<string, unknown> = {
    name: form.value.name.trim(),
    provider_type: form.value.provider_type,
    api_base_url: form.value.api_base_url.trim(),
    default_model: form.value.default_model.trim(),
  };
  if (form.value.api_key.trim()) payload.api_key = form.value.api_key.trim();

  try {
    if (editId.value) {
      await axios.put(`/api/v1/orgs/${orgId.value}/models/${editId.value}`, payload);
    } else {
      await axios.post(`/api/v1/orgs/${orgId.value}/models`, payload);
    }
    showForm.value = false;
    await loadProviders();
  } catch (e: any) {
    formError.value = e.response?.data?.error || "Speichern fehlgeschlagen";
  }
}

async function toggleActive(p: any) {
  try {
    await axios.put(`/api/v1/orgs/${orgId.value}/models/${p.id}`, {
      is_active: !p.is_active,
    });
    await loadProviders();
  } catch (e: any) {
    modelError.value = e.response?.data?.error || "Umschalten fehlgeschlagen";
  }
}

async function removeProvider(p: any) {
  const ok = await askConfirm({
    title: "Anbieter löschen",
    message: `"${p.name}" wirklich löschen? Wikis, die dieses Modell nutzen, verlieren ihre Zuordnung.`,
    confirmText: "Löschen",
  });
  if (!ok) return;
  try {
    await axios.delete(`/api/v1/orgs/${orgId.value}/models/${p.id}`);
    await loadProviders();
  } catch (e: any) {
    modelError.value = e.response?.data?.error || "Löschen fehlgeschlagen";
  }
}

/**
 * Mitglied entfernen läuft über Better Auth, nicht über einen eigenen
 * Endpunkt: das organization-Plugin verwaltet `member` und prüft dabei
 * dieselbe Access-Control-Definition wie das Backend.
 */
async function removeMember(m: any) {
  const ok = await askConfirm({
    title: "Mitglied entfernen",
    message: `${m.name} (${m.email}) aus der Organisation entfernen? Zugriff auf alle Wikis dieser Organisation endet sofort.`,
    confirmText: "Entfernen",
  });
  if (!ok) return;
  memberError.value = "";
  const { error } = await authClient.organization.removeMember({
    memberIdOrEmail: m.email,
    organizationId: orgId.value!,
  });
  if (error) {
    memberError.value = error.message ?? "Entfernen fehlgeschlagen";
    return;
  }
  await loadMembers();
}
</script>

<style scoped>
.main-content {
  flex: 1;
  overflow-y: auto;
}
.header {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0 1.5rem;
  border-bottom: 1px solid var(--color-border);
}
.tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 0.75rem 1rem;
  cursor: pointer;
  color: var(--color-text-secondary);
  font-size: 0.95rem;
}
.tab.active {
  color: var(--color-text);
  border-bottom-color: var(--color-primary);
  font-weight: 600;
}
.content {
  padding: 1.5rem;
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 1rem;
}
.hint {
  color: var(--color-text-secondary);
  font-size: 0.875rem;
  max-width: 60ch;
  margin-bottom: 1rem;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
}
.tbl th {
  text-align: left;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary);
  padding: 0.65rem 0.9rem;
  border-bottom: 1px solid var(--color-border);
}
.tbl td {
  padding: 0.75rem 0.9rem;
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}
.tbl tr:last-child td {
  border-bottom: none;
}
.tbl td.right {
  text-align: right;
  white-space: nowrap;
}
.sub {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}
.pill {
  font-size: 0.75rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  cursor: pointer;
}
.pill.on {
  border-color: #16a34a;
  color: #16a34a;
}
.pill.off {
  color: var(--color-text-secondary);
}
.pill.role {
  cursor: default;
}
.btn-link {
  background: none;
  border: none;
  color: var(--color-primary);
  cursor: pointer;
  padding: 0 0.35rem;
  font-size: 0.875rem;
}
.btn-link.danger {
  color: #dc2626;
}
.empty,
.loading {
  text-align: center;
  padding: 3rem 2rem;
  color: var(--color-text-secondary);
}
.error {
  color: #dc2626;
  margin-top: 0.75rem;
  font-size: 0.875rem;
}

/* Dialog — gleiche Form wie in WikiList.vue */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.dialog {
  background: var(--color-bg);
  border-radius: 10px;
  padding: 1.5rem;
  width: min(460px, 92vw);
}
.dialog h3 {
  margin-bottom: 1rem;
}
.field {
  margin-bottom: 0.9rem;
}
.field label {
  display: block;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  margin-bottom: 0.25rem;
}
.field input,
.field select {
  width: 100%;
  padding: 0.55rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1.25rem;
}
.btn-primary {
  background: var(--color-primary);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  cursor: pointer;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-secondary {
  background: var(--color-bg-secondary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 0.5rem 1rem;
  cursor: pointer;
}
</style>

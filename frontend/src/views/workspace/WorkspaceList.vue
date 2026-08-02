<template>
  <main class="main-content">
    <div class="header">
      <h3>📁 Workspaces</h3>
      <button class="btn-primary" @click="showCreate = true">+ Neu</button>
    </div>

    <div class="content">
      <div v-if="loading" class="loading">Lade Workspaces...</div>

      <div v-else-if="workspaces.length === 0" class="empty">
        <p>
          Noch keine Workspaces. Klicke auf <strong>+ Neu</strong> um deinen
          ersten zu erstellen.
        </p>
      </div>

      <div v-else class="ws-grid">
        <div
          v-for="ws in workspaces"
          :key="ws.id"
          class="ws-card"
          @click="$router.push('/documents/' + (ws.slug || ws.id))"
        >
          <h4>{{ ws.name }}</h4>
          <p v-if="ws.description" class="ws-desc">{{ ws.description }}</p>
          <div class="ws-meta">
            <span class="ws-badge" v-if="ws.indexing_strategy?.wiki_enabled"
              >📖 Wiki</span
            >
            <span class="ws-badge" v-if="ws.indexing_strategy?.vector_enabled"
              >🔍 Vector</span
            >
            <span class="ws-date">{{ formatDate(ws.created_at) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Dialog -->
    <div
      v-if="showCreate"
      class="dialog-overlay"
      @click.self="showCreate = false"
    >
      <div class="dialog">
        <h3>Neuen Workspace erstellen</h3>
        <div class="field">
          <label>Name *</label>
          <input v-model="newName" placeholder="z.B. Meine Wissensdatenbank" />
        </div>
        <div class="field">
          <label>Beschreibung</label>
          <textarea v-model="newDesc" placeholder="Optional"></textarea>
        </div>
        <div class="dialog-actions">
          <button class="btn-secondary" @click="showCreate = false">
            Abbrechen
          </button>
          <button
            class="btn-primary"
            @click="createWorkspace"
            :disabled="!newName.trim()"
          >
            Erstellen
          </button>
        </div>
        <p v-if="createError" class="error">{{ createError }}</p>
      </div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import axios from "axios";

const auth = useAuthStore();
const router = useRouter();
const workspaces = ref<any[]>([]);
const loading = ref(true);
const showCreate = ref(false);
const newName = ref("");
const newDesc = ref("");
const createError = ref("");

onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.push("/login");
    return;
  }
  await loadWorkspaces();
});

async function loadWorkspaces() {
  try {
    const res = await axios.get("/api/v1/workspaces");
    workspaces.value = res.data.workspaces || [];
  } catch (e: any) {
    console.error("Failed to load workspaces", e);
  } finally {
    loading.value = false;
  }
}

async function createWorkspace() {
  createError.value = "";
  try {
    const res = await axios.post("/api/v1/workspaces", {
      name: newName.value,
      description: newDesc.value || undefined,
    });
    workspaces.value.push(res.data.workspace);
    showCreate.value = false;
    newName.value = "";
    newDesc.value = "";
  } catch (e: any) {
    createError.value = e.response?.data?.error || "Fehler beim Erstellen";
  }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
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
.content {
  padding: 1.5rem;
}

.ws-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
}
.ws-card {
  background: white;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1.25rem;
  cursor: pointer;
  transition: box-shadow 0.2s;
}
.ws-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
.ws-card h4 {
  margin-bottom: 0.25rem;
}
.ws-desc {
  color: var(--color-text-secondary);
  font-size: 0.875rem;
  margin-bottom: 0.75rem;
}
.ws-meta {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.ws-badge {
  font-size: 0.75rem;
  padding: 0.125rem 0.5rem;
  background: var(--color-bg-secondary);
  border-radius: 4px;
}
.ws-date {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin-left: auto;
}
.empty {
  text-align: center;
  padding: 4rem 2rem;
  color: var(--color-text-secondary);
}
.loading {
  text-align: center;
  padding: 2rem;
  color: var(--color-text-secondary);
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
  max-width: 480px;
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
.field textarea {
  width: 100%;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 1rem;
  font-family: inherit;
}
.field textarea {
  min-height: 80px;
  resize: vertical;
}
.dialog-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 1.5rem;
}
.btn-primary {
  padding: 0.5rem 1rem;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
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
}
.error {
  color: #d32f2f;
  font-size: 0.875rem;
  margin-top: 0.5rem;
}

@media (max-width: 768px) {
  .header {
    padding: 0.75rem 1rem;
    gap: 0.6rem;
  }
  .content {
    padding: 1rem;
  }
  .ws-grid {
    /* Eine Spalte auf dem Handy */
    grid-template-columns: 1fr;
  }
  .dialog {
    min-width: 0;
    width: calc(100vw - 2rem);
    max-width: calc(100vw - 2rem);
  }
}
</style>

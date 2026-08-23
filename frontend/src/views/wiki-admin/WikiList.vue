<template>
  <main class="main-content">
    <div class="header">
      <h3>📁 Wikis</h3>
      <div class="header-actions">
        <label class="sort-label" for="wiki-sort">Sortierung</label>
        <select id="wiki-sort" v-model="sort" @change="onSortChange" class="sort-select">
          <option value="recent">Zuletzt verwendet</option>
          <option value="name">Name (A–Z)</option>
          <option value="created">Neueste zuerst</option>
          <option value="updated">Zuletzt geändert</option>
        </select>
        <button class="btn-primary" @click="showCreate = true">+ Neu</button>
      </div>
    </div>

    <div class="content">
      <div v-if="loading" class="loading">Lade Wikis...</div>

      <div v-else-if="wikis.length === 0" class="empty">
        <p>
          Noch keine Wikis. Klicke auf <strong>+ Neu</strong> um deinen
          ersten zu erstellen.
        </p>
      </div>

      <div v-else class="ws-grid">
        <div
          v-for="ws in wikis"
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
            <span class="ws-date" :title="dateTitle(ws)">{{
              dateLabel(ws)
            }}</span>
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
        <h3>Neuen Wiki erstellen</h3>
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
            @click="createWiki"
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
const wikis = ref<any[]>([]);
const loading = ref(true);
const showCreate = ref(false);
const newName = ref("");
const newDesc = ref("");
const createError = ref("");

/**
 * Die gewählte Sortierung überdauert den Seitenwechsel — wer einmal auf Name
 * umgestellt hat, will nicht bei jedem Aufruf zurückgesetzt werden. Vorgabe ist
 * „zuletzt verwendet"; sortiert wird im Backend (siehe service/wikis.ts).
 */
const SORT_KEY = "prowiki-wiki-sort";
const SORTS = ["recent", "name", "created", "updated"];
const gespeichert = localStorage.getItem(SORT_KEY) || "";
const sort = ref(SORTS.includes(gespeichert) ? gespeichert : "recent");

onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.push("/login");
    return;
  }
  await loadWikis();
});

async function onSortChange() {
  localStorage.setItem(SORT_KEY, sort.value);
  await loadWikis();
}

async function loadWikis() {
  try {
    const res = await axios.get("/api/v1/wikis", {
      params: { sort: sort.value },
    });
    wikis.value = res.data.wikis || [];
  } catch (e: any) {
    console.error("Failed to load wikis", e);
  } finally {
    loading.value = false;
  }
}

async function createWiki() {
  createError.value = "";
  /**
   * Die Organisation muss mit — sie steht nicht in der Sitzung, sondern in der
   * aktiven Auswahl (`activeOrgId`).
   *
   * Sie fehlte hier, und die Folge war ein roher ZodError im Dialog:
   * „organization_id Required". Das Backend war nie im Zweifel, welche
   * Organisation gemeint ist — es wollte sie nur genannt bekommen, weil ein
   * Nutzer in mehreren sein kann und ein Wiki dann in der falschen entstünde.
   */
  const orgId = auth.activeOrgId;
  if (!orgId) {
    createError.value =
      "Keine Organisation ausgewählt. Bitte die Seite neu laden und erneut versuchen.";
    return;
  }
  try {
    const res = await axios.post("/api/v1/wikis", {
      organization_id: orgId,
      name: newName.value,
      description: newDesc.value || undefined,
    });
    showCreate.value = false;
    newName.value = "";
    newDesc.value = "";
    // Neu laden statt anhängen: nur so steht der neue Eintrag an der Stelle,
    // die der gewählten Sortierung entspricht.
    await loadWikis();
  } catch (e: any) {
    // Der Validierungsfehler des Backends kommt als Objekt, nicht als Text.
    // Ohne diese Unterscheidung stand das rohe ZodError-JSON im Dialog.
    const fehler = e.response?.data?.error;
    createError.value =
      typeof fehler === "string" ? fehler : "Fehler beim Erstellen";
  }
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Das Datum auf der Karte zeigt, wonach gerade sortiert wird — sonst stünde in
 * der Reihenfolge „zuletzt verwendet" ein Erstelldatum, das die Reihenfolge
 * scheinbar widerlegt.
 */
function dateLabel(ws: any) {
  if (sort.value === "recent" && ws.last_opened_at) {
    return formatDate(ws.last_opened_at);
  }
  if (sort.value === "updated" && ws.updated_at) {
    return formatDate(ws.updated_at);
  }
  return formatDate(ws.created_at);
}

function dateTitle(ws: any) {
  if (sort.value === "recent") {
    return ws.last_opened_at
      ? `Zuletzt geöffnet: ${formatDate(ws.last_opened_at)}`
      : `Noch nie geöffnet · angelegt am ${formatDate(ws.created_at)}`;
  }
  if (sort.value === "updated") return `Zuletzt geändert`;
  return `Angelegt am ${formatDate(ws.created_at)}`;
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
.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.sort-label {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
}
.sort-select {
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: 0.85rem;
  font-family: inherit;
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
    flex-wrap: wrap;
  }
  /* Auf dem Handy fehlt für „Sortierung“ + Auswahl + Button die Breite —
     das Wort entfällt, die Auswahl bleibt beschriftet genug. */
  .sort-label {
    display: none;
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

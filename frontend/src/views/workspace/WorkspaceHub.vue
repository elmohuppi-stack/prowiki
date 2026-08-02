<template>
  <main class="hub-layout">
    <!-- Workspace Header -->
    <div class="hub-header">
      <div class="hub-header-left">
        <router-link to="/workspaces" class="back-link"
          >← Übersicht</router-link
        >
        <h3>{{ ws?.name || "Lädt..." }}</h3>
      </div>
      <div class="hub-header-actions">
        <select
          v-model="selectedWorkspaceId"
          @change="switchWorkspace"
          class="ws-switch"
        >
          <option v-for="w in allWorkspaces" :key="w.id" :value="w.id">
            {{ w.name }}
          </option>
        </select>
      </div>
    </div>

    <!-- Tab Bar -->
    <div class="hub-tabs">
      <router-link
        :to="`/workspaces/${workspaceId}/documents`"
        class="tab"
        :class="{ active: activeTab === 'documents' }"
        >📄 Dokumente</router-link
      >
      <router-link
        :to="`/workspaces/${workspaceId}/wiki`"
        class="tab"
        :class="{ active: activeTab === 'wiki' }"
        >📖 Wiki</router-link
      >
      <router-link
        :to="`/workspaces/${workspaceId}/graph`"
        class="tab"
        :class="{ active: activeTab === 'graph' }"
        >🕸️ Graph</router-link
      >
    </div>

    <!-- Tab Content via Router-View -->
    <div class="hub-content">
      <router-view />
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
import { ref, onMounted, computed } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import { useConfirm } from "../../composables/useConfirm";
import { useWorkspace } from "../../composables/useWorkspace";
import ConfirmModal from "../../components/ConfirmModal.vue";
import axios from "axios";

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const { isUUID } = useWorkspace();
const {
  show: showConfirm,
  options: confirmOptions,
  ask: askConfirm,
  onConfirm,
  onCancel,
} = useConfirm();

const workspaceId = computed(() => route.params.id as string);
const activeTab = computed(() => {
  const path = route.path;
  if (path.includes("/documents")) return "documents";
  if (path.includes("/wiki")) return "wiki";
  if (path.includes("/graph")) return "graph";
  return "documents";
});

const ws = ref<any>(null);
const allWorkspaces = ref<any[]>([]);
const selectedWorkspaceId = ref("");

onMounted(async () => {
  await Promise.all([loadCurrentWorkspace(), loadAllWorkspaces()]);
});

async function loadCurrentWorkspace() {
  try {
    // Der Route-Parameter kann eine UUID oder ein Slug sein (z.B. "politik").
    // Für Slugs den by-slug-Endpoint nutzen, sonst liefert /:id einen 404.
    const url = isUUID(workspaceId.value)
      ? `/api/v1/workspaces/${workspaceId.value}`
      : `/api/v1/workspaces/by-slug/${workspaceId.value}`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    const data = res.data.workspace;
    ws.value = data;
    // Dropdown-Auswahl auf die aufgelöste UUID setzen, damit sie in der Liste matcht.
    selectedWorkspaceId.value = data.id;
  } catch (e: any) {
    console.error("[hub] Fehler beim Laden des Workspace:", e.message);
  }
}

async function loadAllWorkspaces() {
  try {
    const res = await axios.get("/api/v1/workspaces", {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    allWorkspaces.value = res.data.workspaces || [];
    // Nur setzen, wenn loadCurrentWorkspace die UUID noch nicht aufgelöst hat.
    // Bei Slug-URLs matcht workspaceId sonst keinen Listeneintrag (Dropdown bliebe leer).
    if (!selectedWorkspaceId.value) {
      const match = allWorkspaces.value.find(
        (w: any) => w.id === workspaceId.value || w.slug === workspaceId.value,
      );
      selectedWorkspaceId.value = match?.id || workspaceId.value;
    }
  } catch (e: any) {
    console.error("[hub] Fehler beim Laden der Workspace-Liste:", e.message);
  }
}

function switchWorkspace() {
  if (
    selectedWorkspaceId.value &&
    selectedWorkspaceId.value !== workspaceId.value
  ) {
    localStorage.setItem("knora-last-workspace", selectedWorkspaceId.value);
    router.push(`/workspaces/${selectedWorkspaceId.value}/documents`);
  }
}

</script>

<style scoped>
.hub-layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.hub-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.hub-header-left {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.hub-header-left h3 {
  margin: 0;
  font-size: 1.25rem;
}

.hub-header-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.ws-switch {
  padding: 0.4rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.9rem;
  cursor: pointer;
  min-width: 150px;
}

.hub-tabs {
  display: flex;
  gap: 0;
  padding: 0 1.5rem;
  background: var(--color-bg);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.hub-tabs .tab {
  padding: 0.75rem 1.25rem;
  font-size: 0.925rem;
  color: var(--color-text-secondary);
  text-decoration: none;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
}

.hub-tabs .tab:hover {
  color: var(--color-text);
  background: var(--color-bg-secondary);
}

.hub-tabs .tab.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
  font-weight: 600;
}

.hub-content {
  flex: 1;
  overflow-y: auto;
}

.btn-icon {
  background: none;
  border: 1px solid var(--color-border);
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 1rem;
  text-decoration: none;
  color: var(--color-text);
}
.btn-icon:hover {
  background: var(--color-bg-secondary);
}

@media (max-width: 768px) {
  /* Alles in EINER Zeile: "← Übersicht" + Workspace-Select. Der h3-Titel ist
     mit der Select-Box redundant (zeigt denselben Namen) und wird ausgeblendet,
     um oben Platz für die Inhalte zu sparen. */
  .hub-header {
    flex-direction: row;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 1rem;
  }
  .hub-header-left {
    gap: 0.6rem;
    flex-shrink: 0;
  }
  .hub-header-left h3 {
    display: none;
  }
  .back-link {
    white-space: nowrap;
  }
  .hub-header-actions {
    flex: 1;
    min-width: 0;
  }
  .ws-switch {
    width: 100%;
    min-width: 0;
  }
  .hub-tabs {
    padding: 0 0.5rem;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .hub-tabs::-webkit-scrollbar {
    display: none;
  }
  .hub-tabs .tab {
    padding: 0.7rem 0.9rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
}
</style>

<template>
  <main class="hub-layout">
    <!-- Wiki Header -->
    <div class="hub-header">
      <div class="hub-header-left">
        <router-link to="/wikis" class="back-link"
          >← Übersicht</router-link
        >
        <h3>{{ ws?.name || "Lädt..." }}</h3>
      </div>
      <div class="hub-header-actions">
        <select
          v-model="selectedWikiId"
          @change="switchWiki"
          class="ws-switch"
        >
          <option v-for="w in allWikis" :key="w.id" :value="w.id">
            {{ w.name }}
          </option>
        </select>
      </div>
    </div>

    <!-- Tab Bar -->
    <div class="hub-tabs">
      <router-link
        :to="`/wikis/${wikiId}/documents`"
        class="tab"
        :class="{ active: activeTab === 'documents' }"
        >📄 Dokumente</router-link
      >
      <router-link
        :to="`/wikis/${wikiId}/wiki`"
        class="tab"
        :class="{ active: activeTab === 'wiki' }"
        >📖 Wiki</router-link
      >
      <router-link
        :to="`/wikis/${wikiId}/graph`"
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
import { useWiki } from "../../composables/useWiki";
import ConfirmModal from "../../components/ConfirmModal.vue";
import axios from "axios";

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const { isUUID } = useWiki();
const {
  show: showConfirm,
  options: confirmOptions,
  ask: askConfirm,
  onConfirm,
  onCancel,
} = useConfirm();

const wikiId = computed(() => route.params.id as string);
const activeTab = computed(() => {
  const path = route.path;
  if (path.includes("/documents")) return "documents";
  if (path.includes("/wiki")) return "wiki";
  if (path.includes("/graph")) return "graph";
  return "documents";
});

const ws = ref<any>(null);
const allWikis = ref<any[]>([]);
const selectedWikiId = ref("");

onMounted(async () => {
  await Promise.all([loadCurrentWiki(), loadAllWikis()]);
});

async function loadCurrentWiki() {
  try {
    // Der Route-Parameter kann eine UUID oder ein Slug sein (z.B. "politik").
    // Für Slugs den by-slug-Endpoint nutzen, sonst liefert /:id einen 404.
    const url = isUUID(wikiId.value)
      ? `/api/v1/wikis/${wikiId.value}`
      : `/api/v1/wikis/by-slug/${wikiId.value}`;
    const res = await axios.get(url);
    const data = res.data.wiki;
    ws.value = data;
    // Dropdown-Auswahl auf die aufgelöste UUID setzen, damit sie in der Liste matcht.
    selectedWikiId.value = data.id;
  } catch (e: any) {
    console.error("[hub] Fehler beim Laden des Wiki:", e.message);
  }
}

async function loadAllWikis() {
  try {
    const res = await axios.get("/api/v1/wikis");
    allWikis.value = res.data.wikis || [];
    // Nur setzen, wenn loadCurrentWiki die UUID noch nicht aufgelöst hat.
    // Bei Slug-URLs matcht wikiId sonst keinen Listeneintrag (Dropdown bliebe leer).
    if (!selectedWikiId.value) {
      const match = allWikis.value.find(
        (w: any) => w.id === wikiId.value || w.slug === wikiId.value,
      );
      selectedWikiId.value = match?.id || wikiId.value;
    }
  } catch (e: any) {
    console.error("[hub] Fehler beim Laden der Wiki-Liste:", e.message);
  }
}

function switchWiki() {
  if (
    selectedWikiId.value &&
    selectedWikiId.value !== wikiId.value
  ) {
    localStorage.setItem("knora-last-wiki", selectedWikiId.value);
    router.push(`/wikis/${selectedWikiId.value}/documents`);
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
  /* Alles in EINER Zeile: "← Übersicht" + Wiki-Select. Der h3-Titel ist
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

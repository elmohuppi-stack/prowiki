<template>
  <main class="wiki-content">
    <div class="wiki-header">
      <router-link
        :to="'/workspaces/' + workspaceId + '/wiki'"
        class="back-link"
        >← Wiki-Übersicht</router-link
      >
      <h3 v-if="!editing">{{ stripWikiLinks(page?.title || "") || "Lädt..." }}</h3>
      <div class="header-actions" v-if="page">
        <button class="btn-secondary" @click="editing = !editing">
          {{ editing ? "🔍 Vorschau" : "✏️ Bearbeiten" }}
        </button>
        <button class="btn-danger-sm" @click="deletePage">Löschen</button>
      </div>
    </div>

    <div v-if="!page && !loading" class="wiki-empty">
      <p>Seite nicht gefunden.</p>
      <router-link
        :to="'/workspaces/' + workspaceId + '/wiki'"
        class="back-link"
        >Zurück zur Übersicht</router-link
      >
    </div>

    <div v-if="loading" class="wiki-loading">Lade Seite...</div>

    <!-- Edit Mode -->
    <div v-if="page && editing" class="wiki-edit">
      <div class="field">
        <label>Titel</label>
        <input v-model="editTitle" />
      </div>
      <div class="field">
        <label>Summary</label>
        <input v-model="editSummary" />
      </div>
      <div class="field">
        <label>Inhalt (Markdown)</label>
        <textarea v-model="editContent" class="editor-textarea"></textarea>
      </div>
      <div class="edit-actions">
        <button class="btn-primary" @click="savePage">💾 Speichern</button>
        <button class="btn-secondary" @click="editing = false">
          Abbrechen
        </button>
      </div>
    </div>

    <!-- View Mode -->
    <div v-if="page && !editing" class="wiki-article">
      <SpeechBar :article="page" :article-key="page.slug" />

      <div class="article-summary" v-if="page.summary">
        {{ stripWikiLinks(page.summary) }}
      </div>
      <div class="article-content" v-html="renderedContent"></div>
      <div class="article-footer">
        <div v-if="page.out_links?.length" class="links-section">
          <h4>→ Verlinkt zu</h4>
          <div class="link-chips">
            <router-link
              v-for="slug in page.out_links"
              :key="slug"
              :to="`/workspaces/${workspaceId}/wiki/${encodeURIComponent(slug)}`"
              class="link-chip"
              >{{ slug.split("/").pop() }}</router-link
            >
          </div>
        </div>
        <div v-if="page.in_links?.length" class="links-section">
          <h4>← Verlinkt von</h4>
          <div class="link-chips">
            <router-link
              v-for="slug in page.in_links"
              :key="slug"
              :to="`/workspaces/${workspaceId}/wiki/${encodeURIComponent(slug)}`"
              class="link-chip"
              >{{ slug.split("/").pop() }}</router-link
            >
          </div>
        </div>
        <div class="page-meta">
          <span>Version {{ page.version }}</span>
          <span>Zuletzt bearbeitet: {{ formatDate(page.updated_at) }}</span>
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
import { useRouter, useRoute } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import { useWorkspace } from "../../composables/useWorkspace";
import { useConfirm } from "../../composables/useConfirm";
import ConfirmModal from "../../components/ConfirmModal.vue";
import SpeechBar from "../../components/SpeechBar.vue";
import axios from "axios";
import { marked } from "marked";
import DOMPurify from "dompurify";

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const { resolveWorkspace, isUUID } = useWorkspace();
const {
  show: showConfirm,
  options: confirmOptions,
  ask: askConfirm,
  onConfirm,
  onCancel,
} = useConfirm();
const rawWorkspaceId = (route.params.id || route.params.workspaceId) as string;
const workspaceId = ref(rawWorkspaceId);
const workspaceSlug = ref("");
const pageSlug = route.params.slug as string;

const page = ref<any>(null);
const loading = ref(true);
const editing = ref(false);
const editTitle = ref("");
const editSummary = ref("");
const editContent = ref("");

const renderedContent = computed(() => {
  if (!page.value?.content) return "";
  // Wiki-Links [[slug|text]] in HTML-Links umwandeln
  let html = page.value.content.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_: string, slug: string, text?: string) => {
      const raw = slug.split("/").pop() || slug;
      const label = text || raw.replace(/-/g, " ").replace(/^./, (ch) => ch.toUpperCase());
      return `<a href="/workspaces/${workspaceId.value}/wiki/${encodeURIComponent(slug)}" class="wiki-link">${label}</a>`;
    },
  );
  const parsed = marked.parse(html, { async: false }) as string;
  return DOMPurify.sanitize(parsed);
});

// Wiki-Link-Syntax [[slug|text]] in Titeln/Summaries zu reinem Anzeigetext auflösen
function stripWikiLinks(text: string): string {
  if (!text) return text;
  return text.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match: string, slug: string, label?: string) =>
      label || slug.split("/").pop()?.replace(/-/g, " ") || slug,
  );
}

onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.push("/login");
    return;
  }

  // Slug auflösen falls nötig
  if (rawWorkspaceId && !isUUID(rawWorkspaceId)) {
    const resolved = await resolveWorkspace(rawWorkspaceId);
    if (resolved) {
      workspaceId.value = resolved.id;
      workspaceSlug.value = resolved.slug;
    }
  }

  // Slug für API verwenden (ggf. mit fallback auf rawWorkspaceId)
  const slug = workspaceSlug.value || rawWorkspaceId;

  await loadPage();
});

async function loadPage() {
  loading.value = true;
  try {
    const res = await axios.get(
      `/api/v1/wiki/${workspaceId.value}/pages/${encodeURIComponent(pageSlug)}`,
    );
    page.value = res.data.page;
    editTitle.value = page.value.title;
    editSummary.value = page.value.summary;
    editContent.value = page.value.content;
  } catch {
    page.value = null;
  } finally {
    loading.value = false;
  }
}

async function savePage() {
  try {
    const res = await axios.put(
      `/api/v1/wiki/${workspaceId.value}/pages/${encodeURIComponent(pageSlug)}`,
      {
        title: editTitle.value,
        summary: editSummary.value,
        content: editContent.value,
      },
    );
    page.value = res.data.page;
    editing.value = false;
  } catch (e: any) {
    alert("Fehler: " + (e.response?.data?.error || e.message));
  }
}

async function deletePage() {
  const ok = await askConfirm({
    title: "Seite löschen",
    message: "Soll diese Wiki-Seite wirklich gelöscht werden?",
    confirmText: "Löschen",
  });
  if (!ok) return;
  try {
    await axios.delete(
      `/api/v1/wiki/${workspaceId.value}/pages/${encodeURIComponent(pageSlug)}`,
    );
    router.push(`/wiki/${workspaceSlug.value || workspaceId.value}`);
  } catch {
    alert("Fehler beim Löschen");
  }
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
</script>

<style scoped>
.wiki-content {
  flex: 1;
  overflow-y: auto;
}
.wiki-header {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: 1rem;
}
.wiki-header h3 {
  flex: 1;
}
.header-actions {
  display: flex;
  gap: 0.5rem;
}
.back-link {
  font-size: 0.875rem;
  color: var(--color-primary);
  white-space: nowrap;
}
.wiki-empty {
  padding: 4rem 2rem;
  text-align: center;
  color: var(--color-text-secondary);
}
.wiki-loading {
  padding: 2rem;
  color: var(--color-text-secondary);
}

.wiki-article {
  padding: 1.5rem 2rem;
  max-width: 800px;
}
.article-summary {
  font-style: italic;
  color: var(--color-text-secondary);
  margin-bottom: 1.5rem;
  padding: 0.75rem 1rem;
  background: var(--color-bg-secondary);
  border-radius: 8px;
}
.article-content :deep(h1) {
  font-size: 1.75rem;
  margin: 1.5rem 0 0.75rem;
}
.article-content :deep(h2) {
  font-size: 1.35rem;
  margin: 1.25rem 0 0.5rem;
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 0.25rem;
}
.article-content :deep(h3) {
  font-size: 1.1rem;
  margin: 1rem 0 0.5rem;
}
.article-content :deep(p) {
  margin-bottom: 0.75rem;
  line-height: 1.7;
}
.article-content :deep(ul),
.article-content :deep(ol) {
  margin-bottom: 0.75rem;
  padding-left: 1.5rem;
}
.article-content :deep(blockquote) {
  border-left: 3px solid var(--color-primary);
  padding-left: 1rem;
  margin: 0.75rem 0;
  color: var(--color-text-secondary);
}
.article-content :deep(code) {
  background: var(--color-bg-secondary);
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
  font-size: 0.9em;
}
.article-content :deep(pre) {
  background: #1a1a2e;
  color: #e0e0e0;
  padding: 1rem;
  border-radius: 8px;
  overflow-x: auto;
  margin: 0.75rem 0;
}
.article-content :deep(pre code) {
  background: none;
  padding: 0;
}
.article-content :deep(.wiki-link) {
  color: var(--color-primary);
  font-weight: 500;
  text-decoration: underline;
  text-decoration-style: dotted;
}

.article-footer {
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--color-border);
}
.links-section {
  margin-bottom: 1rem;
}
.links-section h4 {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  margin-bottom: 0.375rem;
}
.link-chips {
  display: flex;
  gap: 0.375rem;
  flex-wrap: wrap;
}
.link-chip {
  font-size: 0.8rem;
  padding: 0.25rem 0.625rem;
  background: var(--color-bg-secondary);
  border-radius: 12px;
  color: var(--color-primary);
  text-decoration: none;
}
.link-chip:hover {
  background: var(--color-primary);
  color: white;
}
.page-meta {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  display: flex;
  gap: 1rem;
}

.wiki-edit {
  padding: 1.5rem 2rem;
  max-width: 800px;
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
.field input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 1rem;
}
.editor-textarea {
  width: 100%;
  min-height: 400px;
  padding: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.9rem;
  font-family: monospace;
  line-height: 1.6;
  resize: vertical;
}
.edit-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 1rem;
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
</style>

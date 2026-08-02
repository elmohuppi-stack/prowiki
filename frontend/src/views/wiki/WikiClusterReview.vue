<template>
  <div class="review">
    <div class="review-head">
      <div>
        <h2>Artikel-Verbund aus dem Gespräch</h2>
        <p class="sub">
          KI-generierte Entwürfe – bitte prüfen, bei Bedarf im Chat verfeinern,
          dann veröffentlichen.
        </p>
      </div>
      <div class="head-actions">
        <button class="btn-secondary" @click="backToChat">
          <i class="pi pi-comments"></i> Im Chat verfeinern
        </button>
        <button
          class="btn-primary"
          :disabled="generating || pages.length === 0 || publishing"
          :title="
            generating
              ? 'Generierung läuft noch – bitte warten'
              : 'Alle Entwürfe veröffentlichen'
          "
          @click="publish"
        >
          <i class="pi" :class="generating ? 'pi-spin pi-spinner' : 'pi-check'"></i>
          {{
            generating
              ? "Generierung läuft …"
              : publishing
                ? "Veröffentliche …"
                : "Verbund veröffentlichen"
          }}
        </button>
      </div>
    </div>

    <!-- Fehler bei der Generierung -->
    <div v-if="failed" class="state">
      <i class="pi pi-exclamation-triangle" style="color: #ef4444"></i>
      <p>Die Generierung ist fehlgeschlagen.</p>
      <small>Details siehe Aktivitätsleiste unten.</small>
      <div style="margin-top: 0.75rem">
        <button class="btn-secondary" @click="backToChat">Zurück zum Chat</button>
      </div>
    </div>

    <!-- Generierung läuft, noch keine Seite -->
    <div v-else-if="generating && pages.length === 0" class="state">
      <i class="pi pi-spin pi-spinner"></i>
      <p>Der Verbund wird erzeugt … Das kann einen Moment dauern.</p>
      <small>Fortschritt siehst du auch in der Aktivitätsleiste unten.</small>
    </div>

    <div v-else-if="!generating && pages.length === 0" class="state">
      <p>Keine Entwürfe gefunden.</p>
      <button class="btn-secondary" @click="backToChat">Zurück zum Chat</button>
    </div>

    <div v-else class="cluster">
      <!-- Seitenliste -->
      <aside class="page-nav">
        <div class="nav-label">
          {{ pages.length }} Artikel
          <span v-if="generating" class="live">
            <i class="pi pi-spin pi-spinner"></i> Generierung läuft …
          </span>
        </div>
        <button
          v-for="(p, i) in pages"
          :key="p.slug"
          :class="['nav-item', { active: i === activeIndex }]"
          @click="activeIndex = i"
        >
          <span class="nav-badge" v-if="isMain(p)">Haupt</span>
          {{ p.title }}
        </button>
      </aside>

      <!-- Aktiver Artikel -->
      <article v-if="active" class="page-body">
        <div class="ai-note">
          <i class="pi pi-info-circle"></i>
          KI-generiert, noch nicht geprüft. Fakten vor dem Veröffentlichen prüfen.
        </div>
        <h1>{{ active.title }}</h1>
        <p class="summary" v-if="active.summary">
          {{ stripWikiLinks(active.summary) }}
        </p>
        <div class="content" v-html="renderContent(active.content)"></div>
        <div class="page-actions">
          <button class="btn-secondary" @click="openInEditor(active)">
            <i class="pi pi-pencil"></i> Im Editor öffnen
          </button>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { marked } from "marked";
import DOMPurify from "dompurify";
import axios from "axios";

const route = useRoute();
const router = useRouter();

const workspaceId = computed(() => route.params.id as string);
const clusterId = computed(() => route.params.clusterId as string);

const pages = ref<any[]>([]);
const activeIndex = ref(0);
const generating = ref(true);
const failed = ref(false);
const publishing = ref(false);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let elapsed = 0;
const POLL_MS = 3000;
const MAX_MS = 300000;

const active = computed(() => pages.value[activeIndex.value] || null);

function isMain(p: any): boolean {
  return !!p?.page_metadata?.is_main;
}

async function loadPages() {
  try {
    const res = await axios.get(
      `/api/v1/wiki/${workspaceId.value}/clusters/${clusterId.value}/pages`,
    );
    pages.value = res.data.pages || [];
    const status = res.data.status as string | null;
    elapsed += POLL_MS;

    // Generierung ist erst mit dem echten Log-Status fertig – nicht raten.
    if (status === "completed") {
      stopPolling();
    } else if (status === "failed") {
      failed.value = true;
      stopPolling();
    } else if (elapsed >= MAX_MS) {
      // Sicherheitsnetz, falls kein Abschluss-Status kommt.
      stopPolling();
    }
  } catch {
    elapsed += POLL_MS;
    if (elapsed >= MAX_MS) stopPolling();
  }
}

function stopPolling() {
  generating.value = false;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function renderContent(content: string): string {
  if (!content) return "";
  const html = content.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_: string, slug: string, text?: string) => {
      const label = text || prettifySlug(slug);
      return `<a href="/workspaces/${workspaceId.value}/wiki/${encodeURIComponent(slug)}" class="wiki-link">${label}</a>`;
    },
  );
  return DOMPurify.sanitize(marked.parse(html, { async: false }) as string);
}

function prettifySlug(slug: string): string {
  const base = slug.split("/").pop() || slug;
  const words = base.replace(/-/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function stripWikiLinks(text: string): string {
  if (!text) return text;
  return text.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m: string, slug: string, label?: string) => label || prettifySlug(slug),
  );
}

function backToChat() {
  router.push("/chat");
}

function openInEditor(p: any) {
  router.push(
    `/workspaces/${workspaceId.value}/wiki/${encodeURIComponent(p.slug)}`,
  );
}

async function publish() {
  if (pages.value.length === 0) return;
  publishing.value = true;
  try {
    await axios.post(
      `/api/v1/wiki/${workspaceId.value}/clusters/${clusterId.value}/publish`,
    );
    const main = pages.value.find((p) => isMain(p)) || pages.value[0];
    router.push(
      `/workspaces/${workspaceId.value}/wiki/${encodeURIComponent(main.slug)}`,
    );
  } catch (e) {
    publishing.value = false;
  }
}

onMounted(() => {
  loadPages();
  pollTimer = setInterval(loadPages, POLL_MS);
});

onUnmounted(stopPolling);
</script>

<style scoped>
.review {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 1rem 1.25rem;
  overflow: hidden;
}
.review-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.review-head h2 {
  margin: 0;
}
.sub {
  margin: 0.25rem 0 0;
  color: var(--color-text-muted, #6b7280);
  font-size: 0.9rem;
}
.head-actions {
  display: flex;
  gap: 0.5rem;
}
.btn-primary,
.btn-secondary {
  padding: 0.55rem 0.9rem;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  border: 1px solid var(--color-border, #d1d5db);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.btn-primary {
  background: var(--color-primary, #2e6cc4);
  color: #fff;
  border-color: transparent;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-secondary {
  background: var(--color-bg-secondary, #f3f4f6);
  color: var(--color-text, #111);
}
.state {
  margin: auto;
  text-align: center;
  color: var(--color-text-muted, #6b7280);
}
.state .pi-spinner {
  font-size: 1.6rem;
}
.cluster {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 1.25rem;
}
.page-nav {
  width: 220px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid var(--color-border, #e5e7eb);
  padding-right: 0.5rem;
}
.nav-label {
  font-size: 0.8rem;
  color: var(--color-text-muted, #6b7280);
  padding: 0.25rem 0.5rem 0.5rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.live {
  color: var(--color-primary, #2e6cc4);
}
.nav-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.5rem;
  border: none;
  background: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
  color: var(--color-text, #111);
}
.nav-item:hover {
  background: var(--color-bg-secondary, #f3f4f6);
}
.nav-item.active {
  background: var(--color-primary, #2e6cc4);
  color: #fff;
}
.nav-badge {
  display: inline-block;
  font-size: 0.65rem;
  background: var(--color-border, #d1d5db);
  color: var(--color-text, #111);
  border-radius: 4px;
  padding: 0 0.3rem;
  margin-right: 0.35rem;
  vertical-align: middle;
}
.page-body {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding-right: 0.5rem;
}
.ai-note {
  background: #fff7ed;
  color: #9a3412;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  font-size: 0.85rem;
  margin-bottom: 1rem;
}
.summary {
  font-style: italic;
  color: var(--color-text-muted, #6b7280);
}
.content :deep(a.wiki-link) {
  color: var(--color-primary, #2e6cc4);
  text-decoration: none;
  border-bottom: 1px dashed currentColor;
}
.page-actions {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--color-border, #e5e7eb);
}

@media (max-width: 768px) {
  .cluster {
    flex-direction: column;
  }
  .page-nav {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--color-border, #e5e7eb);
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    padding-bottom: 0.5rem;
  }
  .nav-item {
    width: auto;
  }
}
</style>

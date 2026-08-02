<template>
  <main class="main-content">
    <div class="header">
      <router-link
        :to="'/workspaces/' + workspaceId + '/documents'"
        class="back-link"
        >← Zurück zur Liste</router-link
      >
      <h3>{{ doc?.title || "Lädt..." }}</h3>
    </div>

    <div v-if="!doc" class="content">
      <p class="empty">Lade Dokument...</p>
    </div>

    <template v-else>
      <!-- Meta + Video Row -->
      <div class="meta-video-row">
        <div class="meta-info">
          <div class="meta-line"><strong>Kanal:</strong> {{ channelName }}</div>
          <div class="meta-line">
            <strong>Datum:</strong> {{ formatDate(doc.created_at) }}
          </div>
          <div class="meta-line">
            <strong>Typ:</strong> <span class="type-badge">{{ doc.type }}</span>
          </div>
          <div class="meta-line" v-if="doc.source_url">
            <strong>Quelle:</strong>
            <a :href="doc.source_url" target="_blank"
              >{{ doc.source_url.slice(0, 50) }}…</a
            >
          </div>
          <div
            class="desc-preview"
            v-if="descPreview"
            @click="showFullDesc = !showFullDesc"
          >
            <strong>Beschreibung:</strong>
            <p>{{ showFullDesc ? fullDescription : descPreview }}</p>
            <button class="desc-toggle">
              {{ showFullDesc ? "▲ weniger" : "▼ mehr" }}
            </button>
          </div>
        </div>
        <div class="meta-video" v-if="youtubeId">
          <iframe
            :src="'https://www.youtube-nocookie.com/embed/' + youtubeId"
            title="YouTube"
            frameborder="0"
            allow="
              accelerometer;
              autoplay;
              clipboard-write;
              encrypted-media;
              gyroscope;
              picture-in-picture;
            "
            allowfullscreen
            class="video-thumb"
          ></iframe>
        </div>
      </div>

      <!-- Themen (Ebene 1): Zuweisung/Korrektur -->
      <div class="topic-assign" v-if="allTopics.length">
        <strong>Themen:</strong>
        <button
          v-for="t in allTopics"
          :key="t.id"
          :class="['topic-chip', { active: docTopicIds.includes(t.id) }]"
          @click="toggleDocTopic(t.id)"
        >
          {{ t.label }}
        </button>
      </div>

      <!-- Metadaten + Transkript -->
      <div class="meta-grid">
        <div class="meta-card">
          <strong>Titel</strong><span>{{ doc.title }}</span>
        </div>
        <div class="meta-card">
          <strong>Typ</strong><span class="type-badge">{{ doc.type }}</span>
        </div>
        <div class="meta-card">
          <strong>Status</strong>
          <span :class="['status', doc.parse_status]">{{
            statusLabel(doc.parse_status)
          }}</span>
        </div>
        <div class="meta-card" v-if="doc.source_url">
          <strong>Quelle</strong>
          <a :href="doc.source_url" target="_blank"
            >{{ doc.source_url.slice(0, 50) }}…</a
          >
        </div>
        <div class="meta-card">
          <strong>Chunks</strong><span>{{ doc.chunk_count || "-" }}</span>
        </div>
        <div class="meta-card">
          <strong>Hochgeladen</strong
          ><span>{{ formatDate(doc.created_at) }}</span>
        </div>
      </div>

      <div class="transcript-box" v-if="doc.content">
        <pre>{{ doc.content }}</pre>
      </div>
      <p v-else class="empty">(Kein Inhalt)</p>

      <!-- Verknüpfte Wiki-Artikel -->
      <div class="wiki-sidebar-box">
        <h4>📖 Wiki-Artikel</h4>
        <div v-if="wikiPages.length > 0">
          <div v-for="wp in wikiPages" :key="wp.id" class="wiki-link-item">
            <router-link
              :to="
                '/workspaces/' +
                workspaceId +
                '/wiki/' +
                encodeURIComponent(wp.slug)
              "
            >
              {{ wp.title }}
            </router-link>
            <span class="wiki-type">{{ wp.page_type }}</span>
          </div>
        </div>
        <div v-else>
          <p class="empty">Noch keine Wiki-Artikel zu diesem Dokument.</p>
          <button
            class="btn-primary btn-sm"
            @click="generateWiki"
            :disabled="generating"
          >
            {{ generating ? "⏳ Generiere..." : "📖 Wiki-Artikel generieren" }}
          </button>
          <p v-if="genResult" class="gen-feedback">{{ genResult }}</p>
        </div>
      </div>
    </template>
  </main>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import axios from "axios";

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const workspaceId = (route.params.id || route.params.workspaceId) as string;
const documentId = route.params.documentId as string;

const doc = ref<any>(null);
const wikiPages = ref<any[]>([]);
const generating = ref(false);
const genResult = ref("");
const showFullDesc = ref(false);

const youtubeId = computed(() => {
  if (!doc.value?.source_url) return null;
  const match = doc.value.source_url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  );
  return match?.[1] || null;
});

const channelName = computed(() => {
  // Bevorzugt das strukturierte Feld (Ebene 2), Fallback: aus content parsen.
  if (doc.value?.channel) return doc.value.channel;
  const c = doc.value?.content || "";
  const match = c.match(/\*\*Kanal\*\*:\s*(.+)/);
  return match?.[1]?.trim() || "-";
});

// Themen (Ebene 1)
const allTopics = ref<any[]>([]);
const docTopicIds = ref<string[]>([]);
async function loadTopics() {
  try {
    const r = await axios.get(`/api/v1/topics/${workspaceId}`);
    allTopics.value = r.data.topics || [];
  } catch {
    /* ignore */
  }
}
async function loadDocTopics() {
  try {
    const r = await axios.get(`/api/v1/documents/${documentId}/topics`);
    docTopicIds.value = r.data.topic_ids || [];
  } catch {
    /* ignore */
  }
}
async function toggleDocTopic(id: string) {
  const i = docTopicIds.value.indexOf(id);
  const next =
    i >= 0
      ? docTopicIds.value.filter((x) => x !== id)
      : [...docTopicIds.value, id];
  docTopicIds.value = next;
  try {
    await axios.patch(`/api/v1/documents/${documentId}/topics`, {
      topic_ids: next,
    });
  } catch (e) {
    // Bei Fehler neu laden (Zustand konsistent halten)
    await loadDocTopics();
  }
}

const fullDescription = computed(() => {
  const c = doc.value?.content || "";
  const match = c.match(/\*\*Beschreibung\*\*:\s*(.+?)(?=\n##|$)/s);
  return match?.[1]?.trim() || "";
});

const descPreview = computed(() => {
  const d = fullDescription.value;
  return d ? d.slice(0, 150) + (d.length > 150 ? "..." : "") : "";
});

onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.push("/login");
    return;
  }
  await Promise.all([
    loadDoc(),
    loadWikiPages(),
    loadTopics(),
    loadDocTopics(),
  ]);
});

async function loadDoc() {
  try {
    const res = await axios.get("/api/v1/documents/detail/" + documentId);
    doc.value = res.data.document;
  } catch (e: any) {
    console.error("Failed to load document", e);
  }
}

async function loadWikiPages() {
  try {
    const res = await axios.get("/api/v1/wiki/" + workspaceId + "/pages", {
      params: { source_document_id: documentId },
    });
    wikiPages.value = res.data.pages || [];
  } catch (e: any) {
    console.error("Failed to load wiki pages", e);
  }
}

async function generateWiki() {
  generating.value = true;
  genResult.value = "";
  try {
    const res = await axios.post(
      "/api/v1/wiki/" + workspaceId + "/generate/" + documentId,
    );
    const pages = res.data.pages || [];
    if (pages.length > 0) {
      genResult.value = "✅ " + pages.length + " Artikel erstellt";
    } else {
      genResult.value = "⚠️ Keine Artikel generiert";
    }
  } catch (e: any) {
    genResult.value = "❌ " + (e.response?.data?.error || e.message);
  } finally {
    generating.value = false;
  }
}

function statusLabel(s: string) {
  const map: Record<string, string> = {
    pending: "Ausstehend",
    processing: "Verarbeite...",
    completed: "✅ Fertig",
    failed: "❌ Fehler",
  };
  return map[s] || s;
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
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: 1rem;
}
.header h3 {
  font-size: 1.1rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  margin: 0;
}
.back-link {
  font-size: 0.875rem;
  color: var(--color-primary);
  text-decoration: none;
  white-space: nowrap;
}
.content {
  padding: 1.5rem;
}
.empty {
  color: var(--color-text-secondary);
  text-align: center;
  padding: 2rem;
}

/* Meta + Video Row */
.meta-video-row {
  display: flex;
  gap: 1.5rem;
  padding: 1rem 1.5rem;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  align-items: flex-start;
}
.meta-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.meta-line {
  font-size: 0.85rem;
  color: var(--color-text);
}
.meta-line strong {
  color: var(--color-text-secondary);
  margin-right: 0.35rem;
}
.meta-line a {
  color: var(--color-primary);
  word-break: break-all;
}
.desc-preview {
  cursor: pointer;
}
.desc-preview p {
  font-size: 0.82rem;
  color: var(--color-text-secondary);
  margin: 0.25rem 0;
  line-height: 1.5;
}
.desc-toggle {
  font-size: 0.75rem;
  color: var(--color-primary);
  border: none;
  background: none;
  cursor: pointer;
  padding: 0;
}
.meta-video {
  flex-shrink: 0;
  width: 280px;
}
.video-thumb {
  width: 100%;
  aspect-ratio: 16/9;
  border-radius: 8px;
  display: block;
}
.type-badge {
  display: inline-block;
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  background: var(--color-border);
  color: var(--color-text-secondary);
}

/* Tabs */
.tabs-bar {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}
.tabs-bar .tab {
  padding: 0.6rem 1.25rem;
  border: none;
  background: none;
  font-size: 0.85rem;
  cursor: pointer;
  color: var(--color-text-secondary);
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
}
.tabs-bar .tab.active {
  color: var(--color-text);
  font-weight: 600;
  border-bottom-color: var(--color-primary);
  background: white;
}
.tabs-bar .tab:hover:not(.active) {
  color: var(--color-text);
}

/* Wiki Tab */
.wiki-tab-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.wiki-tab-card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
}
.wiki-tab-link {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  text-decoration: none;
  color: var(--color-text);
  font-size: 0.9rem;
}
.wiki-tab-link:hover {
  background: var(--color-bg-secondary);
  border-radius: 8px;
}
.wiki-type-icon {
  font-size: 1.3rem;
}
.wiki-type-label {
  display: block;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin-top: 0.1rem;
}
.wiki-arrow {
  margin-left: auto;
  color: var(--color-text-secondary);
}
.gen-feedback {
  margin-top: 0.5rem;
  font-size: 0.85rem;
  color: var(--color-primary);
}
.btn-lg {
  padding: 0.65rem 1.5rem;
  font-size: 0.95rem;
}

/* Activity Log */
.activity-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}
.live-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  padding: 0.2rem 0.6rem;
  border-radius: 20px;
  background: var(--color-bg-secondary);
}
.live-badge.active {
  color: #16a34a;
  background: #dcfce7;
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-secondary);
}
.live-badge.active .live-dot {
  background: #16a34a;
  animation: pulse-dot 1.5s ease-in-out infinite;
}
@keyframes pulse-dot {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
.log-count {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
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
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}
.log-action-icon {
  font-size: 1rem;
}
.log-action {
  font-weight: 600;
  font-size: 0.85rem;
}
.log-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.log-status-dot.completed {
  background: #22c55e;
}
.log-status-dot.failed {
  background: #ef4444;
}
.log-status-dot.started {
  background: #f59e0b;
}
.log-time {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin-left: auto;
  white-space: nowrap;
}
.log-body {
}
.log-message {
  font-size: 0.85rem;
  color: var(--color-text);
  margin-bottom: 0.2rem;
}
.log-meta-row {
  display: flex;
  gap: 1rem;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}
.log-status-label {
}
.log-status-label.failed {
  color: #ef4444;
}
.log-status-label.completed {
  color: #22c55e;
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

/* Meta Grid (Transcript Tab) */
.meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.meta-card {
  background: var(--color-bg-secondary);
  border-radius: 6px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.meta-card strong {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}
.meta-card span,
.meta-card a {
  font-size: 0.9rem;
  word-break: break-word;
}
.meta-card a {
  color: var(--color-primary);
}

/* Transcript */
.transcript-box {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1rem;
  max-height: 70vh;
  overflow-y: auto;
}
.transcript-box pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-size: 0.85rem;
  line-height: 1.6;
  font-family: inherit;
  margin: 0;
}

@media (max-width: 768px) {
  .header {
    padding: 0.6rem 1rem;
    gap: 0.6rem;
  }
  .content {
    padding: 1rem;
  }
  /* Meta + Video übereinander stapeln */
  .meta-video-row {
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
  }
  .meta-video {
    width: 100%;
  }
  /* Tabs horizontal scrollbar statt gequetscht */
  .tabs-bar {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .tabs-bar::-webkit-scrollbar {
    display: none;
  }
  .tabs-bar .tab {
    padding: 0.6rem 0.9rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
}

/* Themen-Zuweisung (Ebene 1) */
.topic-assign {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0 1.5rem 1rem;
}
.topic-assign > strong {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
}
.topic-assign .topic-chip {
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.8rem;
  cursor: pointer;
  font-family: inherit;
}
.topic-assign .topic-chip:hover {
  border-color: var(--color-primary);
}
.topic-assign .topic-chip.active {
  background: var(--color-primary);
  color: #fff;
  border-color: var(--color-primary);
}
</style>

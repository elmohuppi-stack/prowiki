<template>
  <main class="main-content">
    <div class="header">
      <div class="header-left">
        <router-link to="/workspaces" class="back-link"
          >← Übersicht</router-link
        >
        <h3 v-if="ws">{{ ws.name }}</h3>
        <h3 v-else>📄 Übersicht</h3>
      </div>
      <div class="header-actions">
        <button
          class="btn-icon"
          @click="showSettings = true"
          title="Workspace-Einstellungen"
        >
          ⚙️
        </button>
        <button class="btn-primary" @click="showUpload = true">
          📤 Upload
        </button>
        <button class="btn-primary" @click="showUrl = true">🔗 URL</button>
        <button class="btn-primary" @click="showYoutube = true">
          ▶️ YouTube
        </button>
      </div>
    </div>
    <!-- Upload Area -->
    <div v-if="showUpload" class="upload-area">
      <input
        type="file"
        ref="fileInput"
        @change="uploadFile"
        accept=".pdf,.docx,.md,.txt,.html,.csv"
        class="file-input"
      />
      <p v-if="uploading">📤 Lädt hoch...</p>
      <p v-if="uploadError" class="error">{{ uploadError }}</p>
      <button
        class="btn-secondary"
        @click="showUpload = false"
        v-if="!uploading"
      >
        Schließen
      </button>
    </div>

    <!-- URL Import -->
    <div v-if="showUrl" class="upload-area">
      <input v-model="urlInput" placeholder="https://..." class="url-input" />
      <button
        class="btn-primary"
        @click="importUrl"
        :disabled="!urlInput.trim() || importing"
      >
        {{ importing ? "⏳ Importiere..." : "Importieren" }}
      </button>
      <p v-if="urlError" class="error">{{ urlError }}</p>
      <button class="btn-secondary" @click="showUrl = false">Schließen</button>
    </div>

    <!-- YouTube Import -->
    <div v-if="showYoutube" class="upload-area">
      <input
        v-model="youtubeUrl"
        placeholder="https://youtube.com/watch?v=..."
        class="url-input"
      />
      <button
        class="btn-primary"
        @click="importYoutube"
        :disabled="!youtubeUrl.trim() || youtubing"
      >
        {{ youtubing ? "⏳ Importiere..." : "Importieren" }}
      </button>
      <p v-if="youtubeInfo" class="success">▶️ {{ youtubeInfo }}</p>
      <p v-if="youtubeError" class="error">{{ youtubeError }}</p>
      <button
        class="btn-secondary"
        @click="
          showYoutube = false;
          youtubeUrl = '';
          youtubeError = '';
          youtubeInfo = '';
        "
      >
        Schließen
      </button>
    </div>

    <!-- Filter- & Sortierleiste (Ebene 2) -->
    <div class="filter-bar">
      <input
        class="filter-search"
        v-model="filterQuery"
        @input="onSearchInput"
        placeholder="🔍 Titel durchsuchen..."
      />
      <select v-model="filterType" @change="loadDocs">
        <option value="">Alle Typen</option>
        <option v-for="t in TYPES" :key="t" :value="t">{{ t }}</option>
      </select>
      <select v-model="filterChannel" @change="loadDocs" v-if="channels.length">
        <option value="">Alle Kanäle</option>
        <option v-for="ch in channels" :key="ch" :value="ch">{{ ch }}</option>
      </select>
      <DatePicker
        v-model="filterDates"
        selectionMode="range"
        :manualInput="false"
        showIcon
        showButtonBar
        iconDisplay="input"
        dateFormat="dd.mm.yy"
        placeholder="Zeitraum (Sitzungsdatum)"
        class="filter-datepicker"
      />
      <select v-model="sortBy" @change="loadDocs">
        <option value="created_desc">Neueste zuerst</option>
        <option value="created_asc">Älteste zuerst</option>
        <option value="published_desc">Sitzungsdatum ↓</option>
        <option value="published_asc">Sitzungsdatum ↑</option>
        <option value="title_asc">Titel A–Z</option>
        <option value="title_desc">Titel Z–A</option>
      </select>
      <button
        v-if="hasActiveFilters"
        class="btn-secondary btn-clear"
        @click="clearFilters"
      >
        ✕ Filter zurücksetzen
      </button>
    </div>

    <!-- Themen-Filter-Chips (Ebene 1) -->
    <div class="topic-filter-row" v-if="topics.length">
      <span class="topic-filter-label">Themen:</span>
      <button
        v-for="t in topics"
        :key="t.id"
        :class="['topic-chip', { active: filterTopicIds.includes(t.id) }]"
        @click="toggleTopicFilter(t.id)"
      >
        {{ t.label }}
        <span class="topic-chip-count" v-if="t.doc_count">{{ t.doc_count }}</span>
      </button>
    </div>

    <!-- Document List -->
    <div class="content">
      <div v-if="loading" class="loading">Lade Dokumente...</div>

      <div v-else-if="docs.length === 0" class="empty">
        <p v-if="hasActiveFilters">Keine Dokumente für die aktuellen Filter.</p>
        <p v-else>
          Noch keine Dokumente. Lade eine Datei hoch oder importiere eine URL.
        </p>
      </div>

      <table v-else class="table">
        <thead>
          <tr>
            <th>Titel</th>
            <th>Typ</th>
            <th>Status</th>
            <th>Datum</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="doc in docs" :key="doc.id">
            <td class="doc-title" @click="openDoc(doc)" style="cursor: pointer">
              {{ doc.title }}
              <span v-if="doc.channel" class="item-subtitle">{{
                doc.channel
              }}</span>
            </td>
            <td>
              <span class="type-badge">{{ doc.type }}</span>
            </td>
            <td>
              <span :class="['status', doc.parse_status]">{{
                statusLabel(doc.parse_status)
              }}</span>
            </td>
            <!-- Sitzungs-/Veröffentlichungsdatum, sonst Import-Datum. Bei einem
                 Massenimport tragen alle Zeilen dieselbe Import-Minute und die
                 Spalte wäre wertlos. -->
            <td
              class="date"
              :title="doc.published_at ? 'Sitzungsdatum' : 'Import-Datum'"
            >
              {{ formatDate(doc.published_at || doc.created_at) }}
            </td>
            <td>
              <button
                class="btn-icon-sm"
                @click.stop="openDoc(doc)"
                title="Öffnen"
              >
                ▶️
              </button>
              <button
                v-if="doc.type === 'youtube'"
                class="btn-icon-sm"
                @click.stop="refreshMetadata(doc)"
                :disabled="refreshingId === doc.id"
                title="YouTube-Metadaten aktualisieren (Kanal, Datum, Dauer, Tags)"
              >
                {{ refreshingId === doc.id ? "⏳" : "🔄" }}
              </button>
              <button
                class="btn-icon-sm"
                @click.stop="openMove(doc)"
                title="In anderen Workspace verschieben"
              >
                📦
              </button>
              <button class="btn-danger-sm" @click.stop="deleteDoc(doc.id)">
                ✕
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Document Detail Dialog -->
    <div
      v-if="showDetail && selectedDoc"
      class="dialog-overlay"
      @click.self="showDetail = false"
    >
      <div class="dialog dialog-wide">
        <h3>{{ selectedDoc.title }}</h3>
        <div class="doc-meta-bar">
          <span class="type-badge">{{ selectedDoc.type }}</span>
          <span>Status: {{ statusLabel(selectedDoc.parse_status) }}</span>
          <span>Chunks: {{ selectedDoc.chunk_count || "-" }}</span>
          <span>Hochgeladen: {{ formatDate(selectedDoc.created_at) }}</span>
        </div>
        <div class="doc-content-box" v-if="selectedDoc.content">
          <pre>{{ selectedDoc.content }}</pre>
        </div>
        <p v-else class="empty">(Kein Inhalt)</p>
        <div class="dialog-actions" style="justify-content: space-between">
          <button
            class="btn-secondary"
            @click="generateWikiForDoc(selectedDoc.id)"
            :disabled="generatingWiki"
          >
            {{
              generatingWiki ? "⏳ Generiere..." : "📖 Wiki-Artikel generieren"
            }}
          </button>
          <span
            v-if="wikiGenResult"
            class="success"
            style="margin-right: auto; margin-left: 0.5rem"
            >{{ wikiGenResult }}</span
          >
          <button class="btn-secondary" @click="showDetail = false">
            Schließen
          </button>
        </div>
      </div>
    </div>

    <!-- Workspace Settings Dialog -->
    <div
      v-if="showSettings && ws"
      class="dialog-overlay"
      @click.self="showSettings = false"
    >
      <div class="dialog">
        <h3>⚙️ Workspace: {{ ws.name }}</h3>

        <div class="field">
          <label>Name</label>
          <input v-model="editName" />
        </div>
        <div class="field">
          <label>Beschreibung</label>
          <textarea v-model="editDesc"></textarea>
        </div>

        <div class="detail-grid">
          <div class="detail-card">
            <strong>Chunk Size</strong>
            <span>{{ ws.chunk_size }} Tokens</span>
          </div>
          <div class="detail-card">
            <strong>Chunk Overlap</strong>
            <span>{{ ws.chunk_overlap }} Tokens</span>
          </div>
          <div class="detail-card">
            <strong>Erstellt am</strong>
            <span>{{ formatDate(ws.created_at) }}</span>
          </div>
        </div>

        <!-- Zugriff: Besitzer + Mitglieder -->
        <div class="field">
          <label>Besitzer</label>
          <select
            v-if="auth.isAdmin"
            v-model="editOwnerId"
            class="access-select"
          >
            <option v-for="u in allUsers" :key="u.id" :value="u.id">
              {{ u.name }} ({{ u.email }})
            </option>
          </select>
          <p v-else class="field-static">{{ ownerLabel }}</p>
          <p v-if="auth.isAdmin" class="field-hint">
            Beim Wechsel bleibt der bisherige Besitzer als Bearbeiter im
            Workspace.
          </p>
        </div>

        <div v-if="canManageMembers" class="field">
          <label>Mitglieder</label>
          <div class="topic-manage-toolbar">
            <select v-model="newMemberId" class="access-select">
              <option value="">Benutzer wählen…</option>
              <option v-for="u in invitableUsers" :key="u.id" :value="u.id">
                {{ u.name }} ({{ u.email }})
              </option>
            </select>
            <select v-model="newMemberRole" class="access-select role-select">
              <option value="editor">Bearbeiter</option>
              <option value="viewer">Leser</option>
            </select>
            <button
              class="btn-secondary"
              :disabled="!newMemberId"
              @click="addMember"
            >
              + Einladen
            </button>
          </div>

          <div v-if="members.length" class="topic-manage-list">
            <div v-for="m in members" :key="m.user_id" class="topic-manage-item">
              <span class="topic-manage-label">{{ m.name }}</span>
              <span class="topic-manage-count">{{ roleLabel(m.role) }}</span>
              <button
                v-if="m.user_id !== ws.created_by"
                class="topic-manage-del"
                @click="removeMember(m.user_id)"
                title="Mitglied entfernen"
              >
                ✕
              </button>
            </div>
          </div>
          <p v-else class="topic-empty">Noch keine weiteren Mitglieder.</p>
          <p v-if="memberError" class="error">{{ memberError }}</p>
        </div>

        <!-- Themen-Verwaltung (Ebene 1) -->
        <div class="field">
          <label>Themen</label>
          <div class="topic-manage-toolbar">
            <input
              v-model="newTopicLabel"
              placeholder="Neues Thema..."
              @keyup.enter="addTopic"
              class="topic-input"
            />
            <button class="btn-secondary" @click="addTopic">+ Anlegen</button>
            <button
              class="btn-secondary"
              @click="generateSuggestions"
              :disabled="suggesting"
            >
              {{ suggesting ? "⏳..." : "✨ Vorschläge" }}
            </button>
          </div>

          <div v-if="suggestions.length" class="topic-suggestions">
            <p class="suggest-hint">
              {{ suggestions.length }} Vorschläge –
              <button class="link-btn" @click="acceptSuggestions">
                alle übernehmen
              </button>
              ·
              <button class="link-btn" @click="suggestions = []">
                verwerfen
              </button>
            </p>
            <div class="suggest-chips">
              <span v-for="s in suggestions" :key="s.slug" class="suggest-chip"
                >{{ s.label }}</span
              >
            </div>
          </div>

          <div v-if="topics.length" class="topic-manage-list">
            <div v-for="t in topics" :key="t.id" class="topic-manage-item">
              <span class="topic-manage-label">{{ t.label }}</span>
              <span class="topic-manage-count">{{ t.doc_count || 0 }}</span>
              <button
                class="topic-manage-del"
                @click="removeTopic(t.id)"
                title="Thema löschen"
              >
                ✕
              </button>
            </div>
          </div>
          <p v-else-if="!suggestions.length" class="topic-empty">
            Noch keine Themen. Lege welche an oder generiere Vorschläge aus den
            Wiki-Konzepten.
          </p>
          <p v-if="topicError" class="error">{{ topicError }}</p>
        </div>

        <div class="field">
          <label>Wiki-Tiefe</label>
          <div class="wiki-depth-options">
            <label
              v-for="opt in wikiDepthOptions"
              :key="opt.value"
              :class="['depth-row', { active: editWikiDepth === opt.value }]"
            >
              <input
                type="radio"
                name="wiki-depth"
                :value="opt.value"
                v-model="editWikiDepth"
              />
              <span class="depth-text">
                <span class="depth-title">{{ opt.title }}</span>
                <span class="depth-desc">{{ opt.desc }}</span>
              </span>
            </label>
          </div>
          <p class="field-hint">
            Steuert, wie viel Wiki beim Import (v. a. großer Dokumente) erzeugt
            wird — Aufwand/Kosten gegen Detailtiefe. Greift ab dem nächsten
            Import.
          </p>
        </div>

        <div class="dialog-actions">
          <button class="btn-secondary" @click="showSettings = false">
            Schließen
          </button>
          <button class="btn-primary" @click="updateWs">💾 Speichern</button>
          <button
            class="btn-danger"
            @click="deleteWs"
            style="margin-left: auto"
          >
            🗑️ Löschen
          </button>
        </div>
        <p v-if="settingsError" class="error">{{ settingsError }}</p>
      </div>
    </div>
    <!-- Dokument verschieben -->
    <div
      v-if="showMove && moveDoc"
      class="dialog-overlay"
      @click.self="closeMove"
    >
      <div class="dialog">
        <h3>📦 Dokument verschieben</h3>
        <p class="move-doc-title">{{ moveDoc.title }}</p>

        <div class="field">
          <label>Ziel-Workspace</label>
          <WorkspaceSelect
            v-model="moveTarget"
            writable-only
            :exclude="workspaceId"
            placeholder="Ziel wählen…"
            empty-label="Kein anderer Workspace mit Schreibrecht"
          />
        </div>

        <p v-if="movePreviewLoading" class="move-hint">Prüfe…</p>
        <p v-else-if="moveError" class="error">{{ moveError }}</p>

        <div v-else-if="movePreview" class="move-preview">
          <ul class="move-list">
            <li>
              <strong>{{ movePreview.moving_pages.length }}</strong> Wiki-Artikel
              wandern mit
            </li>
            <li>
              <strong>{{
                movePreview.chunk_count + movePreview.wiki_chunk_count
              }}</strong>
              Chunks (Dokument + Wiki) werden umgehängt
            </li>
            <li v-if="movePreview.staying_pages.length">
              <strong>{{ movePreview.staying_pages.length }}</strong>
              Entity-/Concept-Seiten bleiben in „{{
                movePreview.source_workspace.name
              }}“ – sie werden von mehreren Dokumenten geteilt
            </li>
            <li v-if="movePreview.dead_links.length">
              <strong>{{ movePreview.dead_links.length }}</strong> Verweise
              werden zu Klartext aufgelöst, weil ihr Ziel zurückbleibt
            </li>
            <li v-if="movePreview.topics.length">
              Themen:
              {{ movePreview.topics.map((t: any) => t.label).join(", ") }}
              <span v-if="newTopicsInTarget"
                >({{ newTopicsInTarget }} werden im Ziel neu angelegt)</span
              >
            </li>
            <li v-if="movePreview.slug_conflicts.length" class="move-warn">
              {{ movePreview.slug_conflicts.length }} Slug-Konflikte im Ziel –
              die betroffenen Artikel bekommen eine Nummer angehängt
            </li>
          </ul>
          <p class="field-hint">
            Embeddings bleiben erhalten und werden nicht neu berechnet.
          </p>
        </div>

        <div class="dialog-actions">
          <button class="btn-secondary" @click="closeMove">Abbrechen</button>
          <button
            class="btn-primary"
            :disabled="!moveTarget || moving || !movePreview"
            @click="confirmMove"
          >
            {{ moving ? "Verschiebe…" : "Verschieben" }}
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
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import { useWorkspace } from "../../composables/useWorkspace";
import { useConfirm } from "../../composables/useConfirm";
import ConfirmModal from "../../components/ConfirmModal.vue";
import WorkspaceSelect from "../../components/WorkspaceSelect.vue";
import DatePicker from "primevue/datepicker";
import axios from "axios";

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const { resolveWorkspace, isUUID, resolving } = useWorkspace();
const {
  show: showConfirm,
  options: confirmOptions,
  ask: askConfirm,
  onConfirm,
  onCancel,
} = useConfirm();

const rawWorkspaceId = (route.params.id || route.params.workspaceId) as string;
const workspaceId = ref(rawWorkspaceId);

const docs = ref<any[]>([]);
const ws = ref<any>(null);
const loading = ref(true);
const showUpload = ref(false);
const showUrl = ref(false);
const showYoutube = ref(false);
const uploading = ref(false);
const importing = ref(false);
const youtubing = ref(false);
const uploadError = ref("");
const urlError = ref("");
const youtubeError = ref("");
const youtubeInfo = ref("");
const urlInput = ref("");
const youtubeUrl = ref("");

// Filter & Sortierung (Ebene 2)
const TYPES = ["youtube", "url", "pdf", "docx", "html", "md", "txt", "chat"];
const filterQuery = ref("");
const filterType = ref("");
const filterChannel = ref("");
// Range-DatePicker: [von, bis] als Date-Objekte (oder null).
const filterDates = ref<(Date | null)[] | null>(null);
const sortBy = ref("created_desc");
const channels = ref<string[]>([]);
const refreshingId = ref<string | null>(null);
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

// Dokument verschieben
const showMove = ref(false);
const moveDoc = ref<any>(null);
const moveTarget = ref("");
const movePreview = ref<any>(null);
const movePreviewLoading = ref(false);
const moveError = ref("");
const moving = ref(false);

// Zugriff: Besitzer + Mitglieder
const allUsers = ref<any[]>([]);
const members = ref<any[]>([]);
const editOwnerId = ref<number | null>(null);
const newMemberId = ref<string>("");
const newMemberRole = ref("editor");
const memberError = ref("");

// Themen (Ebene 1)
const topics = ref<any[]>([]);
const filterTopicIds = ref<string[]>([]);
const newTopicLabel = ref("");
const suggestions = ref<any[]>([]);
const suggesting = ref(false);
const topicError = ref("");

const hasActiveFilters = computed(
  () =>
    !!(
      filterQuery.value ||
      filterType.value ||
      filterChannel.value ||
      filterDates.value?.[0] ||
      filterTopicIds.value.length
    ) || sortBy.value !== "created_desc",
);

function onSearchInput() {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => loadDocs(), 350);
}

// Range-DatePicker feuert für Start und Ende einzeln. Erst neu laden, wenn der
// Bereich vollständig ist (beide Daten) oder wenn er geleert wurde.
watch(filterDates, (val) => {
  if (!val || !val[0]) {
    loadDocs();
  } else if (val[0] && val[1]) {
    loadDocs();
  }
});

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function clearFilters() {
  filterQuery.value = "";
  filterType.value = "";
  filterChannel.value = "";
  filterDates.value = null;
  filterTopicIds.value = [];
  sortBy.value = "created_desc";
  loadDocs();
}

// ---- Themen (Ebene 1) ----
async function loadTopics() {
  if (!workspaceId.value) return;
  try {
    const res = await axios.get(`/api/v1/topics/${workspaceId.value}`);
    topics.value = res.data.topics || [];
  } catch {
    /* ignore */
  }
}
function toggleTopicFilter(id: string) {
  const i = filterTopicIds.value.indexOf(id);
  if (i >= 0) filterTopicIds.value.splice(i, 1);
  else filterTopicIds.value.push(id);
  loadDocs();
}
async function addTopic() {
  const label = newTopicLabel.value.trim();
  if (!label) return;
  topicError.value = "";
  try {
    await axios.post(`/api/v1/topics/${workspaceId.value}`, { label });
    newTopicLabel.value = "";
    await loadTopics();
  } catch (e: any) {
    topicError.value = e.response?.data?.error || e.message;
  }
}
async function generateSuggestions() {
  suggesting.value = true;
  topicError.value = "";
  suggestions.value = [];
  try {
    const res = await axios.post(`/api/v1/topics/${workspaceId.value}/suggest`);
    suggestions.value = res.data.suggestions || [];
    if (!suggestions.value.length)
      topicError.value =
        "Keine Vorschläge – gibt es schon Wiki-Konzepte in diesem Workspace?";
  } catch (e: any) {
    topicError.value = e.response?.data?.error || e.message;
  } finally {
    suggesting.value = false;
  }
}
async function acceptSuggestions() {
  const existing = new Set(topics.value.map((t: any) => t.slug));
  const toAdd = suggestions.value.filter((s: any) => !existing.has(s.slug));
  if (toAdd.length) {
    await axios.post(`/api/v1/topics/${workspaceId.value}/bulk`, {
      topics: toAdd.map((s: any) => ({
        label: s.label,
        description: s.description,
      })),
    });
  }
  suggestions.value = [];
  await loadTopics();
}
async function removeTopic(id: string) {
  const ok = await askConfirm({
    title: "Thema löschen",
    message: "Thema und alle Zuordnungen entfernen?",
    confirmText: "Löschen",
  });
  if (!ok) return;
  await axios.delete(`/api/v1/topics/${workspaceId.value}/${id}`);
  filterTopicIds.value = filterTopicIds.value.filter((x) => x !== id);
  await loadTopics();
}

async function loadChannels() {
  try {
    const res = await axios.get(
      `/api/v1/documents/${workspaceId.value}/channels`,
    );
    channels.value = res.data.channels || [];
  } catch {
    /* ignore */
  }
}

async function refreshMetadata(doc: any) {
  refreshingId.value = doc.id;
  try {
    const res = await axios.post(
      `/api/v1/documents/${doc.id}/refresh-metadata`,
    );
    const idx = docs.value.findIndex((d: any) => d.id === doc.id);
    if (idx >= 0 && res.data.document) docs.value[idx] = res.data.document;
    await loadChannels();
  } catch (e: any) {
    alert(
      "Metadaten-Aktualisierung fehlgeschlagen: " +
        (e.response?.data?.error || e.message),
    );
  } finally {
    refreshingId.value = null;
  }
}

// Workspace settings
const showSettings = ref(false);
const editName = ref("");
const editDesc = ref("");
const editWikiDepth = ref("capped");
const settingsError = ref("");
const wikiDepthOptions = [
  {
    value: "capped",
    title: "Standard (empfohlen)",
    desc: "Entity-/Concept-Seiten gedeckelt, Auto-Zusammenfassung bei großen Docs",
  },
  {
    value: "full",
    title: "Vollständig",
    desc: "Alles ohne Deckel — maximale Tiefe, mehr Kosten/Zeit",
  },
  {
    value: "summary",
    title: "Nur Zusammenfassung",
    desc: "Nur Kapitel-Artikel, keine Entity-/Concept-Seiten",
  },
  {
    value: "off",
    title: "Aus",
    desc: "Kein Wiki — Dokument bleibt via Chat/Suche auffindbar",
  },
];

// Live activity feed
let activityTimer: ReturnType<typeof setInterval> | null = null;

// Document detail
const showDetail = ref(false);
const selectedDoc = ref<any>(null);
const generatingWiki = ref(false);
const wikiGenResult = ref("");

function startActivityPoll() {
  stopActivityPoll();
  activityTimer = setInterval(async () => {
    try {
      const res = await axios.get("/api/v1/activity", {
        params: { workspace_id: workspaceId.value, limit: 5 },
      });
      const logs = (res.data.logs || []).slice(0, 5);
      const hasRunning = logs.some(
        (l: any) => l.status === "started" || l.status === "processing",
      );
      // Auto-refresh docs wenn Aktivitäten laufen (Logs zeigt die ActivityBar)
      if (hasRunning) {
        await loadDocs();
      } else {
        // Nach Abschluss einmalig docs laden und polling beenden
        await loadDocs();
        stopActivityPoll();
      }
    } catch {
      /* ignore */
    }
  }, 2000);
}

function stopActivityPoll() {
  if (activityTimer) {
    clearInterval(activityTimer);
    activityTimer = null;
  }
}

function openDoc(doc: any) {
  router.push(`/workspaces/${workspaceId.value}/documents/${doc.id}`);
}

async function generateWithConfirm(docId: string) {
  const doc = docs.value.find((d: any) => d.id === docId);
  const ok = await askConfirm({
    title: "Wiki-Artikel generieren",
    message: `Sollen aus dem Dokument „${doc?.title || docId}” Wiki-Artikel erstellt werden? Es werden ein vollständiger Artikel und eine Zusammenfassung generiert.`,
    confirmText: "Generieren",
  });
  if (!ok) return;
  await generateWikiForDoc(docId, true);
}

async function generateWikiForDoc(docId: string, silent = false) {
  if (!silent) generatingWiki.value = true;
  if (!silent) wikiGenResult.value = "";
  try {
    const res = await axios.post(
      `/api/v1/wiki/${workspaceId.value}/generate/${docId}`,
    );
    const pages = res.data.pages || [];
    if (pages.length > 0) {
      if (!silent)
        wikiGenResult.value = `✅ ${pages.length} Artikel erstellt: „${pages[0].title}”`;
    } else {
      if (!silent) wikiGenResult.value = "⚠️ Keine Artikel generiert";
    }
  } catch (e: any) {
    if (!silent)
      wikiGenResult.value = "❌ " + (e.response?.data?.error || e.message);
  } finally {
    if (!silent) generatingWiki.value = false;
  }
}

onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.push("/login");
    return;
  }
  if (!rawWorkspaceId) {
    router.push("/workspaces");
    return;
  }

  // Slug auflösen falls nötig
  if (!isUUID(rawWorkspaceId)) {
    const resolved = await resolveWorkspace(rawWorkspaceId);
    if (!resolved) {
      router.push("/workspaces");
      return;
    }
    workspaceId.value = resolved.id;
  }

  // Zuletzt verwendeten Workspace merken (für Chat-Default)
  if (workspaceId.value) {
    localStorage.setItem("lastWorkspaceId", workspaceId.value);
  }

  await Promise.all([
    loadDocs(),
    loadWorkspace(),
    loadChannels(),
    loadTopics(),
  ]);
  startActivityPoll();
});

onUnmounted(() => {
  stopActivityPoll();
});

async function loadWorkspace() {
  try {
    const res = await axios.get(`/api/v1/workspaces/${workspaceId.value}`);
    ws.value = res.data.workspace;
    editName.value = ws.value.name;
    editDesc.value = ws.value.description || "";
    // Sinnvolle Vorbelegung: gespeicherter Wert, sonst "capped".
    editWikiDepth.value = ws.value.wiki_config?.wiki_depth || "capped";
    editOwnerId.value = ws.value.created_by;
  } catch (e: any) {
    console.error("Failed to load workspace", e);
  }
}

// --- Zugriff: Besitzer & Mitglieder ---------------------------------------

// Erst beim Öffnen des Dialogs laden – User- und Mitgliederliste braucht sonst
// niemand.
watch(showSettings, (open) => {
  if (open) loadAccess();
});

const ownerLabel = computed(() => {
  const owner = allUsers.value.find((u) => u.id === ws.value?.created_by);
  return owner ? `${owner.name} (${owner.email})` : "—";
});

// Mitglieder verwalten darf der Besitzer (und jeder globale Admin).
const canManageMembers = computed(
  () => auth.isAdmin || ws.value?.created_by === auth.user?.id,
);

const invitableUsers = computed(() =>
  allUsers.value.filter(
    (u) =>
      u.id !== ws.value?.created_by &&
      !members.value.some((m) => m.user_id === u.id),
  ),
);

function roleLabel(role: string) {
  if (role === "owner" || role === "admin") return "Besitzer";
  if (role === "editor") return "Bearbeiter";
  return "Leser";
}

async function loadAccess() {
  memberError.value = "";
  try {
    const [usersRes, membersRes] = await Promise.all([
      axios.get("/api/v1/users"),
      axios.get(`/api/v1/workspaces/${workspaceId.value}/members`),
    ]);
    allUsers.value = usersRes.data.users || [];
    members.value = membersRes.data.members || [];
  } catch (e: any) {
    memberError.value = e.response?.data?.error || "Zugriffsdaten nicht ladbar";
  }
}

async function addMember() {
  if (!newMemberId.value) return;
  memberError.value = "";
  try {
    await axios.post(`/api/v1/workspaces/${workspaceId.value}/members`, {
      user_id: Number(newMemberId.value),
      role: newMemberRole.value,
    });
    newMemberId.value = "";
    await loadAccess();
  } catch (e: any) {
    memberError.value = e.response?.data?.error || "Einladen fehlgeschlagen";
  }
}

async function removeMember(userId: number) {
  memberError.value = "";
  try {
    await axios.delete(
      `/api/v1/workspaces/${workspaceId.value}/members/${userId}`,
    );
    await loadAccess();
  } catch (e: any) {
    memberError.value = e.response?.data?.error || "Entfernen fehlgeschlagen";
  }
}

async function updateWs() {
  settingsError.value = "";
  try {
    // Besitzerwechsel ist eine eigene, Admin-geschützte Route.
    if (
      auth.isAdmin &&
      editOwnerId.value &&
      editOwnerId.value !== ws.value.created_by
    ) {
      await axios.put(`/api/v1/workspaces/${workspaceId.value}/owner`, {
        user_id: Number(editOwnerId.value),
      });
    }
    const res = await axios.put(`/api/v1/workspaces/${workspaceId.value}`, {
      name: editName.value,
      description: editDesc.value || undefined,
      wiki_depth: editWikiDepth.value,
    });
    ws.value = res.data.workspace;
    showSettings.value = false;
  } catch (e: any) {
    settingsError.value = e.response?.data?.error || "Fehler beim Speichern";
  }
}

// --- Dokument verschieben --------------------------------------------------

const newTopicsInTarget = computed(
  () =>
    movePreview.value?.topics.filter((t: any) => !t.exists_in_target).length ||
    0,
);

function openMove(doc: any) {
  moveDoc.value = doc;
  moveTarget.value = "";
  movePreview.value = null;
  moveError.value = "";
  showMove.value = true;
}

function closeMove() {
  showMove.value = false;
  moveDoc.value = null;
  movePreview.value = null;
  moveError.value = "";
}

watch(moveTarget, async (target) => {
  movePreview.value = null;
  moveError.value = "";
  if (!target || !moveDoc.value) return;
  movePreviewLoading.value = true;
  try {
    const res = await axios.get(
      `/api/v1/documents/${moveDoc.value.id}/move-preview`,
      { params: { target } },
    );
    movePreview.value = res.data.preview;
  } catch (e: any) {
    moveError.value = e.response?.data?.error || "Vorschau fehlgeschlagen";
  } finally {
    movePreviewLoading.value = false;
  }
});

async function confirmMove() {
  if (!moveTarget.value || !moveDoc.value) return;
  moving.value = true;
  moveError.value = "";
  try {
    await axios.post(`/api/v1/documents/${moveDoc.value.id}/move`, {
      target_workspace_id: moveTarget.value,
    });
    closeMove();
    await loadDocs();
  } catch (e: any) {
    moveError.value = e.response?.data?.error || "Verschieben fehlgeschlagen";
  } finally {
    moving.value = false;
  }
}

async function deleteWs() {
  const ok = await askConfirm({
    title: "Workspace löschen",
    message: `Soll der Workspace „${ws.value?.name}” wirklich gelöscht werden? Alle Dokumente und Wiki-Seiten werden entfernt.`,
    confirmText: "Endgültig löschen",
  });
  if (!ok) return;
  try {
    await axios.delete(`/api/v1/workspaces/${workspaceId.value}`);
    router.push("/workspaces");
  } catch (e: any) {
    settingsError.value =
      "Fehler beim Löschen: " + (e.response?.data?.error || e.message);
  }
}

async function loadDocs() {
  try {
    const params: Record<string, string> = {};
    if (filterQuery.value.trim()) params.q = filterQuery.value.trim();
    if (filterType.value) params.type = filterType.value;
    if (filterChannel.value) params.channel = filterChannel.value;
    // Datumsbereich inklusiv: Start-/Ende des Tages mitschicken.
    const [from, to] = filterDates.value || [];
    if (from) params.from = `${toDateStr(from)}T00:00:00`;
    if (to) params.to = `${toDateStr(to)}T23:59:59`;
    if (filterTopicIds.value.length) params.topics = filterTopicIds.value.join(",");
    if (sortBy.value) params.sort = sortBy.value;
    const res = await axios.get(`/api/v1/documents/${workspaceId.value}`, {
      params,
    });
    docs.value = res.data.documents || [];
  } catch (e: any) {
    console.error("Failed to load docs", e);
  } finally {
    loading.value = false;
  }
}

async function uploadFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  uploading.value = true;
  uploadError.value = "";
  try {
    const form = new FormData();
    form.append("file", file);
    await axios.post(`/api/v1/documents/upload/${workspaceId.value}`, form, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    showUpload.value = false;
    await loadDocs();
    startActivityPoll();
  } catch (e: any) {
    uploadError.value = e.response?.data?.error || e.message;
  } finally {
    uploading.value = false;
  }
}

async function importUrl() {
  importing.value = true;
  urlError.value = "";
  try {
    await axios.post("/api/v1/documents/import-url", {
      workspace_id: workspaceId.value,
      url: urlInput.value,
    });
    showUrl.value = false;
    urlInput.value = "";
    await loadDocs();
    startActivityPoll();
  } catch (e: any) {
    urlError.value = e.response?.data?.error || e.message;
  } finally {
    importing.value = false;
  }
}

async function importYoutube() {
  youtubing.value = true;
  youtubeError.value = "";
  youtubeInfo.value = "";
  try {
    const res = await axios.post("/api/v1/documents/import-youtube", {
      workspace_id: workspaceId.value,
      url: youtubeUrl.value,
    });
    youtubeInfo.value = `✅ ${res.data.document.title}`;
    if (res.data.wiki_page) {
      youtubeInfo.value += ` 📖 Wiki: "${res.data.wiki_page.title}"`;
    }
    showYoutube.value = false;
    youtubeUrl.value = "";
    await loadDocs();
    startActivityPoll();
  } catch (e: any) {
    youtubeError.value = e.response?.data?.error || e.message;
  } finally {
    youtubing.value = false;
  }
}

async function deleteDoc(id: string) {
  const ok = await askConfirm({
    title: "Dokument löschen",
    message: "Soll dieses Dokument wirklich gelöscht werden?",
    confirmText: "Löschen",
  });
  if (!ok) return;
  try {
    await axios.delete(`/api/v1/documents/${id}`);
    docs.value = docs.value.filter((d: any) => d.id !== id);
  } catch {
    alert("Fehler beim Löschen");
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
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.header-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}
.header-left h3 {
  font-size: 1.1rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.header-sub {
  padding: 0.25rem 1.5rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  display: flex;
  align-items: center;
  gap: 1rem;
}
.log-link {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  text-decoration: none;
}
.log-link:hover {
  color: var(--color-primary);
}

.back-link {
  font-size: 0.875rem;
  color: var(--color-primary);
  text-decoration: none;
  white-space: nowrap;
}
.btn-icon {
  background: none;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 0.4rem 0.6rem;
  cursor: pointer;
  font-size: 1.1rem;
  line-height: 1;
}
.btn-icon:hover {
  background: var(--color-bg-secondary);
}
.tab-bar {
  display: flex;
  gap: 0.25rem;
  background: var(--color-bg-secondary);
  border-radius: 8px;
  padding: 0.2rem;
}
.tab {
  padding: 0.4rem 1rem;
  border-radius: 6px;
  text-decoration: none;
  font-size: 0.875rem;
  color: var(--color-text-secondary);
  white-space: nowrap;
}
.tab.active {
  background: white;
  color: var(--color-text);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.tab:hover:not(.active) {
  color: var(--color-text);
}

/* Dialog-Basis (Overlay/Modal) – wird von Settings- und Detail-Dialog genutzt */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 1rem;
}
.dialog {
  background: var(--color-bg);
  color: var(--color-text);
  border-radius: 10px;
  padding: 1.5rem;
  min-width: 400px;
  max-width: 600px;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}
.dialog-wide {
  min-width: 500px;
  max-width: 800px;
}
.dialog h3 {
  margin-bottom: 1rem;
}
.field {
  margin-bottom: 0.75rem;
}
.field label {
  display: block;
  font-size: 0.8rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
  color: var(--color-text-secondary);
}
.field input,
.field select,
.field textarea {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.9rem;
  font-family: inherit;
}
.dialog-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-top: 1rem;
}

/* Settings Dialog */
.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.detail-card {
  background: var(--color-bg-secondary);
  border-radius: 6px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.detail-card strong {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}
.detail-card span {
  font-size: 0.9rem;
  font-weight: 600;
}
.indexing-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 0.5rem;
}
.toggle-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  padding: 0.4rem 0;
}

/* Wiki-Tiefe-Selektor */
.wiki-depth-options {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.depth-row {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  cursor: pointer;
}
.depth-row input {
  margin: 0.15rem 0 0;
  flex-shrink: 0;
}
.depth-row.active {
  border-color: var(--color-primary);
  background: var(--color-bg-secondary);
}
.depth-text {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
}
.depth-title {
  font-size: 0.85rem;
  font-weight: 600;
}
.depth-desc {
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--color-text-secondary);
}
.field-hint {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin-top: 0.4rem;
}

/* Zugriff (Besitzer/Mitglieder) + Verschieben-Dialog */
.access-select {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.9rem;
  flex: 1;
  min-width: 0;
}
.role-select {
  flex: 0 0 auto;
  min-width: 120px;
}
.field-static {
  font-size: 0.9rem;
  color: var(--color-text);
  padding: 0.25rem 0;
}
.move-doc-title {
  font-size: 0.9rem;
  color: var(--color-text-secondary);
  margin-bottom: 1rem;
  word-break: break-word;
}
.move-hint {
  font-size: 0.85rem;
  color: var(--color-text-secondary);
}
.move-preview {
  background: var(--color-bg-secondary);
  border-radius: 8px;
  padding: 0.75rem 1rem;
  margin-top: 0.5rem;
}
.move-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: 0.85rem;
  line-height: 1.4;
}
.move-list .move-warn {
  color: #d97706;
}

/* Document Detail Dialog */
.doc-meta-bar {
  display: flex;
  gap: 1rem;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  margin-bottom: 1rem;
  flex-wrap: wrap;
  align-items: center;
}
.doc-content-box {
  max-height: 60vh;
  overflow-y: auto;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1rem;
}
.doc-content-box pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-size: 0.85rem;
  line-height: 1.6;
  font-family: inherit;
  margin: 0;
}

.content {
  padding: 1.5rem;
}

/* Filter- & Sortierleiste (Ebene 2) */
.filter-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.75rem 1.5rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}
.filter-bar select {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.85rem;
  background: var(--color-bg);
  color: var(--color-text);
}
/* PrimeVue DatePicker an die Höhe/Optik der übrigen Filter angleichen */
.filter-datepicker {
  min-width: 210px;
}
.filter-datepicker :deep(input) {
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
  border-radius: 6px;
}
.filter-search {
  flex: 1;
  min-width: 180px;
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.85rem;
  background: var(--color-bg);
  color: var(--color-text);
}
.btn-clear {
  padding: 0.35rem 0.7rem;
  font-size: 0.8rem;
}

/* Themen-Filter-Chips */
.topic-filter-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  padding: 0.6rem 1.5rem;
  border-bottom: 1px solid var(--color-border);
}
.topic-filter-label {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-right: 0.2rem;
}
.topic-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.8rem;
  cursor: pointer;
  font-family: inherit;
}
.topic-chip:hover {
  border-color: var(--color-primary);
}
.topic-chip.active {
  background: var(--color-primary);
  color: #fff;
  border-color: var(--color-primary);
}
.topic-chip-count {
  font-size: 0.68rem;
  opacity: 0.8;
}

/* Themen-Verwaltung im Settings-Modal */
.topic-manage-toolbar {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}
.topic-input {
  flex: 1;
  min-width: 140px;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.85rem;
}
.topic-suggestions {
  background: var(--color-bg-secondary);
  border-radius: 6px;
  padding: 0.5rem 0.6rem;
  margin-bottom: 0.5rem;
}
.suggest-hint {
  font-size: 0.8rem;
  margin-bottom: 0.4rem;
  color: var(--color-text-secondary);
}
.link-btn {
  background: none;
  border: none;
  color: var(--color-primary);
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0;
  font-family: inherit;
  text-decoration: underline;
}
.suggest-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.suggest-chip {
  padding: 0.2rem 0.5rem;
  background: var(--color-bg);
  border: 1px dashed var(--color-border);
  border-radius: 12px;
  font-size: 0.78rem;
}
.topic-manage-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  max-height: 220px;
  overflow-y: auto;
}
.topic-manage-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
}
.topic-manage-label {
  flex: 1;
  font-size: 0.85rem;
}
.topic-manage-count {
  font-size: 0.72rem;
  color: var(--color-text-secondary);
  background: var(--color-bg-secondary);
  border-radius: 8px;
  padding: 0.05rem 0.4rem;
}
.topic-manage-del {
  background: none;
  border: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 0.8rem;
}
.topic-manage-del:hover {
  color: #e74c3c;
}
.topic-empty {
  font-size: 0.82rem;
  color: var(--color-text-secondary);
}

.upload-area {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
}
.file-input {
  max-width: 300px;
}
.url-input {
  flex: 1;
  min-width: 200px;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.9rem;
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
.doc-title {
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-subtitle {
  display: block;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  font-weight: normal;
  margin-top: 0.15rem;
}
.type-badge {
  font-size: 0.75rem;
  padding: 0.125rem 0.5rem;
  background: var(--color-bg-secondary);
  border-radius: 4px;
}
.status {
  font-size: 0.8rem;
}
.status.processing {
  color: #f57c00;
}
.status.completed {
  color: #2e7d32;
}
.status.failed {
  color: #d32f2f;
}
.date {
  white-space: nowrap;
  color: var(--color-text-secondary);
  font-size: 0.8rem;
}

.loading {
  padding: 2rem;
  color: var(--color-text-secondary);
}
.empty {
  text-align: center;
  padding: 4rem 2rem;
  color: var(--color-text-secondary);
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
.btn-icon-sm {
  padding: 0.25rem 0.5rem;
  background: none;
  border: 1px solid var(--color-border);
  color: var(--color-text);
  border-radius: 4px;
  font-size: 0.8rem;
  cursor: pointer;
  margin-right: 0.25rem;
}
.btn-icon-sm:hover {
  background: var(--color-bg-secondary);
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
.btn-danger {
  padding: 0.4rem 0.85rem;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  border: none;
  cursor: pointer;
  transition: opacity 0.15s;
  white-space: nowrap;
  background: #f44336;
  color: #fff;
}
.btn-danger:hover {
  opacity: 0.9;
}
.error {
  color: #d32f2f;
  font-size: 0.875rem;
}

@media (max-width: 768px) {
  .header {
    padding: 0.75rem 1rem;
    gap: 0.6rem;
  }
  .header-actions {
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .header-actions .btn-primary {
    padding: 0.4rem 0.6rem;
    font-size: 0.8rem;
  }
  .content {
    padding: 0.75rem;
  }
  .upload-area {
    padding: 0.75rem 1rem;
  }
  .filter-bar {
    padding: 0.6rem 1rem;
  }
  .filter-search {
    min-width: 100%;
  }
  .file-input,
  .url-input {
    max-width: none;
    width: 100%;
  }
  /* Kompaktere Tabelle: Typ- und Datums-Spalte auf dem Handy ausblenden */
  .table th:nth-child(2),
  .table td:nth-child(2),
  .table th:nth-child(4),
  .table td:nth-child(4) {
    display: none;
  }
  .table th,
  .table td {
    padding: 0.55rem 0.5rem;
  }
  .doc-title {
    max-width: 55vw;
  }
  /* Dialoge an schmale Screens anpassen */
  .dialog,
  .dialog-wide {
    min-width: 0;
    width: calc(100vw - 2rem);
    max-width: calc(100vw - 2rem);
  }
}
</style>

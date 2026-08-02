<template>
  <!-- Dezente, app-weite Log-Leiste am unteren Rand. Nur sichtbar, wenn es
       einen Workspace-Kontext gibt oder gerade Aktivität läuft. -->
  <div v-if="workspaceId" class="activity-bar" :class="{ expanded }">
    <!-- Kopfzeile: immer sichtbar, klickbar zum Auf-/Zuklappen -->
    <button class="activity-head" @click="expanded = !expanded">
      <span class="activity-status" :class="statusClass">
        <i v-if="running" class="pi pi-spin pi-spinner"></i>
        <i v-else class="pi pi-check-circle"></i>
      </span>
      <span class="activity-label">{{ headline }}</span>
      <span class="activity-spacer"></span>
      <span v-if="latest" class="activity-time">{{
        formatTime(latest.created_at)
      }}</span>
      <i
        class="pi activity-chevron"
        :class="expanded ? 'pi-chevron-down' : 'pi-chevron-up'"
      ></i>
    </button>

    <!-- Aufgeklappt: Liste der letzten Aktivitäten -->
    <div v-if="expanded" class="activity-list">
      <div v-if="activities.length === 0" class="activity-empty">
        Keine Aktivitäten in diesem Workspace.
      </div>
      <div
        v-for="a in activities"
        :key="a.id"
        class="activity-item"
        :class="`status-${a.status}`"
      >
        <span class="item-icon">
          <i v-if="a.status === 'started'" class="pi pi-spin pi-spinner"></i>
          <i v-else-if="a.status === 'failed'" class="pi pi-times-circle"></i>
          <i v-else class="pi pi-check-circle"></i>
        </span>
        <span class="item-action">{{ actionLabel(a.action) }}</span>
        <span class="item-message">{{ a.message }}</span>
        <span v-if="a.duration_ms" class="item-duration"
          >{{ (a.duration_ms / 1000).toFixed(1) }}s</span
        >
        <span class="item-time">{{ formatTime(a.created_at) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from "vue";
import { useRoute } from "vue-router";
import axios from "axios";

const route = useRoute();
const expanded = ref(false);
const activities = ref<any[]>([]);
let timer: ReturnType<typeof setInterval> | null = null;
// Merkt sich, ob im vorherigen Poll bereits eine Aktivität lief, damit nur bei
// der steigenden Flanke (Ruhe → Aktivität) automatisch aufgeklappt wird.
let wasRunning = false;

// Aktive Workspace-ID aus Route (oder gemerkter letzter Workspace).
const workspaceId = computed(() => {
  const fromRoute = route.params.id as string | undefined;
  if (fromRoute) return fromRoute;
  return localStorage.getItem("knora-last-workspace") || "";
});

const latest = computed(() => activities.value[0] || null);
const running = computed(() =>
  activities.value.some(
    (a) => a.status === "started" || a.status === "processing",
  ),
);

const statusClass = computed(() => {
  if (running.value) return "running";
  if (activities.value.some((a) => a.status === "failed")) return "failed";
  return "idle";
});

const headline = computed(() => {
  if (running.value && latest.value)
    return latest.value.message || "Verarbeitung läuft…";
  if (activities.value.length === 0) return "Keine Aktivität";
  return "Bereit";
});

const ACTION_LABELS: Record<string, string> = {
  youtube_import: "YouTube-Import",
  document_upload: "Upload",
  url_import: "URL-Import",
  wiki_generate: "Wiki-Generierung",
};
function actionLabel(action: string) {
  return ACTION_LABELS[action] || action;
}

function formatTime(ts: string) {
  try {
    return new Date(ts).toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

async function poll() {
  const ws = workspaceId.value;
  if (!ws) return;
  try {
    const res = await axios.get("/api/v1/activity", {
      params: { workspace_id: ws, limit: 8 },
    });
    activities.value = res.data.logs || [];
    // Bei *neu* startender Aktivität einmalig aufklappen (steigende Flanke) und
    // schnell weiter pollen. Ein manuelles Einklappen bleibt danach erhalten –
    // sonst würde ein hängender „started"-Eintrag die Leiste bei jedem Poll
    // wieder aufreißen.
    if (running.value) {
      if (!wasRunning && !expanded.value) expanded.value = true;
      ensureFastPoll();
    } else {
      ensureSlowPoll();
    }
    wasRunning = running.value;
  } catch {
    /* still bleiben – die Leiste soll nie die App stören */
  }
}

// Zwei Poll-Geschwindigkeiten: schnell (2s) während Aktivität, langsam (10s)
// im Ruhezustand, damit die DB nicht unnötig belastet wird.
let currentInterval = 0;
function setPoll(ms: number) {
  if (currentInterval === ms && timer) return;
  if (timer) clearInterval(timer);
  currentInterval = ms;
  timer = setInterval(poll, ms);
}
function ensureFastPoll() {
  setPoll(2000);
}
function ensureSlowPoll() {
  setPoll(10000);
}

// Poll (neu) starten, sobald sich der Workspace ändert.
watch(
  workspaceId,
  (ws) => {
    if (ws) {
      poll();
      ensureSlowPoll();
    } else if (timer) {
      clearInterval(timer);
      timer = null;
      currentInterval = 0;
    }
  },
  { immediate: true },
);

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.activity-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 40;
  background: var(--color-bg);
  border-top: 1px solid var(--color-border);
  font-size: 0.8rem;
  box-shadow: 0 -1px 6px rgba(0, 0, 0, 0.06);
}

.activity-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 1rem;
  background: none;
  border: none;
  color: var(--color-text);
  text-align: left;
}
.activity-head:hover {
  background: var(--color-bg-secondary);
}

.activity-status {
  display: flex;
  align-items: center;
}
.activity-status.running {
  color: #f59e0b;
}
.activity-status.failed {
  color: #ef4444;
}
.activity-status.idle {
  color: #10b981;
}

.activity-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60vw;
}
.activity-spacer {
  flex: 1;
}
.activity-time {
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}
.activity-chevron {
  color: var(--color-text-secondary);
  font-size: 0.75rem;
}

.activity-list {
  max-height: 220px;
  overflow-y: auto;
  border-top: 1px solid var(--color-border);
  padding: 0.25rem 0;
}

.activity-empty {
  padding: 0.75rem 1rem;
  color: var(--color-text-secondary);
}

.activity-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.35rem 1rem;
}
.activity-item:hover {
  background: var(--color-bg-secondary);
}

.item-icon {
  width: 1rem;
  display: flex;
  justify-content: center;
}
.status-started .item-icon {
  color: #f59e0b;
}
.status-failed .item-icon {
  color: #ef4444;
}
.status-completed .item-icon {
  color: #10b981;
}

.item-action {
  font-weight: 600;
  flex-shrink: 0;
  min-width: 8rem;
}
.item-message {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
}
.item-duration {
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.item-time {
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

/* Auf Mobil sitzt die Bottom-Nav (56px) am unteren Rand – Log-Leiste darüber schieben */
@media (max-width: 768px) {
  .activity-bar {
    bottom: calc(56px + env(safe-area-inset-bottom, 0px));
  }
}
</style>

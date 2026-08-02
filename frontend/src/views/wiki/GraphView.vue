<template>
  <div class="graph-view">
    <div class="graph-controls">
      <div class="control-row">
        <div v-if="focus" class="focus-info">
          Fokus: <strong>{{ focusTitle }}</strong>
          <button class="btn-mini" @click="clearFocus">✕ Übersicht</button>
        </div>
        <div v-else class="focus-hint">
          Klicke einen Knoten, um seinen Subgraph zu zeigen.
        </div>
      </div>

      <div class="control-row">
        <div class="search-wrap">
          <input
            v-model="search"
            @input="onSearch"
            placeholder="🔍 Konzept / Entität / Artikel fokussieren…"
            class="graph-search"
          />
          <div v-if="suggestions.length" class="graph-suggest">
            <button
              v-for="s in suggestions"
              :key="s.slug"
              class="suggest-row"
              @click="refocus(s.slug, s.title)"
            >
              <span class="dot" :style="{ background: color(s.page_type) }"></span>
              {{ s.title }}
            </button>
          </div>
        </div>

        <label
          v-for="t in TYPES"
          :key="t.value"
          class="type-check"
        >
          <input
            type="checkbox"
            :value="t.value"
            v-model="activeTypes"
            @change="loadGraph"
          />
          <span class="dot" :style="{ background: t.color }"></span>{{ t.label }}
        </label>

        <label class="type-check" v-if="focus">
          <input type="checkbox" v-model="edgesToFocusOnly" @change="draw" />
          nur Kanten zum Fokus
        </label>

        <button class="btn-mini" @click="fit">⤢ Fit</button>
      </div>
    </div>

    <div class="graph-canvas" ref="canvasWrap">
      <div v-if="loading" class="graph-status">Lade Graph…</div>
      <div v-else-if="!nodes.length" class="graph-status">
        Keine Graph-Daten. Generiere zuerst Wiki-Artikel mit Verlinkungen.
      </div>
      <svg v-show="nodes.length && !loading" ref="svgEl"></svg>
      <div class="graph-meta" v-if="nodes.length && !loading">
        {{ nodes.length }} Knoten · {{ edges.length }} Kanten
      </div>

      <!-- Seiten-Drawer: Artikel zum angeklickten Knoten -->
      <div v-if="selectedNode" class="graph-drawer">
        <div class="drawer-head">
          <div class="drawer-top">
            <span
              class="type-badge"
              :style="{ color: color(pageDetail?.page_type || selectedNode.type) }"
            >
              {{ typeLabel(pageDetail?.page_type || selectedNode.type) }}
            </span>
            <span v-if="pageDetail" class="drawer-ver">v{{ pageDetail.version }}</span>
            <button class="drawer-close" @click="closeDrawer">✕</button>
          </div>
          <h2 class="drawer-title">
            {{ stripWiki(pageDetail?.title || selectedNode.title) }}
          </h2>
          <div class="drawer-actions">
            <button class="btn-mini" @click="expandNeighbors">
              🔎 Nachbarn zeigen
            </button>
            <button class="btn-mini" @click="openInWiki">📖 Im Wiki öffnen</button>
          </div>
        </div>
        <div class="drawer-body">
          <div v-if="detailLoading" class="graph-status">Lädt…</div>
          <div
            v-else-if="drawerContent"
            class="wiki-content"
            v-html="drawerContent"
            @click="onDrawerClick"
          ></div>
          <p v-else class="focus-hint">Kein Inhalt für diese Seite.</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import { useWorkspace } from "../../composables/useWorkspace";
import axios from "axios";
import * as d3 from "d3";

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const { resolveWorkspace, isUUID } = useWorkspace();

const rawWorkspaceId = computed(
  () => ((route.params.id || route.params.workspaceId) as string) || "",
);
const workspaceId = ref(rawWorkspaceId.value);

const TYPES = [
  { value: "summary", label: "Artikel", color: "#0052d9" },
  { value: "entity", label: "Entitäten", color: "#2ba471" },
  { value: "concept", label: "Konzepte", color: "#e37318" },
];
function color(type: string): string {
  return TYPES.find((t) => t.value === type)?.color || "#888";
}

const focus = ref((route.query.focus as string) || "");
const focusTitle = ref((route.query.focusTitle as string) || "");
const activeTypes = ref<string[]>(["summary", "entity", "concept"]);
const edgesToFocusOnly = ref(false);
const nodes = ref<any[]>([]);
const edges = ref<any[]>([]);
const loading = ref(false);
const search = ref("");
const suggestions = ref<any[]>([]);
const selectedNode = ref<any>(null);
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

const svgEl = ref<SVGSVGElement>();
const canvasWrap = ref<HTMLElement>();
let sim: any = null;
let zoomBehavior: any = null;
let gRoot: any = null;

function stripWiki(text: string): string {
  return (text || "").replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m, slug, label) => label || slug.replace(/^.*\//, "").replace(/-/g, " "),
  );
}

onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.push("/login");
    return;
  }
  if (rawWorkspaceId.value && !isUUID(rawWorkspaceId.value)) {
    const resolved = await resolveWorkspace(rawWorkspaceId.value);
    if (resolved) workspaceId.value = resolved.id;
  }
  await loadGraph();
});

watch(rawWorkspaceId, async (v) => {
  if (v && !isUUID(v)) {
    const r = await resolveWorkspace(v);
    if (r) workspaceId.value = r.id;
  } else if (v) {
    workspaceId.value = v;
  }
  loadGraph();
});

onBeforeUnmount(() => {
  if (sim) sim.stop();
});

async function loadGraph() {
  if (!workspaceId.value) return;
  loading.value = true;
  try {
    const params: Record<string, string> = { limit: "150" };
    if (focus.value) params.focus = focus.value;
    if (activeTypes.value.length && activeTypes.value.length < TYPES.length)
      params.types = activeTypes.value.join(",");
    const res = await axios.get(`/api/v1/wiki/${workspaceId.value}/graph`, {
      params,
    });
    nodes.value = res.data.nodes || [];
    edges.value = res.data.edges || [];
    if (focus.value && !focusTitle.value) {
      const f = nodes.value.find((n) => n.slug === focus.value);
      if (f) focusTitle.value = stripWiki(f.title);
    }
  } catch (e) {
    nodes.value = [];
    edges.value = [];
  } finally {
    loading.value = false;
    // Nächster Tick: SVG ist sichtbar → zeichnen
    requestAnimationFrame(() => draw());
  }
}

function syncUrl() {
  const query: Record<string, string> = {};
  if (focus.value) {
    query.focus = focus.value;
    if (focusTitle.value) query.focusTitle = focusTitle.value;
  }
  router.replace({ query }).catch(() => {});
}

function refocus(slug: string, title?: string) {
  focus.value = slug;
  focusTitle.value = title ? stripWiki(title) : "";
  search.value = "";
  suggestions.value = [];
  syncUrl();
  loadGraph();
}
function clearFocus() {
  focus.value = "";
  focusTitle.value = "";
  syncUrl();
  loadGraph();
}

// ---- Seiten-Drawer: Artikelinhalt zum angeklickten Knoten ----
const pageDetail = ref<any>(null);
const detailLoading = ref(false);

async function openNode(slug: string, title: string) {
  selectedNode.value = { slug, title };
  detailLoading.value = true;
  pageDetail.value = null;
  try {
    const res = await axios.get(
      `/api/v1/wiki/${workspaceId.value}/pages/${encodeURIComponent(slug)}`,
    );
    pageDetail.value = res.data.page || null;
  } catch {
    pageDetail.value = null;
  } finally {
    detailLoading.value = false;
  }
}
function closeDrawer() {
  selectedNode.value = null;
  pageDetail.value = null;
}
function expandNeighbors() {
  if (selectedNode.value) refocus(selectedNode.value.slug, selectedNode.value.title);
}
function openInWiki() {
  if (!selectedNode.value) return;
  router.push(
    `/workspaces/${rawWorkspaceId.value}/wiki/${encodeURIComponent(selectedNode.value.slug)}`,
  );
}
function typeLabel(type: string): string {
  return (
    { summary: "Artikel", entity: "Entität", concept: "Konzept" } as Record<string, string>
  )[type] || type;
}
const drawerContent = computed(() =>
  pageDetail.value?.content ? renderContent(pageDetail.value.content) : "",
);
function renderContent(content: string): string {
  let html = content.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_m: string, slug: string, text?: string) => {
      const label = text || slug.replace(/^.*\//, "").replace(/-/g, " ");
      return `<a href="#" data-slug="${encodeURIComponent(slug)}" class="wiki-link">${label}</a>`;
    },
  );
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m: string, label: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer" class="ext-link">${label} ↗</a>`,
  );
  html = html
    .replace(/^### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^## (.+)$/gm, "<h3>$1</h3>")
    .replace(/^# (.+)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br/>");
  return `<p>${html}</p>`;
}
// In-Drawer auf interne Links klicken → im Drawer weiternavigieren (Pivot).
function onDrawerClick(e: MouseEvent) {
  const a = (e.target as HTMLElement)?.closest("a.wiki-link");
  if (!a) return;
  const slug = a.getAttribute("data-slug");
  if (slug) {
    e.preventDefault();
    openNode(decodeURIComponent(slug), "");
  }
}

function onSearch() {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    const q = search.value.trim();
    if (!q) {
      suggestions.value = [];
      return;
    }
    try {
      const res = await axios.get(
        `/api/v1/wiki/${workspaceId.value}/suggestions`,
        { params: { q } },
      );
      suggestions.value = (res.data.suggestions || []).slice(0, 8);
    } catch {
      suggestions.value = [];
    }
  }, 300);
}

// ---- d3 Rendering ----
function radiusFor(maxConn: number) {
  return d3.scaleSqrt().domain([0, Math.max(1, maxConn)]).range([5, 22]);
}

function draw() {
  if (!svgEl.value || !canvasWrap.value || !nodes.value.length) return;
  if (sim) sim.stop();

  const width = canvasWrap.value.clientWidth || 800;
  const height = canvasWrap.value.clientHeight || 600;
  const svg = d3.select(svgEl.value);
  svg.selectAll("*").remove();
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  gRoot = svg.append("g");
  zoomBehavior = d3
    .zoom()
    .scaleExtent([0.1, 4])
    .on("zoom", (e: any) => gRoot.attr("transform", e.transform));
  svg.call(zoomBehavior as any);

  const nodeData = nodes.value.map((n) => ({ ...n }));
  const idSet = new Set(nodeData.map((n) => n.slug));
  let linkData = edges.value
    .filter((e) => idSet.has(e.source) && idSet.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));
  if (edgesToFocusOnly.value && focus.value) {
    linkData = linkData.filter(
      (l) => l.source === focus.value || l.target === focus.value,
    );
  }

  const maxConn = d3.max(nodeData, (d: any) => d.connections) || 1;
  const r = radiusFor(maxConn);
  // Labels: bei kleiner Menge alle, sonst Fokus + die vernetztesten.
  const sorted = [...nodeData].sort(
    (a: any, b: any) => b.connections - a.connections,
  );
  const labelSet = new Set(
    nodeData.length <= 45
      ? nodeData.map((n: any) => n.slug)
      : sorted.slice(0, 30).map((n: any) => n.slug),
  );
  if (focus.value) labelSet.add(focus.value);

  const link = gRoot
    .append("g")
    .attr("stroke", "var(--color-border)")
    .attr("stroke-opacity", 0.4)
    .selectAll("line")
    .data(linkData)
    .join("line")
    .attr("stroke-width", 1);

  const node = gRoot
    .append("g")
    .selectAll("circle")
    .data(nodeData)
    .join("circle")
    .attr("r", (d: any) => r(d.connections))
    .attr("fill", (d: any) => color(d.type))
    .attr("stroke", (d: any) => (d.slug === focus.value ? "#111" : "#fff"))
    .attr("stroke-width", (d: any) => (d.slug === focus.value ? 3 : 1.5))
    .style("cursor", "pointer")
    .on("click", (_e: any, d: any) => openNode(d.slug, d.title))
    .on("dblclick", (_e: any, d: any) => refocus(d.slug, d.title))
    .call(drag() as any);
  node.append("title").text((d: any) => stripWiki(d.title));

  const label = gRoot
    .append("g")
    .selectAll("text")
    .data(nodeData.filter((d: any) => labelSet.has(d.slug)))
    .join("text")
    .text((d: any) => stripWiki(d.title).slice(0, 28))
    .attr("font-size", 10)
    .attr("dx", 9)
    .attr("dy", 3)
    .attr("fill", "var(--color-text)")
    .style("pointer-events", "none");

  sim = d3
    .forceSimulation(nodeData as any)
    .force(
      "link",
      d3
        .forceLink(linkData as any)
        .id((d: any) => d.slug)
        .distance(70)
        .strength(0.25),
    )
    .force("charge", d3.forceManyBody().strength(-140))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force(
      "collide",
      d3.forceCollide().radius((d: any) => r(d.connections) + 4),
    )
    .on("tick", () => {
      link
        .attr("x1", (d: any) => d.source.x)
        .attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x)
        .attr("y2", (d: any) => d.target.y);
      node.attr("cx", (d: any) => d.x).attr("cy", (d: any) => d.y);
      label.attr("x", (d: any) => d.x).attr("y", (d: any) => d.y);
    });
}

function drag() {
  return d3
    .drag()
    .on("start", (e: any) => {
      if (!e.active) sim.alphaTarget(0.3).restart();
      e.subject.fx = e.subject.x;
      e.subject.fy = e.subject.y;
    })
    .on("drag", (e: any) => {
      e.subject.fx = e.x;
      e.subject.fy = e.y;
    })
    .on("end", (e: any) => {
      if (!e.active) sim.alphaTarget(0);
      e.subject.fx = null;
      e.subject.fy = null;
    });
}

function fit() {
  if (!svgEl.value || !zoomBehavior) return;
  d3.select(svgEl.value)
    .transition()
    .duration(300)
    .call(zoomBehavior.transform as any, d3.zoomIdentity);
}
</script>

<style scoped>
.graph-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.graph-controls {
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  background: var(--color-bg);
}
.control-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.focus-info,
.focus-hint {
  font-size: 0.85rem;
  color: var(--color-text-secondary);
}
.focus-info strong {
  color: var(--color-text);
}
.search-wrap {
  position: relative;
  flex: 1;
  min-width: 220px;
}
.graph-search {
  width: 100%;
  padding: 0.4rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: 0.85rem;
}
.graph-suggest {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 20;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  margin-top: 2px;
  max-height: 260px;
  overflow-y: auto;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
}
.suggest-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  text-align: left;
  padding: 0.45rem 0.6rem;
  border: none;
  background: none;
  color: var(--color-text);
  font-size: 0.82rem;
  cursor: pointer;
  font-family: inherit;
}
.suggest-row:hover {
  background: var(--color-bg-secondary);
}
.type-check {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.btn-mini {
  padding: 0.3rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.8rem;
  cursor: pointer;
  font-family: inherit;
}
.btn-mini:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.graph-canvas {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: var(--color-content-bg);
}
.graph-canvas svg {
  width: 100%;
  height: 100%;
  display: block;
}
.graph-status {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  font-size: 0.9rem;
}
.graph-meta {
  position: absolute;
  bottom: 0.5rem;
  right: 0.75rem;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  background: var(--color-bg);
  padding: 0.2rem 0.5rem;
  border-radius: 6px;
  border: 1px solid var(--color-border);
}

/* Seiten-Drawer */
.graph-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(460px, 92%);
  background: var(--color-bg);
  border-left: 1px solid var(--color-border);
  box-shadow: -8px 0 30px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  z-index: 30;
}
.drawer-head {
  padding: 1rem 1.1rem 0.75rem;
  border-bottom: 1px solid var(--color-border);
}
.drawer-top {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.type-badge {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.drawer-ver {
  font-size: 0.72rem;
  color: var(--color-text-secondary);
}
.drawer-close {
  margin-left: auto;
  background: none;
  border: none;
  font-size: 1rem;
  cursor: pointer;
  color: var(--color-text-secondary);
}
.drawer-close:hover {
  color: var(--color-text);
}
.drawer-title {
  font-size: 1.2rem;
  line-height: 1.3;
  margin: 0.5rem 0 0.6rem;
  overflow-wrap: anywhere;
}
.drawer-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.1rem 2rem;
  position: relative;
}
.wiki-content {
  line-height: 1.7;
  font-size: 0.9rem;
  overflow-wrap: anywhere;
}
.wiki-content :deep(h2) {
  font-size: 1.1rem;
  margin: 1.2rem 0 0.6rem;
}
.wiki-content :deep(h3) {
  font-size: 1rem;
  margin: 1rem 0 0.5rem;
}
.wiki-content :deep(h4) {
  font-size: 0.92rem;
  margin: 0.9rem 0 0.4rem;
}
.wiki-content :deep(p) {
  margin-bottom: 0.7rem;
}
.wiki-content :deep(ul) {
  margin: 0.5rem 0 0.7rem 1.4rem;
}
.wiki-content :deep(.wiki-link) {
  color: var(--color-primary);
  text-decoration: underline;
  text-decoration-style: dotted;
  cursor: pointer;
}
.wiki-content :deep(.ext-link) {
  color: var(--color-primary);
}
@media (max-width: 768px) {
  .graph-drawer {
    width: 100%;
  }
}
</style>

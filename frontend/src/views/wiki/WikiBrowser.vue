<template>
  <div class="wiki-layout" :class="{ reader: selectedPage }">
    <!-- Facetten-Rail (Discovery) / Filter + Ergebnis-Navigation (Reader) -->
    <aside class="wiki-rail">
      <div class="rail-search">
        <input
          v-model="searchQuery"
          @input="onSearch"
          placeholder="🔍 Wiki durchsuchen..."
          class="search-input"
        />
      </div>

      <!-- Einklappbar im Reader-Modus (Desktop) und generell auf Mobile
           (Accordion); in der Desktop-Discovery-Ansicht immer offen. -->
      <button
        v-if="selectedPage || isMobile"
        class="rail-toggle"
        @click="showFacets = !showFacets"
      >
        <span>{{ showFacets ? "▾" : "▸" }} Filter &amp; Sortierung</span>
        <span v-if="activeFilterCount" class="cnt">{{ activeFilterCount }}</span>
      </button>

      <div
        class="rail-facets"
        v-show="showFacets || (!selectedPage && !isMobile)"
      >
        <div class="facet-group">
          <div class="facet-label">Typ</div>
          <div class="type-facets">
            <button
              v-for="tab in tabs"
              :key="tab.type"
              :class="['type-facet', { active: activeTab === tab.type }]"
              @click="setActiveTab(tab.type)"
            >
              <span>{{ tab.label }}</span>
              <span class="cnt">{{ tab.total }}</span>
            </button>
          </div>
        </div>

        <!-- Zeitleiste: Jahr → Monat mit Trefferzahlen. Der wichtigste Zugang
             bei datierten Beständen – der Datumsfilter allein setzt voraus,
             dass man den gesuchten Zeitraum schon kennt. -->
        <div class="facet-group" v-if="monthsByYear.length">
          <div class="facet-label">Zeitleiste</div>
          <div class="timeline">
            <div v-for="y in monthsByYear" :key="y.year" class="tl-year">
              <button class="tl-year-head" @click="openYears[y.year] = !openYears[y.year]">
                <span>{{ openYears[y.year] ? "▾" : "▸" }} {{ y.year }}</span>
                <span class="cnt">{{ y.total }}</span>
              </button>
              <div v-show="openYears[y.year]" class="tl-months">
                <button
                  v-for="m in y.months"
                  :key="m.month"
                  class="tl-month"
                  :title="`${m.count} Treffer in ${m.month}`"
                  @click="selectMonth(m.month)"
                >
                  <span>{{ m.label }}</span>
                  <span class="cnt">{{ m.count }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Auffälligkeiten: der direkte Weg zu den brisanten Sitzungen,
             statt sie im Bestand suchen zu müssen. -->
        <div class="facet-group" v-if="flagFacets.length">
          <div class="facet-label">Auffälligkeiten</div>
          <div class="topic-facets">
            <button
              v-for="f in flagFacets"
              :key="f.flag"
              :class="['topic-facet', { active: filterFlags.includes(f.flag) }]"
              @click="toggleFlagFilter(f.flag)"
              :title="`${f.count} Artikel mit diesem Marker`"
            >
              <span>{{ flagLabel(f.flag) }}</span>
              <span class="cnt">{{ f.count }}</span>
            </button>
          </div>
        </div>

        <div class="facet-group" v-if="allTopics.length">
          <div class="facet-label">Themen</div>
          <div class="topic-facets">
            <button
              v-for="t in allTopics"
              :key="t.id"
              :class="['topic-facet', { active: filterTopicIds.includes(t.id) }]"
              @click="toggleTopicFilter(t.id)"
            >
              <span>{{ t.label }}</span>
              <span class="cnt" v-if="t.doc_count">{{ t.doc_count }}</span>
            </button>
          </div>
        </div>

        <div class="facet-group" v-if="topConceptsList.length">
          <div class="facet-label">Top-Konzepte</div>
          <div class="topic-facets">
            <button
              v-for="c in topConceptsList"
              :key="c.id"
              :class="['topic-facet', { active: filterReferences === c.slug }]"
              @click="setReferenceFilter(c.slug, stripWikiLinks(c.title))"
              :title="`${c.connections} Artikel verweisen darauf`"
            >
              <span>{{ stripWikiLinks(c.title) }}</span>
              <span class="cnt">{{ c.connections }}</span>
            </button>
          </div>
        </div>

        <div class="facet-group" v-if="channels.length">
          <div class="facet-label">Kanal</div>
          <select v-model="filterChannel" @change="applyFilters" class="facet-select">
            <option value="">Alle Kanäle</option>
            <option v-for="ch in channels" :key="ch" :value="ch">{{ ch }}</option>
          </select>
        </div>

        <div class="facet-group">
          <div class="facet-label">Zeitraum (Sitzungsdatum)</div>
          <DatePicker
            v-model="filterDates"
            selectionMode="range"
            :manualInput="false"
            showIcon
            showButtonBar
            iconDisplay="input"
            dateFormat="dd.mm.yy"
            placeholder="Zeitraum"
            class="facet-datepicker"
          />
        </div>

        <div class="facet-group">
          <div class="facet-label">Sortierung</div>
          <select v-model="sortBy" @change="applyFilters" class="facet-select">
            <option value="updated_desc">Zuletzt aktualisiert</option>
            <option value="updated_asc">Älteste zuerst</option>
            <option value="published_desc">Sitzungsdatum ↓</option>
            <option value="published_asc">Sitzungsdatum ↑</option>
            <option value="title_asc">Titel A–Z</option>
            <option value="title_desc">Titel Z–A</option>
            <option value="connections_desc">Meiste Verknüpfungen</option>
          </select>
        </div>

        <button v-if="hasActiveFilters" class="btn-clear" @click="clearFilters">
          ✕ Filter zurücksetzen
        </button>
      </div>

      <!-- Reader: kompakte Ergebnisliste zum Weiterblättern. Artikel aus einem
           Quell-Dokument stehen als aufklappbare Gruppe unter ihrer Übersicht. -->
      <div class="rail-results" v-if="selectedPage">
        <div class="rail-results-head">{{ total }} Treffer</div>
        <div v-for="node in railTree" :key="node.page.id" class="rail-group">
          <div
            :class="[
              'rail-result',
              {
                active: selectedSlug === node.page.slug,
                'has-children': node.children.length,
              },
            ]"
            @click="selectPage(node.page)"
          >
            <button
              v-if="node.children.length"
              class="rail-caret"
              @click.stop="toggleGroup(node.page.slug)"
              :title="
                isExpanded(node.page.slug)
                  ? 'Kapitel einklappen'
                  : 'Kapitel ausklappen'
              "
            >
              {{ isExpanded(node.page.slug) ? "▾" : "▸" }}
            </button>
            <span class="rail-label">{{ stripWikiLinks(node.page.title) }}</span>
            <span
              v-if="node.children.length"
              class="rail-count"
              :title="`${node.children.length} Kapitel`"
              >{{ node.children.length }}</span
            >
          </div>
          <div
            v-if="node.children.length && isExpanded(node.page.slug)"
            class="rail-children"
          >
            <div
              v-for="c in node.children"
              :key="c.id"
              :class="['rail-result', 'rail-child', { active: selectedSlug === c.slug }]"
              @click="selectPage(c)"
            >
              <span class="rail-child-no">{{ c.sort_order }}</span>
              <span class="rail-label">{{ stripWikiLinks(c.title) }}</span>
            </div>
          </div>
        </div>
      </div>
    </aside>

    <!-- Hauptbereich -->
    <main class="wiki-main">
      <!-- DISCOVERY -->
      <template v-if="!selectedPage">
        <div class="discovery-head">
          <div class="result-count">
            <strong>{{ total }}</strong> {{ typeLabelPlural }}
          </div>
          <div class="active-chips" v-if="hasActiveFilters">
            <span v-if="searchQuery" class="chip">
              „{{ searchQuery }}"
              <button @click="clearSearch">✕</button>
            </span>
            <span v-if="filterChannel" class="chip">
              📺 {{ filterChannel }}
              <button @click="clearChannel">✕</button>
            </span>
            <span v-if="dateRangeLabel" class="chip">
              📅 {{ dateRangeLabel }}
              <button @click="clearDates">✕</button>
            </span>
            <span v-for="t in selectedTopics" :key="t.id" class="chip">
              🏷️ {{ t.label }}
              <button @click="toggleTopicFilter(t.id)">✕</button>
            </span>
            <span v-if="filterReferences" class="chip chip-ref">
              🔎 verweist auf „{{ refDisplay }}"
              <button @click="clearReferences">✕</button>
            </span>
          </div>
        </div>

        <!-- Offene Chat-Verbund-Entwürfe: Hinweis + Zurück ins Review -->
        <div v-if="draftClusters.length" class="draft-banner">
          <div class="draft-banner-head">
            <i class="pi pi-file-edit"></i>
            <span>
              {{ draftClusters.length }} unveröffentlichte(r) Artikel-Verbund aus
              dem Chat – noch nicht im Wiki sichtbar.
            </span>
          </div>
          <ul class="draft-list">
            <li v-for="dc in draftClusters" :key="dc.cluster_id">
              <span class="draft-title">{{ dc.title }}</span>
              <span class="draft-meta">{{ dc.count }} Artikel</span>
              <button class="draft-open" @click="openReview(dc.cluster_id)">
                Review öffnen →
              </button>
            </li>
          </ul>
        </div>

        <div v-if="!hasActiveFilters && stats.length" class="stats-band">
          <button
            class="stat-card"
            v-for="s in stats"
            :key="s.label"
            :disabled="!s.type"
            @click="s.type && setActiveTab(s.type)"
          >
            <span class="stat-number">{{ s.count }}</span>
            <span class="stat-label">{{ s.label }}</span>
          </button>
        </div>

        <div v-if="loading" class="list-status">Lade...</div>
        <div v-else-if="pages.length === 0" class="list-status empty">
          <p v-if="hasActiveFilters">Keine Treffer für die aktuellen Filter.</p>
          <p v-else-if="activeTab === 'summary'">
            Keine Artikel. Importiere ein Dokument, um Wiki-Seiten zu generieren.
          </p>
          <p v-else>
            Keine
            {{ activeTab === "entity" ? "Entitäten" : "Konzepte" }} gefunden.
          </p>
          <p v-if="workspaceId && !hasActiveFilters" class="reader-actions">
            <button class="btn-primary" @click="showImport = true">
              📥 WeKnora importieren
            </button>
          </p>
        </div>

        <div v-else class="result-grid">
          <article
            v-for="p in pages"
            :key="p.id"
            class="result-card"
            @click="selectPage(p)"
          >
            <span :class="['card-type', p.page_type]">{{
              pageRoleLabel(p)
            }}</span>
            <h3 class="card-title">{{ stripWikiLinks(p.title) }}</h3>
            <!-- Zugehörigkeit sichtbar machen: Kapitel N aus welchem Dokument -->
            <p v-if="p.parent_slug" class="card-parent">
              Kapitel {{ p.sort_order }}
              <template v-if="p.document_title">
                · {{ stripWikiLinks(p.document_title) }}
              </template>
            </p>
            <p class="card-summary">{{ stripWikiLinks(p.summary) }}</p>
            <!-- Auffälligkeiten aus page_metadata.flags – der schnellste Weg zu
                 den brisanten Sitzungen. -->
            <div v-if="pageFlags(p).length" class="card-flags">
              <span v-for="f in pageFlags(p)" :key="f" class="flag-chip">
                {{ flagLabel(f) }}
              </span>
            </div>
            <div class="card-meta">
              <!-- Sitzungsdatum, nicht das Bearbeitungsdatum der Wiki-Seite:
                   bei generierten Artikeln ist updated_at der Zeitpunkt der
                   Generierung und damit die unwichtigste Datumsangabe. -->
              <span :title="sessionDate(p) ? 'Sitzungsdatum' : 'Zuletzt bearbeitet'">
                {{ sessionDate(p) || formatDate(p.updated_at) }}
              </span>
              <span v-if="p.document_channel" class="card-channel">{{
                p.document_channel
              }}</span>
              <span v-if="p.out_links?.length">{{ p.out_links.length }} →</span>
              <span v-if="p.in_links?.length">{{ p.in_links.length }} ←</span>
            </div>
          </article>
        </div>

        <!-- Nachladen: die Liste war auf 200 Treffer begrenzt und alles darüber
             hinaus unerreichbar – bei einigen hundert Protokollen die Hälfte. -->
        <div v-if="!loading && pages.length < total" class="load-more">
          <button class="btn-more" :disabled="loadingMore" @click="loadMore">
            {{ loadingMore ? "lädt …" : `Weitere ${Math.min(pageSize, total - pages.length)} von ${total} laden` }}
          </button>
        </div>
      </template>

      <!-- READER -->
      <template v-else>
        <div class="reader-header">
          <button class="btn-back" @click="goBackToOverview">
            ← Zurück zu Ergebnissen
          </button>
          <!-- Verortung im Dokument-Verbund: Übersicht › Kapitel N von M -->
          <div class="reader-crumbs" v-if="chapterContext">
            <button
              v-if="chapterContext.parent"
              class="crumb-link"
              @click="selectPage(chapterContext.parent)"
            >
              📚 {{ stripWikiLinks(chapterContext.parent.title) }}
            </button>
            <span v-if="chapterContext.parent" class="crumb-sep">›</span>
            <span class="crumb-current">
              Kapitel {{ chapterContext.index }} von {{ chapterContext.count }}
            </span>
          </div>
          <h2>{{ stripWikiLinks(selectedPage.title) }}</h2>
          <div class="reader-meta">
            <span :class="['type-tag', selectedPage.page_type]">
              {{ pageRoleLabel(selectedPage) }}
            </span>
            <span v-if="childChapters.length" class="type-tag chapters">
              {{ childChapters.length }} Kapitel
            </span>
            <span>Version {{ selectedPage.version }}</span>
            <span>{{ formatDate(selectedPage.updated_at) }}</span>
            <span
              v-if="selectedPage.manually_edited"
              class="lock-badge"
              title="Manuell bearbeitet – wird von der Auto-Generierung nicht überschrieben"
              >🔒 manuell</span
            >
          </div>
          <div class="reader-actions-bar" v-if="!editing">
            <button
              v-if="['concept', 'entity'].includes(selectedPage.page_type)"
              class="btn-mini"
              @click="setReferenceFilter(selectedSlug, stripWikiLinks(selectedPage.title))"
            >
              🔎 Artikel dazu
            </button>
            <button class="btn-mini" @click="startEdit">✏️ Bearbeiten</button>
            <button class="btn-mini" @click="openRevisions">🕘 Verlauf</button>
          </div>
          <div v-if="selectedPage.aliases?.length" class="reader-aliases">
            <strong>Aliase:</strong>
            <span
              v-for="a in selectedPage.aliases"
              :key="a"
              class="alias-tag"
              >{{ a }}</span
            >
          </div>
        </div>

        <SpeechBar
          v-if="!editing"
          :article="selectedPage"
          :article-key="selectedSlug"
        />

        <!-- Inhaltsverzeichnis: Sitzungsartikel sind lang, ohne Sprungmarken
             muss man Kopfdaten, Lagebild, alle TOPs, Beschlüsse und
             Kontroversen durchscrollen. Erst ab 3 Überschriften sinnvoll. -->
        <nav v-if="!editing && tocEntries.length > 2" class="reader-toc">
          <button class="toc-head" @click="tocOpen = !tocOpen">
            {{ tocOpen ? "▾" : "▸" }} Inhalt ({{ tocEntries.length }})
          </button>
          <ul v-show="tocOpen" class="toc-list">
            <li
              v-for="e in tocEntries"
              :key="e.id"
              :class="['toc-item', `toc-l${e.level}`]"
            >
              <a href="javascript:void(0)" @click="scrollToHeading(e.id)">{{ e.text }}</a>
            </li>
          </ul>
        </nav>

        <div
          v-if="!editing"
          class="reader-body"
          v-html="renderedContent"
          @click="onBodyClick"
        ></div>

        <!-- Edit-Modus (Markdown + Link-Toolbar) -->
        <div v-else class="reader-edit">
          <label class="edit-label">Titel</label>
          <input v-model="editTitle" class="edit-input" />
          <label class="edit-label">Zusammenfassung</label>
          <input v-model="editSummary" class="edit-input" />
          <label class="edit-label">Inhalt (Markdown)</label>
          <div class="edit-toolbar">
            <button class="btn-mini" @click="insertLink" title="Externen Link einfügen">
              🔗 Link
            </button>
            <span class="edit-hint">
              [[seite]] = interner Link · [Text](https://…) = externer Link
            </span>
          </div>
          <textarea
            ref="editTextarea"
            v-model="editContent"
            class="edit-textarea"
            rows="20"
          ></textarea>
          <div class="edit-actions">
            <button class="btn-secondary" @click="cancelEdit">Abbrechen</button>
            <button class="btn-primary" @click="saveEdit" :disabled="saving">
              {{ saving ? "⏳ Speichern..." : "💾 Speichern" }}
            </button>
          </div>
        </div>

        <!-- Kapitel-Navigation: linear durch das Quell-Dokument blättern.
             Steht bewusst NACH dem v-if/v-else-Paar oben, damit die Kette
             reader-body / reader-edit zusammenhängend bleibt. -->
        <nav v-if="!editing && chapterContext" class="chapter-nav">
          <button
            class="chapter-nav-btn"
            :disabled="!chapterContext.prev"
            @click="chapterContext.prev && selectPage(chapterContext.prev)"
          >
            <span class="chapter-nav-dir">← Vorheriges Kapitel</span>
            <span class="chapter-nav-title">{{
              chapterContext.prev
                ? stripWikiLinks(chapterContext.prev.title)
                : "—"
            }}</span>
          </button>
          <button
            class="chapter-nav-btn next"
            :disabled="!chapterContext.next"
            @click="chapterContext.next && selectPage(chapterContext.next)"
          >
            <span class="chapter-nav-dir">Nächstes Kapitel →</span>
            <span class="chapter-nav-title">{{
              chapterContext.next
                ? stripWikiLinks(chapterContext.next.title)
                : "—"
            }}</span>
          </button>
        </nav>

        <div v-if="!editing" class="reader-footer">
          <div v-if="selectedPage.out_links?.length" class="links-section">
            <h4>→ Verlinkt zu</h4>
            <div class="link-chips">
              <span
                v-for="slug in selectedPage.out_links"
                :key="slug"
                class="link-chip"
                @click="navigateToSlug(slug)"
                >{{ slugLabel(slug) }}</span
              >
            </div>
          </div>
          <div v-if="selectedPage.in_links?.length" class="links-section">
            <h4>← Verlinkt von</h4>
            <div class="link-chips">
              <span
                v-for="slug in selectedPage.in_links"
                :key="slug"
                class="link-chip"
                @click="navigateToSlug(slug)"
                >{{ slugLabel(slug) }}</span
              >
            </div>
          </div>
        </div>
      </template>

      <!-- Versions-Historie (Ebene 4) -->
      <div
        v-if="showRevisions"
        class="dialog-overlay"
        @click.self="showRevisions = false"
      >
        <div class="dialog">
          <h3>🕘 Versions-Historie</h3>
          <p class="dialog-hint" v-if="!revisions.length">
            Noch keine früheren Fassungen. Bei jeder manuellen Bearbeitung wird
            die vorige Version hier gesichert.
          </p>
          <div v-else class="rev-list">
            <div v-for="rev in revisions" :key="rev.id" class="rev-item">
              <div class="rev-info">
                <span class="rev-ver">v{{ rev.version }}</span>
                <span class="rev-date">{{ formatDateTime(rev.created_at) }}</span>
              </div>
              <button
                class="btn-mini"
                @click="restoreRevision(rev)"
                :disabled="restoringId === rev.id"
              >
                {{ restoringId === rev.id ? "⏳..." : "↩︎ Wiederherstellen" }}
              </button>
            </div>
          </div>
          <div class="dialog-actions">
            <button class="btn-secondary" @click="showRevisions = false">
              Schließen
            </button>
          </div>
        </div>
      </div>

      <!-- Import Dialog -->
      <div
        v-if="showImport"
        class="dialog-overlay"
        @click.self="showImport = false"
      >
        <div class="dialog dialog-wide">
          <h3>📥 WeKnora Import</h3>
          <p class="dialog-hint">
            Importiere Wiki-Seiten aus einem WeKnora-JSON-Export.
          </p>
          <div class="field">
            <label>JSON-Datei hochladen</label>
            <input
              type="file"
              ref="fileInput"
              @change="onFileSelected"
              accept=".json"
              class="file-input"
            />
          </div>
          <div class="field">
            <label>Oder JSON direkt einfügen</label>
            <textarea
              v-model="importJson"
              @input="parseImportJson"
              rows="8"
              placeholder='[{ "slug": "...", "title": "...", "content": "..." }]'
              class="import-textarea"
            ></textarea>
          </div>
          <div v-if="importPreview" class="import-preview">
            <p>
              📊 {{ importPreview.length }} Seiten:
              <span v-for="(count, type) in importTypeCounts" :key="type"
                >{{ type }}: {{ count }}
              </span>
            </p>
          </div>
          <div v-if="importResult" class="import-result">
            <p class="success">✅ {{ importResult.imported }} importiert</p>
            <p v-if="importResult.skipped" class="warning">
              ⏭️ {{ importResult.skipped }} übersprungen
            </p>
          </div>
          <div class="dialog-actions">
            <button class="btn-secondary" @click="closeImport">
              Schließen
            </button>
            <button
              class="btn-primary"
              @click="startImport"
              :disabled="!importParsed || importing"
            >
              {{ importing ? "⏳ Importiere..." : "📥 Import starten" }}
            </button>
          </div>
          <p v-if="importError" class="error">{{ importError }}</p>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useAuthStore } from "../../stores/auth";
import { useWorkspace } from "../../composables/useWorkspace";
import DatePicker from "primevue/datepicker";
import SpeechBar from "../../components/SpeechBar.vue";
import axios from "axios";
import { marked } from "marked";
import DOMPurify from "dompurify";

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const { resolveWorkspace, isUUID } = useWorkspace();

const rawWorkspaceId = computed(
  () => ((route.params.id || route.params.workspaceId) as string) || "",
);
const workspaceId = ref(rawWorkspaceId.value);
const urlSlug = computed(() => (route.params.slug as string) || "");

// Filter-/Facetten-State
const searchQuery = ref("");
const activeTab = ref("summary");
const filterChannel = ref("");
const filterDates = ref<(Date | null)[] | null>(null);
const sortBy = ref("updated_desc");
const channels = ref<string[]>([]);
const allTopics = ref<any[]>([]);
const filterTopicIds = ref<string[]>([]);
// Ebene 3: Backlink-Filter (Slug eines Concepts/Entity) + Top-Konzepte
const filterReferences = ref("");
const refLabel = ref("");
const topConceptsList = ref<any[]>([]);
const showFacets = ref(false);
// Auf Mobile sind die Filter standardmäßig eingeklappt (Accordion), damit die
// Artikel-Kacheln sofort sichtbar sind. Auf Desktop bleiben die Facetten in der
// Discovery-Ansicht immer offen (Sidebar).
const isMobile = ref(false);
let mobileMq: MediaQueryList | null = null;
const syncMobile = () => {
  isMobile.value = mobileMq?.matches ?? false;
};

// Ebene 4: Auffälligkeiten-Filter (page_metadata.flags)
const filterFlags = ref<string[]>([]);
const flagFacets = ref<{ flag: string; count: number }[]>([]);
// Zeitleiste (Jahr → Monat) mit Trefferzahlen
const monthFacets = ref<{ month: string; count: number }[]>([]);
const openYears = ref<Record<string, boolean>>({});

const pages = ref<any[]>([]);
const total = ref(0);
const loading = ref(false);
// Blätterung: serverseitig auf 200 begrenzt, deshalb hier dieselbe Seitengröße.
const pageSize = 100;
const currentPage = ref(1);
const loadingMore = ref(false);
const tabs = ref<{ type: string; label: string; total: number }[]>([
  { type: "summary", label: "Summaries", total: 0 },
  { type: "entity", label: "Entities", total: 0 },
  { type: "concept", label: "Concepts", total: 0 },
]);

// Reader state
const selectedPage = ref<any>(null);
const selectedSlug = ref("");
// Ebene 4: Bearbeiten + Historie
// Inhaltsverzeichnis standardmäßig zu: bei kurzen Artikeln stört es, bei langen
// ist es einen Klick entfernt.
const tocOpen = ref(false);
const editing = ref(false);
const editTitle = ref("");
const editSummary = ref("");
const editContent = ref("");
const saving = ref(false);
const editTextarea = ref<HTMLTextAreaElement>();
const showRevisions = ref(false);
const revisions = ref<any[]>([]);
const restoringId = ref<number | null>(null);
const indexIntro = ref("");
const stats = ref<{ label: string; count: number; type: string | null }[]>([]);

// Import state
const showImport = ref(false);
const importJson = ref("");
const importing = ref(false);
const importError = ref("");
const importResult = ref<any>(null);
const importParsed = ref<any[] | null>(null);
const importPreview = ref<any[] | null>(null);
const importTypeCounts = ref<Record<string, number>>({});
const fileInput = ref<HTMLInputElement>();

let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let ready = false; // verhindert Auto-Reload durch Watcher während Initialisierung

const base = computed(() => `/workspaces/${rawWorkspaceId.value}/wiki`);

const hasActiveFilters = computed(
  () =>
    !!(
      searchQuery.value ||
      filterChannel.value ||
      filterDates.value?.[0] ||
      filterTopicIds.value.length ||
      filterReferences.value
    ) || sortBy.value !== "updated_desc",
);
const activeFilterCount = computed(() => {
  let n = 0;
  if (searchQuery.value) n++;
  if (filterChannel.value) n++;
  if (filterDates.value?.[0]) n++;
  if (filterTopicIds.value.length) n += filterTopicIds.value.length;
  if (filterReferences.value) n++;
  if (sortBy.value !== "updated_desc") n++;
  return n;
});
const refDisplay = computed(
  () => refLabel.value || slugLabel(filterReferences.value),
);
const typeLabelPlural = computed(() => {
  const map: Record<string, string> = {
    summary: "Zusammenfassungen",
    entity: "Entitäten",
    concept: "Konzepte",
  };
  return map[activeTab.value] || "Seiten";
});
const dateRangeLabel = computed(() => {
  const d = filterDates.value;
  if (!d || !d[0]) return "";
  const f = (x: Date) => x.toLocaleDateString("de-DE");
  return d[1] ? `${f(d[0])} – ${f(d[1])}` : `ab ${f(d[0])}`;
});
const selectedTopics = computed(() =>
  allTopics.value.filter((t) => filterTopicIds.value.includes(t.id)),
);

// ---- Hierarchie: Kapitel gehören zu ihrer Übersichtsseite ----------------
// Generierte Kapitel-Artikel tragen parent_slug = Slug der Übersicht und
// sort_order = Kapitelnummer. Die Rail baut daraus einen zweistufigen Baum,
// damit erkennbar ist, welche Artikel aus demselben Dokument stammen.

/** Slugs, die mindestens ein Kapitel unter sich haben (= Übersichtsseiten). */
const parentSlugs = computed(
  () => new Set(pages.value.map((p) => p.parent_slug).filter(Boolean)),
);

const railTree = computed(() => {
  const bySlug = new Set(pages.value.map((p) => p.slug));
  const childrenOf = new Map<string, any[]>();
  for (const p of pages.value) {
    // Nur einhängen, wenn die Übersicht im aktuellen Ergebnis auch vorkommt –
    // sonst würde ein Kapitel bei aktivem Filter/Suche komplett verschwinden.
    if (p.parent_slug && bySlug.has(p.parent_slug)) {
      const arr = childrenOf.get(p.parent_slug) || [];
      arr.push(p);
      childrenOf.set(p.parent_slug, arr);
    }
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  }
  return pages.value
    .filter((p) => !(p.parent_slug && bySlug.has(p.parent_slug)))
    .map((p) => ({ page: p, children: childrenOf.get(p.slug) || [] }));
});

// Auf-/Zuklappen: Default ist zu (kurze Liste); die Gruppe des offenen Artikels
// klappt automatisch auf. Ein Caret-Klick setzt einen expliziten Override, der
// den Default in BEIDE Richtungen überstimmt.
const groupOverrides = ref<Record<string, boolean>>({});
const activeGroupSlug = computed(() => {
  const p = selectedPage.value;
  if (!p) return "";
  return p.parent_slug || p.slug;
});
function isExpanded(slug: string): boolean {
  const override = groupOverrides.value[slug];
  return override !== undefined ? override : activeGroupSlug.value === slug;
}
function toggleGroup(slug: string) {
  groupOverrides.value = {
    ...groupOverrides.value,
    [slug]: !isExpanded(slug),
  };
}
// Wechselt der Nutzer in eine Gruppe, gilt wieder der Default (= offen); ein
// altes „zugeklappt" soll den gerade geöffneten Artikel nicht verstecken.
watch(activeGroupSlug, (slug) => {
  if (slug && groupOverrides.value[slug] === false) {
    const next = { ...groupOverrides.value };
    delete next[slug];
    groupOverrides.value = next;
  }
});

/** Kapitel-Kontext des offenen Artikels (Übersicht, Position, Nachbarn). */
const chapterContext = computed(() => {
  const p = selectedPage.value;
  if (!p?.parent_slug) return null;
  const siblings = pages.value
    .filter((x) => x.parent_slug === p.parent_slug)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const idx = siblings.findIndex((x) => x.slug === p.slug);
  if (idx === -1) return null;
  return {
    parent: pages.value.find((x) => x.slug === p.parent_slug) || null,
    index: p.sort_order || idx + 1,
    count: Math.max(
      siblings.length,
      ...siblings.map((s) => Number(s.sort_order) || 0),
    ),
    prev: siblings[idx - 1] || null,
    next: siblings[idx + 1] || null,
  };
});

/** Kapitel des offenen Artikels – nur befüllt, wenn er eine Übersicht ist. */
const childChapters = computed(() => {
  const p = selectedPage.value;
  if (!p) return [];
  return pages.value
    .filter((x) => x.parent_slug === p.slug)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
});

onMounted(() => {
  mobileMq = window.matchMedia("(max-width: 768px)");
  syncMobile();
  mobileMq.addEventListener("change", syncMobile);
});
onUnmounted(() => {
  mobileMq?.removeEventListener("change", syncMobile);
});

onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.push("/login");
    return;
  }
  if (rawWorkspaceId.value && !isUUID(rawWorkspaceId.value)) {
    const resolved = await resolveWorkspace(rawWorkspaceId.value);
    if (resolved) workspaceId.value = resolved.id;
    else console.error("[wiki] Workspace nicht gefunden:", rawWorkspaceId.value);
  }

  parseQueryFromUrl();

  if (workspaceId.value) {
    await Promise.all([
      loadIndex(),
      loadStats(),
      loadChannels(),
      loadTopics(),
      loadTopConcepts(),
      loadMonthFacets(),
      loadFlagFacets(),
      loadDraftClusters(),
    ]);
    await loadPages();
    if (urlSlug.value) await loadPageBySlug(urlSlug.value);
  }
  ready = true;
});

// Workspace-Wechsel via URL
watch(rawWorkspaceId, async (newVal) => {
  if (newVal && !isUUID(newVal)) {
    const resolved = await resolveWorkspace(newVal);
    if (resolved) workspaceId.value = resolved.id;
  } else if (newVal) {
    workspaceId.value = newVal;
  }
});
watch(workspaceId, () => {
  if (!workspaceId.value) return;
  selectedPage.value = null;
  selectedSlug.value = "";
  loadIndex();
  loadStats();
  loadChannels();
  loadMonthFacets();
  loadFlagFacets();
  loadPages();
});

// Browser Zurück/Vor (Slug ändert sich außerhalb der Klick-Handler)
watch(urlSlug, (slug) => {
  if (!ready) return;
  if (!slug) {
    selectedPage.value = null;
    selectedSlug.value = "";
  } else if (slug !== selectedSlug.value) {
    loadPageBySlug(slug);
  }
});

// Zeitraum-Auswahl: erst laden, wenn Bereich vollständig oder geleert
watch(filterDates, (val) => {
  if (!ready) return;
  if (!val || !val[0]) applyFilters();
  else if (val[0] && val[1]) applyFilters();
});

// ---- Laden ----

async function loadIndex() {
  if (!workspaceId.value) return;
  try {
    const res = await axios.get(`/api/v1/wiki/${workspaceId.value}/index`);
    indexIntro.value = res.data.intro || "";
  } catch {
    /* no index yet */
  }
}

const draftClusters = ref<
  { cluster_id: string; title: string; count: number; created_at: string }[]
>([]);

async function loadDraftClusters() {
  if (!workspaceId.value) return;
  try {
    const res = await axios.get(
      `/api/v1/wiki/${workspaceId.value}/draft-clusters`,
    );
    draftClusters.value = res.data.clusters || [];
  } catch {
    /* ignore */
  }
}

function openReview(clusterId: string) {
  router.push(`/workspaces/${workspaceId.value}/wiki-review/${clusterId}`);
}

async function loadStats() {
  if (!workspaceId.value) return;
  try {
    const res = await axios.get(`/api/v1/wiki/${workspaceId.value}/stats`);
    const byType = res.data.pages_by_type || {};
    tabs.value = tabs.value.map((t) => ({ ...t, total: byType[t.type] || 0 }));
    stats.value = [
      { label: "Summaries", count: byType.summary || 0, type: "summary" },
      { label: "Entities", count: byType.entity || 0, type: "entity" },
      { label: "Concepts", count: byType.concept || 0, type: "concept" },
      { label: "Gesamt", count: res.data.total_pages || 0, type: null },
    ];
  } catch {
    /* ignore */
  }
}

async function loadChannels() {
  if (!workspaceId.value) return;
  try {
    const res = await axios.get(
      `/api/v1/documents/${workspaceId.value}/channels`,
    );
    channels.value = res.data.channels || [];
  } catch {
    /* ignore */
  }
}

async function loadTopics() {
  if (!workspaceId.value) return;
  try {
    const res = await axios.get(`/api/v1/topics/${workspaceId.value}`);
    allTopics.value = res.data.topics || [];
  } catch {
    /* ignore */
  }
}
function toggleTopicFilter(id: string) {
  const i = filterTopicIds.value.indexOf(id);
  if (i >= 0) filterTopicIds.value.splice(i, 1);
  else filterTopicIds.value.push(id);
  applyFilters();
}

async function loadTopConcepts() {
  if (!workspaceId.value) return;
  try {
    const res = await axios.get(
      `/api/v1/wiki/${workspaceId.value}/concepts/top?limit=15`,
    );
    topConceptsList.value = (res.data.concepts || []).filter(
      (c: any) => c.connections > 0,
    );
  } catch {
    /* ignore */
  }
}

/** Query-Parameter der aktuellen Filterlage (ohne Seitennummer). */
function currentFilterParams(): Record<string, string> {
  const params: Record<string, string> = {
    page_type: activeTab.value,
    page_size: String(pageSize),
    sort: sortBy.value,
  };
  if (searchQuery.value) params.query = searchQuery.value;
  if (filterChannel.value) params.channel = filterChannel.value;
  if (filterTopicIds.value.length)
    params.topics = filterTopicIds.value.join(",");
  if (filterReferences.value) params.references = filterReferences.value;
  if (filterFlags.value.length) params.flags = filterFlags.value.join(",");
  const [from, to] = filterDates.value || [];
  if (from) params.from = `${toDateStr(from)}T00:00:00`;
  if (to) params.to = `${toDateStr(to)}T23:59:59`;
  return params;
}

/** Zeitleiste laden. Auf den aktiven Typ eingeschränkt, damit die Zahlen zur
 *  Ergebnisliste passen (Entity-/Concept-Seiten hängen am erstgenerierenden
 *  Dokument und würden die Monatszahlen sonst verzerren). */
async function loadMonthFacets() {
  if (!workspaceId.value) return;
  try {
    const res = await axios.get(
      `/api/v1/wiki/${workspaceId.value}/facets/months`,
      { params: { page_type: activeTab.value } },
    );
    monthFacets.value = res.data.months || [];
    // Das jüngste Jahr aufgeklappt lassen – dort liegt meist der Einstieg.
    const years = [...new Set(monthFacets.value.map((m: any) => m.month.slice(0, 4)))];
    if (years.length && Object.keys(openYears.value).length === 0) {
      openYears.value = { [years[years.length - 1]]: true };
    }
  } catch {
    /* Facette ist optional – ein Fehler darf die Ansicht nicht blockieren */
  }
}

async function loadFlagFacets() {
  if (!workspaceId.value) return;
  try {
    const res = await axios.get(
      `/api/v1/wiki/${workspaceId.value}/facets/flags`,
    );
    flagFacets.value = res.data.flags || [];
  } catch {
    /* optional */
  }
}

async function loadPages() {
  if (!workspaceId.value) return;
  loading.value = true;
  currentPage.value = 1;
  try {
    const res = await axios.get(`/api/v1/wiki/${workspaceId.value}/pages`, {
      params: { ...currentFilterParams(), page: "1" },
    });
    pages.value = res.data.pages || [];
    total.value = res.data.total || 0;
  } catch (e: any) {
    console.error("[wiki] load error", e);
  } finally {
    loading.value = false;
  }
}

/**
 * Nächste Seite anhängen. Vorher sendete die Ansicht ein festes page_size=200
 * und nie einen page-Parameter – alles jenseits der ersten 200 Treffer war
 * damit unerreichbar.
 */
async function loadMore() {
  if (!workspaceId.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const next = currentPage.value + 1;
    const res = await axios.get(`/api/v1/wiki/${workspaceId.value}/pages`, {
      params: { ...currentFilterParams(), page: String(next) },
    });
    const more = res.data.pages || [];
    // Nach Slug deduplizieren: zwischen zwei Abfragen kann sich die Sortierung
    // verschoben haben (z.B. weil ein Artikel neu generiert wurde).
    const seen = new Set(pages.value.map((p: any) => p.slug));
    pages.value = [...pages.value, ...more.filter((p: any) => !seen.has(p.slug))];
    total.value = res.data.total ?? total.value;
    currentPage.value = next;
  } catch (e: any) {
    console.error("[wiki] load more error", e);
  } finally {
    loadingMore.value = false;
  }
}

// ---- Filter-Aktionen + URL-Sync ----

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildQuery(): Record<string, string> {
  const q: Record<string, string> = {};
  if (searchQuery.value) q.q = searchQuery.value;
  if (activeTab.value !== "summary") q.type = activeTab.value;
  if (filterChannel.value) q.channel = filterChannel.value;
  if (filterTopicIds.value.length) q.topics = filterTopicIds.value.join(",");
  if (filterReferences.value) {
    q.ref = filterReferences.value;
    if (refLabel.value) q.refLabel = refLabel.value;
  }
  if (sortBy.value !== "updated_desc") q.sort = sortBy.value;
  const [from, to] = filterDates.value || [];
  if (from) q.from = toDateStr(from);
  if (to) q.to = toDateStr(to);
  return q;
}

function parseQueryFromUrl() {
  const q = route.query;
  if (typeof q.q === "string") searchQuery.value = q.q;
  if (typeof q.type === "string") activeTab.value = q.type;
  if (typeof q.channel === "string") filterChannel.value = q.channel;
  if (typeof q.topics === "string")
    filterTopicIds.value = q.topics.split(",").filter(Boolean);
  if (typeof q.ref === "string") filterReferences.value = q.ref;
  if (typeof q.refLabel === "string") refLabel.value = q.refLabel;
  if (typeof q.sort === "string") sortBy.value = q.sort;
  const from = typeof q.from === "string" ? new Date(q.from) : null;
  const to = typeof q.to === "string" ? new Date(q.to) : null;
  if (from && !isNaN(from.getTime())) {
    filterDates.value = [from, to && !isNaN(to.getTime()) ? to : null];
  }
}

// Filter in URL-Query spiegeln (replace: keine History-Einträge, teilbar/deep-link)
function syncQueryToUrl() {
  router.replace({ query: buildQuery() }).catch(() => {});
}

function applyFilters() {
  syncQueryToUrl();
  loadPages();
}

function onSearch() {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => applyFilters(), 350);
}

function setActiveTab(type: string) {
  activeTab.value = type;
  if (selectedPage.value) goBackToOverview();
  // Die Zeitleiste ist auf den aktiven Typ eingeschränkt und muss deshalb
  // mitwandern, sonst zeigen ihre Zahlen einen anderen Bestand als die Liste.
  loadMonthFacets();
  applyFilters();
}

function clearSearch() {
  searchQuery.value = "";
  applyFilters();
}
function clearChannel() {
  filterChannel.value = "";
  applyFilters();
}
function clearDates() {
  filterDates.value = null; // Watcher triggert applyFilters
}
function clearFilters() {
  searchQuery.value = "";
  filterChannel.value = "";
  filterTopicIds.value = [];
  filterReferences.value = "";
  refLabel.value = "";
  sortBy.value = "updated_desc";
  if (filterDates.value?.[0]) {
    filterDates.value = null; // Watcher lädt neu
  } else {
    applyFilters();
  }
}
function clearReferences() {
  filterReferences.value = "";
  refLabel.value = "";
  applyFilters();
}
// Ebene 3: Backlink-Filter setzen → Discovery zeigt nur Artikel, die auf slug verlinken
function setReferenceFilter(slug: string, label: string) {
  filterReferences.value = slug;
  refLabel.value = label;
  activeTab.value = "summary";
  selectedPage.value = null;
  selectedSlug.value = "";
  editing.value = false;
  router.replace({ path: base.value, query: buildQuery() }).catch(() => {});
  loadPages();
}

// ---- Navigation ----

function selectPage(p: any) {
  selectedPage.value = p;
  selectedSlug.value = p.slug;
  showFacets.value = false;
  editing.value = false;
  showRevisions.value = false;
  pushSlug(p.slug);
}

function pushSlug(slug: string) {
  router
    .push({ path: `${base.value}/${encodeURIComponent(slug)}`, query: route.query })
    .catch(() => {});
}

function goBackToOverview() {
  selectedPage.value = null;
  selectedSlug.value = "";
  router.push({ path: base.value, query: route.query }).catch(() => {});
}

async function loadPageBySlug(slug: string) {
  if (!workspaceId.value) return;
  try {
    const res = await axios.get(
      `/api/v1/wiki/${workspaceId.value}/pages/${encodeURIComponent(slug)}`,
    );
    if (res.data.page) {
      selectedPage.value = res.data.page;
      selectedSlug.value = slug;
      editing.value = false;
      showRevisions.value = false;
    }
  } catch {
    /* ignore */
  }
}

async function navigateToSlug(slug: string) {
  await loadPageBySlug(slug);
  pushSlug(slug);
}

// ---- Ebene 4: Bearbeiten + Historie ----

function startEdit() {
  if (!selectedPage.value) return;
  editTitle.value = selectedPage.value.title || "";
  editSummary.value = selectedPage.value.summary || "";
  editContent.value = selectedPage.value.content || "";
  editing.value = true;
}
function cancelEdit() {
  editing.value = false;
}
async function saveEdit() {
  if (!selectedPage.value) return;
  saving.value = true;
  try {
    const res = await axios.put(
      `/api/v1/wiki/${workspaceId.value}/pages/${encodeURIComponent(selectedSlug.value)}`,
      {
        title: editTitle.value,
        summary: editSummary.value,
        content: editContent.value,
      },
    );
    if (res.data.page) selectedPage.value = res.data.page;
    editing.value = false;
    // Trefferliste aktualisieren (Titel/Reihenfolge kann sich ändern)
    loadPages();
  } catch (e: any) {
    alert("Speichern fehlgeschlagen: " + (e.response?.data?.error || e.message));
  } finally {
    saving.value = false;
  }
}
// Markdown-Link an der Cursor-Position einfügen (wrappt Auswahl).
function insertLink() {
  const ta = editTextarea.value;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const sel = editContent.value.slice(start, end) || "Linktext";
  const snippet = `[${sel}](https://)`;
  editContent.value =
    editContent.value.slice(0, start) + snippet + editContent.value.slice(end);
  // Cursor in die URL-Klammer setzen
  const urlPos = start + sel.length + 3;
  requestAnimationFrame(() => {
    ta.focus();
    ta.setSelectionRange(urlPos, urlPos + 8);
  });
}

async function openRevisions() {
  showRevisions.value = true;
  try {
    const res = await axios.get(
      `/api/v1/wiki/${workspaceId.value}/pages/${encodeURIComponent(selectedSlug.value)}/revisions`,
    );
    revisions.value = res.data.revisions || [];
  } catch {
    revisions.value = [];
  }
}
async function restoreRevision(rev: any) {
  restoringId.value = rev.id;
  try {
    const res = await axios.post(
      `/api/v1/wiki/${workspaceId.value}/pages/${encodeURIComponent(selectedSlug.value)}/revisions/${rev.id}/restore`,
    );
    if (res.data.page) selectedPage.value = res.data.page;
    showRevisions.value = false;
    editing.value = false;
    loadPages();
  } catch (e: any) {
    alert("Wiederherstellen fehlgeschlagen: " + (e.response?.data?.error || e.message));
  } finally {
    restoringId.value = null;
  }
}
function formatDateTime(d: string) {
  return new Date(d).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Klicks auf interne Wiki-Links im Artikeltext abfangen (kein Full-Reload)
function onBodyClick(e: MouseEvent) {
  const target = (e.target as HTMLElement)?.closest("a.wiki-link");
  if (!target) return;
  const slug = target.getAttribute("data-slug");
  if (slug) {
    e.preventDefault();
    navigateToSlug(decodeURIComponent(slug));
  }
}

// ---- Rendering ----

const renderedContent = computed(() => {
  if (!selectedPage.value?.content) return "";
  return renderWikiContent(selectedPage.value.content);
});

/**
 * Überschrift → Anker-Id. Muss zwischen Renderer und Inhaltsverzeichnis
 * identisch sein, damit die Sprungmarken passen.
 */
function headingId(text: string): string {
  return (
    "abschnitt-" +
    text
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/<[^>]+>/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  );
}

/**
 * Markdown → HTML über `marked`, wie es WikiPage.vue schon tut.
 *
 * Vorher lief das über handgeschriebene Regeln, die an drei Stellen scheiterten:
 * eingerückte Listen (`  - …`) wurden nicht als Unterliste erkannt, jedes `\n`
 * wurde zu einem `<br/>` (daher die weiten Abstände in Aufzählungen), und
 * Blockquotes (`> "Zitat"`) blieben als Text mit vorangestelltem `>` stehen.
 * Wiki-Links werden vorher ersetzt, weil `[[…]]` kein Markdown ist.
 */
function renderWikiContent(content: string): string {
  const withLinks = content.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match: string, slug: string, text?: string) => {
      const label = text || slug.replace(/^.*\//, "").replace(/-/g, " ");
      const encoded = encodeURIComponent(slug);
      return `<a href="${base.value}/${encoded}" data-slug="${encoded}" class="wiki-link">${label}</a>`;
    },
  );

  let html = marked.parse(withLinks, { async: false }) as string;

  // Anker auf die Überschriften setzen (Sprungziele des Inhaltsverzeichnisses)
  html = html.replace(
    /<(h[1-4])>(.*?)<\/\1>/g,
    (_m: string, tag: string, inner: string) =>
      `<${tag} id="${headingId(inner)}">${inner}</${tag}>`,
  );

  // Externe Links in neuem Tab öffnen
  html = html.replace(
    /<a href="(https?:\/\/[^"]+)"/g,
    '<a class="ext-link" target="_blank" rel="noopener noreferrer" href="$1"',
  );

  return DOMPurify.sanitize(html, { ADD_ATTR: ["target", "id", "data-slug"] });
}

/**
 * Inhaltsverzeichnis des offenen Artikels aus seinen Überschriften.
 * Sitzungsartikel sind lang (Kopfdaten, Lagebild, TOP 1…n, Beschlüsse,
 * Kontroversen …) – ohne Sprungmarken muss man sie durchscrollen.
 */
const tocEntries = computed(() => {
  const content = selectedPage.value?.content || "";
  const entries: { id: string; text: string; level: number }[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^(#{2,3})\s+(.+)$/);
    if (!m) continue;
    const text = stripWikiLinks(m[2].trim());
    entries.push({ id: headingId(text), text, level: m[1].length });
  }
  return entries;
});

function scrollToHeading(id: string) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Sitzungsdatum des Quell-Dokuments (kurz), leer wenn keines vorliegt. */
function sessionDate(p: any): string {
  const raw = p?.document_published_at;
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "" : formatDate(raw);
}

function pageFlags(p: any): string[] {
  const f = p?.page_metadata?.flags;
  return Array.isArray(f) ? f : [];
}

/** Marker-Bezeichner → lesbares Etikett. */
const FLAG_LABELS: Record<string, string> = {
  abweichende_fachliche_position: "abweichende Fachposition",
  politischer_druck: "politischer Druck",
  datenluecke: "Datenlücke",
  kommunikationsstrategie: "Kommunikationsstrategie",
  abweichung_von_who_ecdc: "Abweichung von WHO/ECDC",
  risikobewertung_geaendert: "Risikobewertung geändert",
  massnahme_ohne_evidenz: "Maßnahme ohne Evidenz",
};
function flagLabel(flag: string): string {
  return FLAG_LABELS[flag] || flag.replace(/_/g, " ");
}

function toggleFlagFilter(flag: string) {
  const i = filterFlags.value.indexOf(flag);
  if (i >= 0) filterFlags.value.splice(i, 1);
  else filterFlags.value.push(flag);
  applyFilters();
}

/** Monate zu Jahren gruppieren, damit die Zeitleiste kompakt bleibt. */
const monthsByYear = computed(() => {
  const byYear: Record<string, { month: string; label: string; count: number }[]> = {};
  const names = [
    "Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
    "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
  ];
  for (const m of monthFacets.value) {
    const [y, mm] = m.month.split("-");
    (byYear[y] ||= []).push({
      month: m.month,
      label: names[parseInt(mm, 10) - 1] ?? mm,
      count: m.count,
    });
  }
  return Object.entries(byYear)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([year, months]) => ({
      year,
      months,
      total: months.reduce((s, x) => s + x.count, 0),
    }));
});

/** Klick auf einen Monat setzt den Zeitraumfilter auf diesen Monat. */
function selectMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  const from = new Date(y, m - 1, 1);
  const to = new Date(y, m, 0); // letzter Tag des Monats
  filterDates.value = [from, to];
  applyFilters();
}

function selectYear(year: string) {
  filterDates.value = [new Date(+year, 0, 1), new Date(+year, 11, 31)];
  applyFilters();
}

function slugLabel(slug: string): string {
  return slug.split("/").pop()?.replace(/-/g, " ") || slug;
}

function stripWikiLinks(text: string): string {
  if (!text) return text;
  return text.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match: string, slug: string, label?: string) =>
      label || slug.replace(/^.*\//, "").replace(/-/g, " "),
  );
}

function typeLabel(type: string): string {
  const map: Record<string, string> = {
    summary: "📄 Zusammenfassung",
    entity: "👤 Entität",
    concept: "💡 Konzept",
    article: "📄 Artikel",
    index: "📋 Index",
    log: "📝 Log",
  };
  return map[type] || type;
}

/**
 * Typ-Label mit Rolle im Dokument-Verbund: Übersichtsseiten und Kapitel sind
 * beide page_type "summary", lesen sich als "Zusammenfassung" aber gleich.
 */
function pageRoleLabel(p: any): string {
  if (p?.page_type === "summary") {
    if (p.parent_slug) return "📄 Kapitel";
    if (parentSlugs.value.has(p.slug)) return "📚 Übersicht";
  }
  return typeLabel(p?.page_type);
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ---- Import ----

function onFileSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importJson.value = reader.result as string;
    parseImportJson();
  };
  reader.readAsText(file);
}

function parseImportJson() {
  try {
    const parsed = JSON.parse(importJson.value);
    const list = Array.isArray(parsed) ? parsed : parsed.pages || [parsed];
    if (!Array.isArray(list)) {
      importError.value = "Ungültiges Format";
      return;
    }
    importParsed.value = list;
    importPreview.value = list;
    const counts: Record<string, number> = {};
    for (const p of list) {
      const t = p.page_type || "article";
      counts[t] = (counts[t] || 0) + 1;
    }
    importTypeCounts.value = counts;
    importError.value = "";
  } catch {
    importError.value = "Ungültiges JSON";
    importParsed.value = null;
    importPreview.value = null;
  }
}

async function startImport() {
  if (!importParsed.value?.length) return;
  importing.value = true;
  importError.value = "";
  importResult.value = null;
  try {
    const res = await axios.post(`/api/v1/wiki/${workspaceId.value}/import`, {
      pages: importParsed.value,
    });
    importResult.value = res.data;
    importJson.value = "";
    importParsed.value = null;
    importPreview.value = null;
    await loadPages();
    await loadStats();
  } catch (e: any) {
    importError.value = e.response?.data?.error || e.message;
  } finally {
    importing.value = false;
  }
}

function closeImport() {
  showImport.value = false;
  importJson.value = "";
  importing.value = false;
  importError.value = "";
  importResult.value = null;
  importParsed.value = null;
  importPreview.value = null;
  if (fileInput.value) fileInput.value.value = "";
}
</script>

<style scoped>
.wiki-layout {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* ---- Rail ---- */
.wiki-rail {
  width: 300px;
  min-width: 300px;
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  overflow-y: auto;
}
.rail-search {
  padding: 0.75rem;
  border-bottom: 1px solid var(--color-border);
}
.search-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: 0.875rem;
  outline: none;
}
.search-input:focus {
  border-color: var(--color-primary);
}

.rail-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0.6rem 0.75rem;
  border: none;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: 0.85rem;
  font-family: inherit;
  cursor: pointer;
}

.rail-facets {
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  border-bottom: 1px solid var(--color-border);
}
.facet-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.facet-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--color-text-secondary);
  font-weight: 600;
}
.type-facets {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.type-facet {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text-secondary);
  font-size: 0.85rem;
  cursor: pointer;
  font-family: inherit;
}
.type-facet:hover {
  background: var(--color-bg-secondary);
}
.type-facet.active {
  border-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: 600;
}
.topic-facets {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.topic-facet {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.25rem 0.55rem;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.78rem;
  cursor: pointer;
  font-family: inherit;
}
.topic-facet:hover {
  border-color: var(--color-primary);
}
.topic-facet.active {
  background: var(--color-primary);
  color: #fff;
  border-color: var(--color-primary);
}
.cnt {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 8px;
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
}
.facet-select {
  width: 100%;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.85rem;
}
.facet-datepicker {
  width: 100%;
}
.facet-datepicker :deep(input) {
  padding: 0.4rem 0.6rem;
  font-size: 0.85rem;
  border-radius: 6px;
  width: 100%;
}
.btn-clear {
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-size: 0.8rem;
  cursor: pointer;
  font-family: inherit;
}

.rail-results {
  flex: 1;
  padding: 0.4rem;
}
.rail-results-head {
  font-size: 0.72rem;
  color: var(--color-text-secondary);
  padding: 0.4rem 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.rail-result {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.5rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.82rem;
}
.rail-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rail-result:hover {
  background: var(--color-bg-secondary);
}
.rail-result.active {
  background: var(--color-sidebar-active);
  color: #fff;
}
/* Übersichtsseite eines Dokument-Verbunds: Anker der Gruppe */
.rail-result.has-children .rail-label {
  font-weight: 600;
}
.rail-group + .rail-group {
  margin-top: 0.1rem;
}
.rail-caret {
  flex: 0 0 auto;
  width: 1.1rem;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  opacity: 0.65;
  font-size: 0.7rem;
  line-height: 1;
  cursor: pointer;
  font-family: inherit;
}
.rail-caret:hover {
  opacity: 1;
}
.rail-count {
  flex: 0 0 auto;
  padding: 0.05rem 0.35rem;
  border-radius: 8px;
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  font-size: 0.68rem;
}
.rail-result.active .rail-count {
  background: rgba(255, 255, 255, 0.22);
  color: #fff;
}
/* Kapitel: eingerückt an einer Führungslinie unter ihrer Übersicht */
.rail-children {
  margin-left: 0.6rem;
  padding-left: 0.5rem;
  border-left: 1px solid var(--color-border);
}
.rail-child {
  font-size: 0.79rem;
}
.rail-child-no {
  flex: 0 0 auto;
  min-width: 1.1rem;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
  font-size: 0.72rem;
}
.rail-child.active .rail-child-no {
  color: rgba(255, 255, 255, 0.8);
}

/* ---- Main / Discovery ---- */
.wiki-main {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem 2rem;
  background: var(--color-content-bg);
}
.discovery-head {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.25rem;
}
.result-count {
  font-size: 1rem;
  color: var(--color-text-secondary);
}
.result-count strong {
  color: var(--color-text);
  font-size: 1.2rem;
}
.active-chips {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.55rem;
  border-radius: 14px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  font-size: 0.8rem;
}
.chip button {
  border: none;
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0;
  line-height: 1;
}
.chip button:hover {
  color: var(--color-text);
}

/* Hinweis auf offene Chat-Verbund-Entwürfe */
.draft-banner {
  background: #fff7ed;
  border: 1px solid #fed7aa;
  border-radius: 10px;
  padding: 0.75rem 1rem;
  margin-bottom: 1.25rem;
}
.draft-banner-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #9a3412;
  font-size: 0.9rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
}
.draft-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.draft-list li {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.draft-title {
  font-weight: 600;
  color: var(--color-text);
}
.draft-meta {
  font-size: 0.8rem;
  color: var(--color-text-secondary, #6b7280);
}
.draft-open {
  margin-left: auto;
  background: #ea580c;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 0.35rem 0.7rem;
  font-size: 0.82rem;
  cursor: pointer;
}
.draft-open:hover {
  opacity: 0.9;
}

.stats-band {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}
.stat-card {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1.25rem;
  text-align: center;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  font-family: inherit;
}
.stat-card:disabled {
  cursor: default;
}
.stat-card:not(:disabled):hover {
  border-color: var(--color-primary);
}
.stat-number {
  display: block;
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--color-primary);
}
.stat-label {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  margin-top: 0.25rem;
}

.result-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 1rem;
}
.result-card {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 1rem;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  transition:
    border-color 0.12s,
    transform 0.12s;
}
.result-card:hover {
  border-color: var(--color-primary);
  transform: translateY(-2px);
}
.card-type {
  font-size: 0.72rem;
  font-weight: 600;
  align-self: flex-start;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
}
.card-type.summary {
  background: #e8f4fd;
  color: #0052d9;
}
.card-type.entity {
  background: #e8f8ee;
  color: #2ba471;
}
.card-type.concept {
  background: #fef3e2;
  color: #e37318;
}
.card-title {
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1.3;
  margin: 0;
}
.card-parent {
  font-size: 0.72rem;
  color: var(--color-text-secondary);
  margin: -0.25rem 0 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card-summary {
  font-size: 0.82rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 0;
}
.card-meta {
  display: flex;
  gap: 0.6rem;
  font-size: 0.72rem;
  color: var(--color-text-secondary);
  margin-top: auto;
}

.list-status {
  padding: 2rem 1rem;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 0.9rem;
}
.list-status.empty {
  padding: 3rem 1rem;
}
.reader-actions {
  margin-top: 1rem;
}

/* ---- Reader ---- */
.reader-header {
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 1rem;
  margin-bottom: 1.5rem;
}
.reader-header h2 {
  margin: 0.5rem 0;
  font-size: 1.4rem;
  line-height: 1.3;
}
.reader-meta {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  flex-wrap: wrap;
}
.type-tag {
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
}
.type-tag.summary {
  background: #e8f4fd;
  color: #0052d9;
}
.type-tag.entity {
  background: #e8f8ee;
  color: #2ba471;
}
.type-tag.concept {
  background: #fef3e2;
  color: #e37318;
}
.type-tag.article {
  background: #f0f0f0;
  color: #666;
}
.type-tag.chapters {
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
}
/* Breadcrumb: Übersicht › Kapitel N von M */
.reader-crumbs {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin-top: 0.6rem;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
}
.crumb-link {
  padding: 0;
  border: none;
  background: none;
  color: var(--color-primary, #0052d9);
  font-size: 0.8rem;
  font-family: inherit;
  cursor: pointer;
  max-width: 30rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crumb-link:hover {
  text-decoration: underline;
}
.crumb-sep {
  opacity: 0.6;
}

/* Kapitel-Navigation unter dem Artikel */
.chapter-nav {
  display: flex;
  gap: 0.75rem;
  max-width: 750px;
  margin: 2rem 0 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--color-border);
}
.chapter-nav-btn {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-secondary);
  color: var(--color-text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.chapter-nav-btn.next {
  text-align: right;
}
.chapter-nav-btn:hover:not(:disabled) {
  border-color: var(--color-primary, #0052d9);
}
.chapter-nav-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.chapter-nav-dir {
  font-size: 0.72rem;
  color: var(--color-text-secondary);
}
.chapter-nav-title {
  font-size: 0.85rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.reader-aliases {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  margin-top: 0.5rem;
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  flex-wrap: wrap;
}
.alias-tag {
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  background: var(--color-bg-secondary);
  font-size: 0.75rem;
}
.reader-body {
  line-height: 1.8;
  font-size: 0.95rem;
  max-width: 750px;
}
.reader-body :deep(h2) {
  font-size: 1.25rem;
  margin: 1.5rem 0 0.75rem;
}
.reader-body :deep(h3) {
  font-size: 1.1rem;
  margin: 1.25rem 0 0.5rem;
}
.reader-body :deep(h4) {
  font-size: 1rem;
  margin: 1rem 0 0.5rem;
}
.reader-body :deep(p) {
  margin-bottom: 0.75rem;
}
.reader-body :deep(ul),
.reader-body :deep(ol) {
  margin: 0.5rem 0 0.75rem 1.5rem;
  padding-left: 0.25rem;
}
/* Verschachtelte Liste (Einheit → Personen in der Teilnehmerliste) enger
   setzen, damit die Zugehörigkeit optisch erkennbar bleibt. */
.reader-body :deep(li > ul) {
  margin: 0.15rem 0 0.35rem 1.1rem;
}
.reader-body :deep(li) {
  margin-bottom: 0.2rem;
  line-height: 1.55;
}
/* Absätze innerhalb von Listenpunkten erzeugen sonst einen Leerraum pro Punkt */
.reader-body :deep(li > p) {
  margin: 0;
}
.reader-body :deep(blockquote) {
  margin: 0.6rem 0 0.8rem;
  padding: 0.4rem 0 0.4rem 0.9rem;
  border-left: 3px solid var(--color-primary);
  background: var(--color-bg-secondary);
  border-radius: 0 4px 4px 0;
  font-style: italic;
}
.reader-body :deep(blockquote p) {
  margin: 0;
}
.reader-body :deep(table) {
  border-collapse: collapse;
  margin: 0.75rem 0;
  font-size: 0.9rem;
}
.reader-body :deep(th),
.reader-body :deep(td) {
  border: 1px solid var(--color-border);
  padding: 0.3rem 0.5rem;
  text-align: left;
}
.reader-body :deep(code) {
  background: var(--color-bg-secondary);
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  font-size: 0.85em;
}

/* --- Zeitleiste (Jahr → Monat) --- */
.timeline {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.tl-year-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  background: none;
  border: none;
  padding: 0.25rem 0.35rem;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--color-text);
  cursor: pointer;
  border-radius: 4px;
}
.tl-year-head:hover {
  background: var(--color-bg-secondary);
}
.tl-months {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.2rem;
  padding: 0.2rem 0 0.35rem 0.6rem;
}
.tl-month {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.25rem;
  background: var(--color-bg-secondary);
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 0.2rem 0.3rem;
  font-size: 0.72rem;
  cursor: pointer;
  color: var(--color-text-secondary);
}
.tl-month:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.tl-month .cnt {
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

/* --- Auffälligkeiten auf den Karten --- */
.card-flags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin: 0.35rem 0 0.15rem;
}
.flag-chip {
  font-size: 0.66rem;
  padding: 0.1rem 0.35rem;
  border-radius: 10px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  white-space: nowrap;
}
.card-channel {
  opacity: 0.75;
}

/* --- Nachladen --- */
.load-more {
  display: flex;
  justify-content: center;
  margin: 1.25rem 0 0.5rem;
}
.btn-more {
  padding: 0.5rem 1.1rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.85rem;
  cursor: pointer;
}
.btn-more:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.btn-more:disabled {
  opacity: 0.6;
  cursor: default;
}

/* --- Inhaltsverzeichnis --- */
.reader-toc {
  margin: 0.75rem 0 1.25rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg-secondary);
  max-width: 750px;
}
.toc-head {
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  padding: 0.5rem 0.75rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.toc-list {
  list-style: none;
  margin: 0;
  padding: 0 0.75rem 0.6rem;
}
.toc-item {
  margin: 0.1rem 0;
  font-size: 0.85rem;
  line-height: 1.4;
}
.toc-item a {
  color: var(--color-primary);
  text-decoration: none;
  cursor: pointer;
}
.toc-item a:hover {
  text-decoration: underline;
}
.toc-l3 {
  padding-left: 1rem;
}
.reader-body :deep(.wiki-link) {
  color: var(--color-primary);
  text-decoration: underline;
  text-decoration-style: dotted;
  cursor: pointer;
}
.reader-body :deep(.wiki-link:hover) {
  text-decoration-style: solid;
}
.reader-footer {
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--color-border);
}
.links-section {
  margin-bottom: 0.75rem;
}
.links-section h4 {
  font-size: 0.85rem;
  color: var(--color-text-secondary);
  margin-bottom: 0.4rem;
}
.link-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.link-chip {
  padding: 0.2rem 0.5rem;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 0.78rem;
  cursor: pointer;
  font-family: inherit;
}
.link-chip:hover {
  background: var(--color-primary);
  color: #fff;
  border-color: var(--color-primary);
}
.btn-back {
  background: none;
  border: none;
  color: var(--color-primary);
  cursor: pointer;
  font-size: 0.875rem;
  padding: 0;
  font-family: inherit;
}
.btn-back:hover {
  text-decoration: underline;
}

/* Ebene 4: Edit / Historie / Lock / externe Links */
.reader-actions-bar {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.6rem;
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
.btn-mini:disabled {
  opacity: 0.5;
  cursor: default;
}
.lock-badge {
  padding: 0.1rem 0.45rem;
  border-radius: 10px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  font-size: 0.72rem;
}
.reader-edit {
  max-width: 800px;
  display: flex;
  flex-direction: column;
}
.edit-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  margin: 0.6rem 0 0.2rem;
}
.edit-input {
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.9rem;
  font-family: inherit;
}
.edit-toolbar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin: 0.3rem 0;
}
.edit-hint {
  font-size: 0.72rem;
  color: var(--color-text-secondary);
}
.edit-textarea {
  width: 100%;
  padding: 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: ui-monospace, monospace;
  font-size: 0.85rem;
  line-height: 1.6;
  resize: vertical;
}
.edit-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 0.75rem;
}
.reader-body :deep(.ext-link) {
  color: var(--color-primary);
}
.rev-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: 320px;
  overflow-y: auto;
}
.rev-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
}
.rev-info {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}
.rev-ver {
  font-weight: 600;
  font-size: 0.85rem;
}
.rev-date {
  font-size: 0.78rem;
  color: var(--color-text-secondary);
}

/* ---- Dialogs ---- */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  background: var(--color-bg);
  border-radius: 10px;
  padding: 1.5rem;
  min-width: 400px;
  max-width: 600px;
  max-height: 80vh;
  overflow-y: auto;
}
.dialog-wide {
  min-width: 500px;
}
.dialog h3 {
  margin-bottom: 1rem;
}
.dialog-hint {
  font-size: 0.85rem;
  color: var(--color-text-secondary);
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
.import-textarea {
  font-family: monospace;
  font-size: 0.8rem;
}
.dialog-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 1rem;
}
.import-preview,
.import-result {
  padding: 0.5rem;
  border-radius: 6px;
  background: var(--color-bg-secondary);
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
}
.error {
  color: #e74c3c;
  font-size: 0.85rem;
}
.success {
  color: #27ae60;
  font-size: 0.85rem;
}
.warning {
  color: #f39c12;
  font-size: 0.85rem;
}
.btn-primary {
  padding: 0.45rem 1rem;
  background: var(--color-primary);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  font-family: inherit;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn-secondary {
  padding: 0.45rem 1rem;
  background: var(--color-bg-secondary);
  color: var(--color-text);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  font-family: inherit;
}

/* ---- Responsive: Rail über Vollbreite, dann Detail ---- */
@media (max-width: 768px) {
  .wiki-layout {
    display: block;
    overflow: visible;
  }
  .wiki-rail {
    width: 100%;
    min-width: 0;
    border-right: none;
  }
  /* Filter-Accordion: prominenter, gut tippbarer Header */
  .rail-toggle {
    font-size: 0.95rem;
    font-weight: 600;
    padding: 0.85rem 1rem;
  }
  /* Eingeklappt keine doppelte Trennlinie unter dem Accordion */
  .rail-facets {
    padding: 0.85rem 1rem 1rem;
  }
  .wiki-main {
    padding: 1rem 1.1rem;
  }
  /* Discovery: Rail (Filter) oben, Grid darunter — beide sichtbar */
  .wiki-layout:not(.reader) .wiki-main {
    display: block;
  }
  /* Reader: nur der Artikel, Rail ausblenden */
  .wiki-layout.reader .wiki-rail {
    display: none;
  }
  .reader-header h2 {
    font-size: 1.35rem;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .reader-body {
    overflow-wrap: anywhere;
  }
  .dialog,
  .dialog-wide {
    min-width: 0;
    width: calc(100vw - 2rem);
    max-width: calc(100vw - 2rem);
  }
}
</style>

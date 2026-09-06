<!--
  Verzeichnis eines Wiki — der Überblick über den Bestand.

  Warum eine eigene Seite neben dem Wiki-Reiter: der Browser dort beantwortet
  „finde mir die Seite, die ich suche". Diese hier beantwortet die andere Frage,
  die vorher nirgends gestellt werden konnte — „was steht hier eigentlich alles
  drin, und was davon trägt". `/index` lieferte die Gruppen je Typ zwar schon,
  aber das Frontend nahm daraus nur den Intro-Text; die Konzepte gab es
  ausschließlich als Teaser der obersten 15 in der Rail.

  Vier Sichten statt vier Seiten. Sortierungen sind billig und revidierbar,
  Seiten sind es nicht — derselbe Grund, aus dem das Wiki keine Ordnerstruktur
  hat: eine Ordnung festzuschreiben heißt, alle anderen zu verlieren.
-->
<template>
  <main class="verzeichnis">
    <div class="head">
      <h3>Verzeichnis</h3>
      <select v-model="typ" @change="laden" class="typ">
        <option value="concept">Konzepte</option>
        <option value="entity">Entitäten</option>
        <option value="summary">Zusammenfassungen</option>
        <option value="all">Alle Artikel</option>
      </select>
    </div>

    <div class="sichten">
      <button
        v-for="s in SICHTEN"
        :key="s.wert"
        class="sicht"
        :class="{ active: sicht === s.wert }"
        :title="s.frage"
        @click="wechsle(s.wert)"
      >
        {{ s.label }}
      </button>
      <span class="frage">{{ aktuelleSicht.frage }}</span>
    </div>

    <p v-if="lade" class="empty">Lade Verzeichnis…</p>
    <p v-else-if="fehler" class="empty">❌ {{ fehler }}</p>
    <p v-else-if="!daten?.pages.length" class="empty">
      {{
        sicht === "orphans"
          ? "Keine Waisen — auf jede Seite verweist mindestens eine andere."
          : "Noch keine Seiten dieser Art."
      }}
    </p>

    <template v-else>
      <div class="bilanz">
        <strong>{{ daten.total }}</strong>
        {{ daten.total === 1 ? "Seite" : "Seiten" }}
        <span v-if="gekürzt" class="warn">
          — angezeigt werden die ersten {{ daten.pages.length }}
        </span>
      </div>

      <!-- Buchstabenleiste: nur im Verzeichnis, wo sie etwas bedeutet. -->
      <nav v-if="sicht === 'alpha'" class="buchstaben">
        <a
          v-for="b in buchstaben"
          :key="b"
          :href="`#b-${b}`"
          @click.prevent="springe(b)"
          >{{ b }}</a
        >
      </nav>

      <!-- Verzeichnis: nach Buchstaben gruppiert -->
      <template v-if="sicht === 'alpha'">
        <section v-for="g in gruppen" :key="g.buchstabe" class="gruppe">
          <h4 :id="`b-${g.buchstabe}`" class="buchstabe">
            {{ g.buchstabe }}
          </h4>
          <ul class="liste">
            <li v-for="p in g.seiten" :key="p.id">
              <router-link :to="pfad(p.slug)" class="titel">{{
                p.title
              }}</router-link>
              <span v-if="p.summary" class="summary">{{ kurz(p.summary) }}</span>
              <span class="zahlen">{{ kennzahl(p) }}</span>
            </li>
          </ul>
        </section>
      </template>

      <!-- Rangliste: die Kennzahl steht vorn, weil sie die Ordnung erklärt -->
      <ol v-else class="rang">
        <li v-for="p in daten.pages" :key="p.id">
          <span class="wert" :class="{ null: hauptzahl(p) === 0 }">{{
            hauptzahl(p)
          }}</span>
          <span class="zeile">
            <router-link :to="pfad(p.slug)" class="titel">{{
              p.title
            }}</router-link>
            <span v-if="p.summary" class="summary">{{ kurz(p.summary) }}</span>
          </span>
          <span class="zahlen">{{ kennzahl(p) }}</span>
        </li>
      </ol>
    </template>
  </main>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import axios from "axios";
import { useWiki } from "../../composables/useWiki";

type Sicht = "alpha" | "connections" | "evidence" | "orphans";

interface Seite {
  id: string;
  slug: string;
  title: string;
  summary: string;
  page_type: string;
  in_count: number;
  out_count: number;
  belege: number;
  quellen: number;
  bucket: string;
}

const SICHTEN: { wert: Sicht; label: string; frage: string }[] = [
  {
    wert: "alpha",
    label: "A–Z",
    frage: "Was steht hier alles drin?",
  },
  {
    wert: "connections",
    label: "Vernetzung",
    frage: "Worum geht es in diesem Wiki?",
  },
  {
    wert: "evidence",
    label: "Belegdecke",
    frage: "Was ist belegt und was ein Stummel?",
  },
  {
    wert: "orphans",
    label: "Waisen",
    frage: "Auf welche Seiten verweist niemand?",
  },
];

const route = useRoute();
const { resolveWiki, isUUID } = useWiki();

// Wie in der Kostenansicht: in der Adresse kann eine UUID **oder** ein Slug
// stehen, die API kennt nur die UUID. Für Links bleibt der Parameter aus der
// Adresse erhalten, damit ein lesbarer Pfad lesbar bleibt.
const wikiParam = computed(() => route.params.id as string);
const wikiUuid = ref("");

const typ = ref("concept");
const sicht = ref<Sicht>("alpha");
const lade = ref(true);
const fehler = ref("");
const daten = ref<{ pages: Seite[]; total: number; page_size: number } | null>(
  null,
);

const aktuelleSicht = computed(
  () => SICHTEN.find((s) => s.wert === sicht.value)!,
);

/** Der Bestand passte nicht in eine Antwort — siehe MAX_OVERVIEW_SIZE. */
const gekürzt = computed(
  () => !!daten.value && daten.value.total > daten.value.pages.length,
);

const gruppen = computed(() => {
  const map = new Map<string, Seite[]>();
  for (const p of daten.value?.pages ?? []) {
    const b = p.bucket || "#";
    if (!map.has(b)) map.set(b, []);
    map.get(b)!.push(p);
  }
  return [...map.entries()].map(([buchstabe, seiten]) => ({
    buchstabe,
    seiten,
  }));
});

const buchstaben = computed(() => gruppen.value.map((g) => g.buchstabe));

onMounted(laden);

function wechsle(s: Sicht) {
  sicht.value = s;
  laden();
}

async function laden() {
  lade.value = true;
  fehler.value = "";
  try {
    if (!wikiUuid.value) {
      if (isUUID(wikiParam.value)) {
        wikiUuid.value = wikiParam.value;
      } else {
        const aufgelöst = await resolveWiki(wikiParam.value);
        if (!aufgelöst) {
          fehler.value = `Wiki „${wikiParam.value}" nicht gefunden`;
          return;
        }
        wikiUuid.value = aufgelöst.id;
      }
    }
    const res = await axios.get(`/api/v1/pages/${wikiUuid.value}/overview`, {
      params: { type: typ.value, view: sicht.value },
    });
    daten.value = res.data;
  } catch (e: any) {
    fehler.value = e.response?.data?.error || "Verzeichnis nicht ladbar";
  } finally {
    lade.value = false;
  }
}

function pfad(slug: string) {
  return `/wikis/${wikiParam.value}/wiki/${slug}`;
}

function springe(b: string) {
  document.getElementById(`b-${b}`)?.scrollIntoView({ behavior: "smooth" });
}

/** Die Zahl, nach der die aktuelle Sicht ordnet. */
function hauptzahl(p: Seite): number {
  return sicht.value === "evidence" ? p.belege : p.in_count;
}

function kurz(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 140 ? t.slice(0, 139) + "…" : t;
}

/**
 * Die Kennzahlen am Zeilenende — immer dieselben, in jeder Sicht.
 *
 * Absichtlich nicht je Sicht wechselnd: wer von „Belegdecke" auf „Vernetzung"
 * umschaltet, will sehen, dass ein gut belegtes Konzept schlecht vernetzt ist.
 * Blendete man die jeweils andere Zahl aus, wäre genau dieser Vergleich weg.
 */
function kennzahl(p: Seite): string {
  const teile = [`← ${p.in_count}`, `→ ${p.out_count}`];
  if (p.belege) {
    teile.push(
      p.quellen > 1
        ? `${p.belege} Belege / ${p.quellen} Quellen`
        : `${p.belege} Belege`,
    );
  }
  return teile.join("  ·  ");
}
</script>

<style scoped>
.verzeichnis {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem 1.5rem 3rem;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.75rem;
}

.head h3 {
  margin: 0;
}

.typ {
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
}

.sichten {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 1rem;
}

.sicht {
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-bg);
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 0.85rem;
}

.sicht.active {
  color: var(--color-primary);
  border-color: var(--color-primary);
}

.frage {
  margin-left: 0.5rem;
  color: var(--color-text-secondary);
  font-size: 0.85rem;
  font-style: italic;
}

.bilanz {
  color: var(--color-text-secondary);
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
}

.warn {
  color: var(--color-text-secondary);
}

.buchstaben {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-bottom: 1rem;
  position: sticky;
  top: 0;
  background: var(--color-bg);
  padding: 0.4rem 0;
  z-index: 1;
}

.buchstaben a {
  min-width: 1.5rem;
  text-align: center;
  padding: 0.1rem 0.3rem;
  border-radius: 4px;
  color: var(--color-primary);
  text-decoration: none;
  font-size: 0.85rem;
}

.buchstabe {
  margin: 1.25rem 0 0.4rem;
  padding-bottom: 0.2rem;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 0.95rem;
}

.liste,
.rang {
  list-style: none;
  margin: 0;
  padding: 0;
}

.liste li,
.rang li {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  padding: 0.3rem 0;
  border-bottom: 1px solid var(--color-border);
}

.rang li {
  gap: 0.75rem;
}

.wert {
  min-width: 2.5rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--color-primary);
}

.wert.null {
  color: var(--color-text-secondary);
  font-weight: 400;
}

.zeile {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  flex: 1;
  min-width: 0;
}

.titel {
  color: var(--color-text);
  text-decoration: none;
  font-weight: 500;
  white-space: nowrap;
}

.titel:hover {
  color: var(--color-primary);
}

.summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
  font-size: 0.85rem;
}

.zahlen {
  color: var(--color-text-secondary);
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.empty {
  color: var(--color-text-secondary);
  padding: 2rem 0;
}

@media (max-width: 700px) {
  .summary {
    display: none;
  }
}
</style>

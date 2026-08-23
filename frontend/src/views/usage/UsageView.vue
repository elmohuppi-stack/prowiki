<!--
  Kostenübersicht eines Wiki.

  Warum diese Seite überhaupt, wo doch der Anbieter selbst eine Nutzungsseite
  hat: das Dashboard von DeepSeek kennt Summen, aber keine Dokumente. Es kann
  sagen, dass ein Tag 1,80 € gekostet hat, nicht welches Video davon 1,20 €
  ausmachte und wie viele Artikel dabei herauskamen. Genau diese Zuordnung ist
  der Grund, warum `usage_events` eine `ref_id` hat.

  Die Seite zeigt deshalb drei Dinge, die es beim Anbieter nicht gibt:
  Zuordnung (welches Dokument), Ertrag (Kosten je Artikel) und Ausreißer
  (die Tabelle unten, sortierbar nach € je Artikel).
-->
<template>
  <main class="usage">
    <div class="head">
      <h3>LLM-Nutzung</h3>
      <select v-model.number="tage" @change="laden" class="zeitraum">
        <option :value="7">7 Tage</option>
        <option :value="30">30 Tage</option>
        <option :value="90">90 Tage</option>
        <option :value="365">1 Jahr</option>
      </select>
    </div>

    <p v-if="lade" class="empty">Lade Zahlen…</p>
    <p v-else-if="fehler" class="empty">❌ {{ fehler }}</p>

    <template v-else-if="daten">
      <!-- Kennzahlen -->
      <div class="kpis">
        <div class="kpi">
          <span class="kpi-label">Kosten</span>
          <span class="kpi-wert">{{ euro(daten.kpi.cost_micros) }}</span>
          <span class="kpi-sub">
            {{
              daten.kpi.kosten_je_artikel_micros !== null
                ? euro(daten.kpi.kosten_je_artikel_micros) + " je Artikel"
                : "keine Artikel"
            }}
          </span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Tokens</span>
          <span class="kpi-wert">{{
            kurz(daten.kpi.tokens_in + daten.kpi.tokens_out)
          }}</span>
          <span class="kpi-sub"
            >{{ prozent(daten.kpi.cache_quote) }} aus dem Cache</span
          >
        </div>
        <div class="kpi">
          <span class="kpi-label">Aufrufe</span>
          <span class="kpi-wert">{{ zahl(daten.kpi.events) }}</span>
          <span class="kpi-sub">im gewählten Zeitraum</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Artikel</span>
          <span class="kpi-wert">{{ zahl(daten.kpi.artikel_gesamt) }}</span>
          <span class="kpi-sub">im Wiki insgesamt</span>
        </div>
      </div>

      <p v-if="daten.unbepreiste_modelle.length" class="warnung">
        ⚠️ Für
        {{ daten.unbepreiste_modelle.join(", ") }}
        ist kein Preis hinterlegt — die Tokens sind gezählt, in den Euro-Zahlen
        fehlen diese Aufrufe. Preistabelle:
        <code>backend/src/service/usage.ts</code>
      </p>

      <!-- Tagesreihe. Gestapelte Balken, reines CSS: eine Diagrammbibliothek
           für sechs Balkenfarben wäre ein Bündel mehr im Ladepfad. -->
      <section class="block">
        <h4>Kosten je Tag</h4>
        <div v-if="tagesReihe.length" class="chart">
          <div v-for="t in tagesReihe" :key="t.tag" class="saeule">
            <div
              class="saeule-inner"
              :style="{ height: hoehe(t.summe) }"
              :title="`${datum(t.tag)}: ${euro(t.summe)}`"
            >
              <div
                v-for="s in t.stapel"
                :key="s.kind"
                class="stueck"
                :style="{
                  height: (s.cost_micros / t.summe) * 100 + '%',
                  background: farbe(s.kind),
                }"
              ></div>
            </div>
            <span class="saeule-label">{{ kurzDatum(t.tag) }}</span>
          </div>
        </div>
        <p v-else class="empty">Keine Posten im Zeitraum.</p>
        <div class="legende">
          <span v-for="a in daten.nach_art" :key="a.kind" class="legende-eintrag">
            <i :style="{ background: farbe(a.kind) }"></i>{{ artLabel(a.kind) }}
          </span>
        </div>
      </section>

      <!-- Aufschlüsselung -->
      <div class="zwei-spalten">
        <section class="block">
          <h4>Nach Art</h4>
          <table class="tab">
            <tbody>
              <tr v-for="a in sortiert(daten.nach_art)" :key="a.kind">
                <td>
                  <i class="punkt" :style="{ background: farbe(a.kind) }"></i>
                  {{ artLabel(a.kind) }}
                </td>
                <td class="num">{{ zahl(a.events) }}×</td>
                <td class="num">{{ euro(a.cost_micros) }}</td>
                <td class="num dim">
                  {{ prozent(a.cost_micros / (daten.kpi.cost_micros || 1)) }}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="block">
          <h4>Nach Modell</h4>
          <table class="tab">
            <tbody>
              <tr v-for="m in sortiert(daten.nach_modell)" :key="m.model || '–'">
                <td>
                  {{ m.model || "– (ohne Modellangabe)" }}
                  <span
                    v-if="m.model && daten.unbepreiste_modelle.includes(m.model)"
                    class="tag-warn"
                    title="Kein Preis hinterlegt"
                    >kein Preis</span
                  >
                </td>
                <td class="num">{{ zahl(m.events) }}×</td>
                <td class="num">{{ kurz(m.tokens_in + m.tokens_out) }}</td>
                <td class="num">{{ euro(m.cost_micros) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <!-- Je Eingangsdokument -->
      <section class="block">
        <h4>Nach Eingangsdokument</h4>
        <table class="tab breit">
          <thead>
            <tr>
              <th @click="sortiereNach('title')" class="klick">Titel</th>
              <th @click="sortiereNach('tokens')" class="klick num">Tokens</th>
              <th @click="sortiereNach('artikel')" class="klick num">Artikel</th>
              <th @click="sortiereNach('cost_micros')" class="klick num">
                Kosten
              </th>
              <th @click="sortiereNach('je_artikel')" class="klick num">
                € / Artikel
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in dokumente" :key="d.document_id">
              <td>
                <router-link
                  :to="`/wikis/${wikiParam}/documents/${d.document_id}`"
                  class="doc-link"
                  >{{ d.title }}</router-link
                >
              </td>
              <td class="num">{{ kurz(d.tokens_in + d.tokens_out) }}</td>
              <td class="num">{{ d.artikel || "–" }}</td>
              <td class="num">{{ euro(d.cost_micros) }}</td>
              <td class="num">
                {{
                  d.kosten_je_artikel_micros !== null
                    ? euro(d.kosten_je_artikel_micros)
                    : "–"
                }}
              </td>
            </tr>
            <tr v-if="!dokumente.length">
              <td colspan="5" class="empty">
                Keine Posten mit Dokumentbezug im Zeitraum.
              </td>
            </tr>
          </tbody>
        </table>
        <p class="fussnote">
          Sortierbar durch Klick auf eine Spaltenüberschrift. „€ / Artikel“ zeigt
          die Ausreißer: ein Dokument, das viel gekostet und wenig Artikel
          erbracht hat, hatte meist Wiederholungsläufe nach einem Fehler beim
          Anbieter — die sind bezahlt und werden mitgezählt.
        </p>
      </section>

      <p class="fussnote stand">
        {{ daten.hinweis }} Preisstand {{ daten.preis_version }}.
      </p>
    </template>
  </main>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute } from "vue-router";
import axios from "axios";
import { useWiki } from "../../composables/useWiki";
import {
  euro,
  kurz,
  zahl,
  prozent,
  artLabel,
  farbe,
} from "../../utils/kosten";

const route = useRoute();
const { resolveWiki, isUUID } = useWiki();

/**
 * Was in der Adresse steht — eine UUID **oder** ein Slug wie „politik". Die
 * Wiki-Routen erlauben beides, die API kennt nur die UUID. Genau das fehlte
 * hier zuerst: die Seite gab „Wiki nicht gefunden", sobald man sie über den
 * lesbaren Pfad öffnete, also praktisch immer.
 *
 * Für Verweise auf Dokumente bleibt der Parameter aus der Adresse stehen: wer
 * über /wikis/politik/… gekommen ist, soll nicht plötzlich eine UUID im
 * Adressfeld haben.
 */
const wikiParam = computed(() => route.params.id as string);
const wikiUuid = ref("");

const tage = ref(30);
const lade = ref(true);
const fehler = ref("");
const daten = ref<any>(null);

/** Spalte, nach der die Dokumenttabelle sortiert ist. */
const sortSpalte = ref<
  "title" | "tokens" | "artikel" | "cost_micros" | "je_artikel"
>("cost_micros");
const sortAb = ref(true);

onMounted(laden);

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

    const r = await axios.get(
      `/api/v1/usage/wiki/${wikiUuid.value}/uebersicht`,
      { params: { days: tage.value } },
    );
    daten.value = r.data;
  } catch (e: any) {
    fehler.value = e.response?.data?.error || e.message;
  } finally {
    lade.value = false;
  }
}

/**
 * Die Tagesreihe kommt flach als (Tag, Art, Kosten). Für gestapelte Balken
 * muss sie je Tag gebündelt sein — und Tage ganz ohne Posten dürfen fehlen:
 * eine Lücke im Balkendiagramm ist ehrlicher als eine Null, die aussieht wie
 * ein gemessener Wert.
 */
const tagesReihe = computed(() => {
  if (!daten.value) return [];
  const je = new Map<string, { kind: string; cost_micros: number }[]>();
  for (const z of daten.value.tage) {
    const l = je.get(z.tag);
    if (l) l.push(z);
    else je.set(z.tag, [z]);
  }
  return [...je.entries()].map(([tag, stapel]) => ({
    tag,
    stapel,
    summe: stapel.reduce((s, x) => s + x.cost_micros, 0),
  }));
});

const maxTag = computed(() =>
  Math.max(1, ...tagesReihe.value.map((t) => t.summe)),
);

function hoehe(summe: number) {
  // Mindesthöhe, damit ein sehr kleiner Tag nicht unsichtbar wird und der
  // Eindruck entsteht, es sei an dem Tag nichts gelaufen.
  return Math.max(2, (summe / maxTag.value) * 100) + "%";
}

function sortiert(zeilen: any[]) {
  return [...zeilen].sort((a, b) => b.cost_micros - a.cost_micros);
}

function sortiereNach(spalte: typeof sortSpalte.value) {
  if (sortSpalte.value === spalte) sortAb.value = !sortAb.value;
  else {
    sortSpalte.value = spalte;
    sortAb.value = true;
  }
}

const dokumente = computed(() => {
  if (!daten.value) return [];
  const wert = (d: any) => {
    switch (sortSpalte.value) {
      case "title":
        return d.title || "";
      case "tokens":
        return d.tokens_in + d.tokens_out;
      case "artikel":
        return d.artikel;
      case "je_artikel":
        // Dokumente ohne Artikel ans Ende, statt sie als „billig" (null → 0)
        // an die Spitze zu sortieren.
        return d.kosten_je_artikel_micros ?? -1;
      default:
        return d.cost_micros;
    }
  };
  return [...daten.value.dokumente].sort((a, b) => {
    const x = wert(a);
    const y = wert(b);
    const v =
      typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
    return sortAb.value ? -v : v;
  });
});

function datum(tag: string) {
  return new Date(tag + "T12:00:00").toLocaleDateString("de-DE");
}
function kurzDatum(tag: string) {
  return new Date(tag + "T12:00:00").toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
  });
}
</script>

<style scoped>
.usage {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem 1.5rem 3rem;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}
.head h3 {
  margin: 0;
  font-size: 1.05rem;
}
.zeitraum {
  padding: 0.35rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.85rem;
}
.empty {
  color: var(--color-text-secondary);
  text-align: center;
  padding: 1.5rem;
}

/* Kennzahlen */
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.kpi {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 0.75rem 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.kpi-label {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.kpi-wert {
  font-size: 1.5rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.kpi-sub {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}

.warnung {
  background: #fff7ed;
  border: 1px solid #fdba74;
  color: #7c2d12;
  border-radius: 8px;
  padding: 0.6rem 0.8rem;
  font-size: 0.8rem;
  margin-bottom: 1rem;
}
[data-theme="dark"] .warnung {
  background: #2b1a0c;
  border-color: #7c4a1e;
  color: #fbbf24;
}
.warnung code {
  font-size: 0.75rem;
}

.block {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 0.9rem 1rem;
  margin-bottom: 1rem;
}
.block h4 {
  margin: 0 0 0.75rem;
  font-size: 0.9rem;
}
.zwei-spalten {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1rem;
}

/* Balken */
.chart {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 140px;
  overflow-x: auto;
}
.saeule {
  flex: 1 0 14px;
  min-width: 14px;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  gap: 3px;
}
.saeule-inner {
  width: 100%;
  display: flex;
  flex-direction: column-reverse;
  border-radius: 3px 3px 0 0;
  overflow: hidden;
}
.stueck {
  width: 100%;
}
.saeule-label {
  font-size: 0.6rem;
  color: var(--color-text-secondary);
  white-space: nowrap;
  transform: rotate(-45deg);
  transform-origin: center;
  height: 1rem;
}
.legende {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-top: 1.25rem;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
}
.legende-eintrag {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}
.legende i,
.punkt {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  display: inline-block;
}

/* Tabellen */
.tab {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}
.tab th {
  text-align: left;
  font-weight: 600;
  color: var(--color-text-secondary);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0.3rem 0.4rem;
  border-bottom: 1px solid var(--color-border);
}
.tab td {
  padding: 0.35rem 0.4rem;
  border-bottom: 1px solid var(--color-border);
}
.tab tr:last-child td {
  border-bottom: none;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dim {
  color: var(--color-text-secondary);
}
.klick {
  cursor: pointer;
  user-select: none;
}
.klick:hover {
  color: var(--color-primary);
}
.doc-link {
  color: var(--color-primary);
  text-decoration: none;
}
.tag-warn {
  font-size: 0.68rem;
  background: #fef3c7;
  color: #92400e;
  border-radius: 4px;
  padding: 0 0.3rem;
  margin-left: 0.35rem;
}
.fussnote {
  font-size: 0.72rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
  margin: 0.75rem 0 0;
}
.stand {
  padding: 0 0.2rem;
}
</style>

<template>
  <div class="speech-bar" v-if="supported">
    <button class="speech-play" @click="onToggle" :title="title">
      {{ state === "playing" ? "⏸" : "▶" }}
      <span class="speech-play-label">{{ label }}</span>
    </button>

    <template v-if="isActive">
      <button class="speech-icon" @click="seek(-1)" title="Zurück">⏮</button>
      <button class="speech-icon" @click="seek(1)" title="Weiter">⏭</button>
      <button class="speech-icon" @click="stop()" title="Stopp">⏹</button>

      <div class="speech-progress">
        <div class="speech-progress-bar">
          <div
            class="speech-progress-fill"
            :style="{ width: progress * 100 + '%' }"
          ></div>
        </div>
        <span class="speech-progress-text">
          {{ index + 1 }} / {{ chunks.length }}
        </span>
      </div>
    </template>

    <div class="speech-settings">
      <select
        :value="rate"
        @change="setRate(Number(($event.target as HTMLSelectElement).value))"
        title="Tempo"
      >
        <option v-for="r in RATES" :key="r" :value="r">{{ r }}×</option>
      </select>
      <select
        v-if="voices.length > 1"
        :value="voiceName"
        @change="setVoice(($event.target as HTMLSelectElement).value)"
        title="Stimme"
      >
        <option value="">
          Auto{{ activeVoice ? ` (${activeVoice.name})` : "" }}
        </option>
        <option v-for="v in voices" :key="v.name" :value="v.name">
          {{ v.name }}
        </option>
      </select>
    </div>
  </div>
</template>

<script setup lang="ts">
// Vorlese-Leiste für einen Wiki-Artikel. Kapselt useSpeech, damit die
// Artikel-Ansichten (WikiPage, WikiBrowser) sie nur einhängen müssen.
import { computed, watch } from "vue";
import { useSpeech } from "../composables/useSpeech";
import { buildArticleSpeech, type SpeechArticle } from "../utils/speech-text";

const props = defineProps<{
  article: SpeechArticle | null | undefined;
  /** Kennung des Artikels – wechselt sie, wird die Ausgabe gestoppt. */
  articleKey?: string | number | null;
}>();

const RATES = [0.75, 1, 1.25, 1.5, 1.75];

const {
  supported,
  voices,
  voiceName,
  activeVoice,
  rate,
  state,
  chunks,
  index,
  isActive,
  progress,
  toggle,
  stop,
  seek,
  setRate,
  setVoice,
} = useSpeech("de");

const label = computed(() => {
  if (state.value === "playing") return "Pause";
  if (state.value === "paused") return "Fortsetzen";
  return "Vorlesen";
});
const title = computed(() =>
  state.value === "idle" ? "Artikel vorlesen" : label.value,
);

function onToggle() {
  toggle(() => buildArticleSpeech(props.article ?? {}));
}

// Anderer Artikel ausgewählt → nicht den alten weiterlesen
watch(
  () => props.articleKey,
  () => stop(),
);

// Verlässt die Leiste das DOM (z. B. Wechsel in den Editor), räumt useSpeech
// im onUnmounted auf – ein v-if am Einsatzort genügt also zum Stoppen.
</script>

<style scoped>
.speech-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
  padding: 0.5rem 0.75rem;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
}
.speech-play {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 0.875rem;
  cursor: pointer;
}
.speech-icon {
  padding: 0.375rem 0.5rem;
  background: none;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.875rem;
  color: var(--color-text);
  cursor: pointer;
  line-height: 1;
}
.speech-icon:hover {
  border-color: var(--color-primary);
}
.speech-progress {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1;
  min-width: 120px;
}
.speech-progress-bar {
  flex: 1;
  height: 4px;
  background: var(--color-border);
  border-radius: 2px;
  overflow: hidden;
}
.speech-progress-fill {
  height: 100%;
  background: var(--color-primary);
  transition: width 0.2s ease;
}
.speech-progress-text {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.speech-settings {
  display: flex;
  gap: 0.375rem;
  margin-left: auto;
}
.speech-settings select {
  padding: 0.25rem 0.375rem;
  font-size: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  max-width: 150px;
}

@media (max-width: 640px) {
  /* Auf dem Handy zählt die Bedienung, nicht der Stimmenname */
  .speech-play-label {
    display: none;
  }
  .speech-settings select {
    max-width: 92px;
  }
}
</style>

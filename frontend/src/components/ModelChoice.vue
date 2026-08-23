<!--
  Modellauswahl für einen Import.

  Steht in einer eigenen Datei, weil sie an drei Stellen derselben Seite
  auftaucht (Upload, URL, YouTube) und dort dieselbe Wahl meint — dreimal
  dasselbe `<select>` hinzuschreiben hieße, dass eine spätere Änderung an zwei
  Stellen vergessen wird.

  Sie zeigt sich erst ab zwei Anbietern: bei einem gibt es nichts zu wählen.
  Der leere Eintrag „Standard" ist die Vorgabe und schickt gar keine ID mit —
  dann entscheidet das Backend wie bisher (service/provider.ts). Er ist nicht
  dasselbe wie der erste Eintrag der Liste, auch wenn heute derselbe Anbieter
  dahintersteht: wer „Standard" wählt, folgt der Einstellung auch dann noch,
  wenn sie sich morgen ändert.
-->
<template>
  <label v-if="providers.length > 1" class="modell-wahl">
    <span>Modell</span>
    <select
      :value="modelValue"
      @change="
        $emit('update:modelValue', ($event.target as HTMLSelectElement).value)
      "
    >
      <option value="">Standard ({{ providers[0].name }})</option>
      <option v-for="p in providers" :key="p.id" :value="p.id">
        {{ p.name }} · {{ p.default_model }}
      </option>
    </select>
  </label>
</template>

<script setup lang="ts">
defineProps<{
  providers: Array<{ id: string; name: string; default_model: string }>;
  modelValue: string;
}>();
defineEmits<{ (e: "update:modelValue", v: string): void }>();
</script>

<style scoped>
.modell-wahl {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: var(--color-text-secondary);
}
.modell-wahl select {
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.85rem;
}
</style>

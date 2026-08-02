<template>
  <select
    class="workspace-select"
    :value="modelValue"
    :disabled="loading || options.length === 0"
    @change="onChange"
  >
    <option value="">{{ placeholderLabel }}</option>
    <option v-for="ws in options" :key="ws.id" :value="ws.id">
      {{ ws.name }}
    </option>
  </select>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import axios from "axios";

interface Workspace {
  id: string;
  name: string;
  slug?: string;
  my_role?: string;
  can_write?: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** Nur Workspaces anzeigen, in denen der User schreiben darf. */
    writableOnly?: boolean;
    /** Diese ID aus der Liste ausschließen (z.B. der aktuelle Workspace). */
    exclude?: string;
    placeholder?: string;
    emptyLabel?: string;
  }>(),
  {
    writableOnly: false,
    exclude: "",
    placeholder: "Workspace wählen…",
    emptyLabel: "Kein anderer Workspace verfügbar",
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "loaded", workspaces: Workspace[]): void;
}>();

const all = ref<Workspace[]>([]);
const loading = ref(false);

const options = computed(() =>
  all.value.filter((ws) => {
    if (props.exclude && ws.id === props.exclude) return false;
    if (props.writableOnly && ws.can_write === false) return false;
    return true;
  }),
);

const placeholderLabel = computed(() =>
  loading.value
    ? "Lade…"
    : options.value.length === 0
      ? props.emptyLabel
      : props.placeholder,
);

function onChange(e: Event) {
  emit("update:modelValue", (e.target as HTMLSelectElement).value);
}

async function load() {
  loading.value = true;
  try {
    const res = await axios.get("/api/v1/workspaces");
    all.value = res.data.workspaces || [];
    emit("loaded", all.value);
  } catch {
    all.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);
defineExpose({ reload: load });
</script>

<style scoped>
.workspace-select {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 0.9rem;
  min-width: 200px;
}
.workspace-select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

<template>
  <div v-if="show" class="confirm-overlay" @click.self="onCancel">
    <div class="confirm-dialog" :class="{ danger: options.danger }">
      <h3>{{ options.title }}</h3>
      <p>{{ options.message }}</p>
      <div class="confirm-actions">
        <button class="btn-secondary" @click="onCancel">
          {{ options.cancelText || "Abbrechen" }}
        </button>
        <button class="btn-danger" @click="onConfirm">
          {{ options.confirmText || "Bestätigen" }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ConfirmOptions } from "../composables/useConfirm";

defineProps<{
  show: boolean;
  options: ConfirmOptions;
  onConfirm: () => void;
  onCancel: () => void;
}>();
</script>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.confirm-dialog {
  background: var(--color-bg);
  border-radius: 12px;
  padding: 1.5rem;
  width: 90%;
  max-width: 400px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}
.confirm-dialog h3 {
  margin-bottom: 0.5rem;
  font-size: 1.1rem;
}
.confirm-dialog p {
  color: var(--color-text-secondary);
  font-size: 0.9rem;
  margin-bottom: 1.25rem;
  line-height: 1.5;
}
.confirm-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
}
.btn-secondary {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-size: 0.9rem;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
  cursor: pointer;
}
.btn-secondary:hover {
  background: var(--color-bg-secondary);
}
.btn-danger {
  padding: 0.5rem 1rem;
  border-radius: 6px;
  font-size: 0.9rem;
  border: none;
  background: #ef4444;
  color: white;
  cursor: pointer;
  font-weight: 500;
}
.btn-danger:hover {
  opacity: 0.9;
}
</style>

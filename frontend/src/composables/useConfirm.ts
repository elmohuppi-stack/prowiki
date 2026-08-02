// Sauberes Bestätigungs-Modal statt browser-native confirm()
import { ref } from "vue";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export function useConfirm() {
  const show = ref(false);
  const options = ref<ConfirmOptions>({ title: "", message: "" });
  let resolveCallback: ((value: boolean) => void) | null = null;

  function ask(opts: ConfirmOptions): Promise<boolean> {
    options.value = {
      confirmText: "Löschen",
      cancelText: "Abbrechen",
      danger: true,
      ...opts,
    };
    show.value = true;
    return new Promise((resolve) => {
      resolveCallback = resolve;
    });
  }

  function onConfirm() {
    show.value = false;
    resolveCallback?.(true);
    resolveCallback = null;
  }

  function onCancel() {
    show.value = false;
    resolveCallback?.(false);
    resolveCallback = null;
  }

  return { show, options, ask, onConfirm, onCancel };
}

import { reactive } from "vue";

export interface Toast {
  id: number;
  text: string;
  type: "success" | "error" | "info";
}

export const toasts = reactive<Toast[]>([]);
let seq = 0;

export function toast(text: string, type: Toast["type"] = "info") {
  const id = ++seq;
  toasts.push({ id, text, type });
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, 3500);
}

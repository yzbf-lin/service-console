"use client";

import { create } from "zustand";

export type ToastKind = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  kind: ToastKind;
}

interface ToastStoreState {
  items: ToastItem[];
  notify: (title: string, description?: string, kind?: ToastKind) => void;
  dismiss: (id: number) => void;
  reset: () => void;
}

let nextToastId = 0;

function createToastId(): number {
  nextToastId += 1;
  return nextToastId;
}

/**
 * Toasts live in a Zustand store rather than React context: `notify` is called
 * from websocket handlers, mutation callbacks and effects, and a stable store
 * action avoids re-subscribing every consumer when a toast is pushed.
 */
export const useToastStore = create<ToastStoreState>()((set) => ({
  items: [],
  notify: (title, description, kind = "info") => {
    set((state) => ({
      items: [...state.items, { id: createToastId(), title, description, kind }],
    }));
  },
  dismiss: (id) => {
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
  },
  reset: () => set({ items: [] }),
}));

/** Stable selector for the imperative `notify` action. */
export function useNotify() {
  return useToastStore((state) => state.notify);
}

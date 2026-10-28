"use client";

import { create } from "zustand";

import type { ServiceFormMode } from "@/components/service-form-dialog";
import type { NormalizedProcessCandidate, NormalizedService, ViewId } from "@/lib/types";

interface ConsoleUiState {
  activeView: ViewId;
  refreshing: boolean;
  portRefreshSignal: number;
  jenkinsRefreshSignal: number;
  logRefreshSignal: number;

  formOpen: boolean;
  formMode: ServiceFormMode;
  formSource: NormalizedService | null;
  formProcessSource: NormalizedProcessCandidate | null;
  formSubmitting: boolean;

  deleteTarget: NormalizedService | null;
  groupDialogOpen: boolean;
  groupName: string;
  groupError: string;
  groupSubmitting: boolean;
  deleteGroupTarget: string | null;

  setActiveView: (view: ViewId) => void;
  setRefreshing: (refreshing: boolean) => void;
  bumpRefreshSignal: (view: "ports" | "jenkins" | "logs") => void;

  openForm: (mode: ServiceFormMode, service?: NormalizedService | null, process?: NormalizedProcessCandidate | null) => void;
  closeForm: () => void;
  setFormSubmitting: (submitting: boolean) => void;

  setDeleteTarget: (service: NormalizedService | null) => void;
  openGroupDialog: () => void;
  closeGroupDialog: () => void;
  setGroupName: (name: string) => void;
  setGroupError: (error: string) => void;
  setGroupSubmitting: (submitting: boolean) => void;
  setDeleteGroupTarget: (group: string | null) => void;
}

const initialUiState = {
  activeView: "services" as ViewId,
  refreshing: false,
  portRefreshSignal: 0,
  jenkinsRefreshSignal: 0,
  logRefreshSignal: 0,
  formOpen: false,
  formMode: "create" as ServiceFormMode,
  formSource: null,
  formProcessSource: null,
  formSubmitting: false,
  deleteTarget: null,
  groupDialogOpen: false,
  groupName: "",
  groupError: "",
  groupSubmitting: false,
  deleteGroupTarget: null,
};

/**
 * Shell-level UI state (view routing, dialogs, refresh signals) in one store so
 * the console tree does not thread a dozen `useState` setters through props and
 * so refresh signals survive view switches.
 */
export const useConsoleUiStore = create<ConsoleUiState>()((set) => ({
  ...initialUiState,

  setActiveView: (activeView) => set({ activeView }),
  setRefreshing: (refreshing) => set({ refreshing }),
  bumpRefreshSignal: (view) => set((state) => ({
    portRefreshSignal: view === "ports" ? state.portRefreshSignal + 1 : state.portRefreshSignal,
    jenkinsRefreshSignal: view === "jenkins" ? state.jenkinsRefreshSignal + 1 : state.jenkinsRefreshSignal,
    logRefreshSignal: view === "logs" ? state.logRefreshSignal + 1 : state.logRefreshSignal,
  })),

  openForm: (mode, service = null, process = null) => set({
    formOpen: true,
    formMode: mode,
    formSource: service,
    formProcessSource: process,
    formSubmitting: false,
  }),
  closeForm: () => set({ formOpen: false, formSubmitting: false }),
  setFormSubmitting: (formSubmitting) => set({ formSubmitting }),

  setDeleteTarget: (deleteTarget) => set({ deleteTarget }),
  openGroupDialog: () => set({ groupDialogOpen: true, groupName: "", groupError: "" }),
  closeGroupDialog: () => set({ groupDialogOpen: false }),
  setGroupName: (groupName) => set({ groupName }),
  setGroupError: (groupError) => set({ groupError }),
  setGroupSubmitting: (groupSubmitting) => set({ groupSubmitting }),
  setDeleteGroupTarget: (deleteGroupTarget) => set({ deleteGroupTarget }),
}));

/** Test-only escape hatch: restores the initial shell state. */
export function resetConsoleUiStore(): void {
  useConsoleUiStore.setState(initialUiState);
}

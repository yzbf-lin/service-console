"use client";

import type { ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";

import type { ViewId } from "@/lib/types";

function WorkspaceFrame({ children, view }: { children: ReactNode; view: ViewId }) {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      className="workspace-view-frame"
      data-workspace-view={view}
      aria-hidden={!present || undefined}
      inert={!present || undefined}
      initial={reducedMotion ? false : { opacity: 0, x: 22, y: 5, scale: 0.992 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      exit={reducedMotion
        ? { opacity: 0, transition: { duration: 0 } }
        : { opacity: 0, x: -12, transition: { duration: 0.14, ease: "easeOut" } }}
      transition={reducedMotion
        ? { duration: 0 }
        : { type: "spring", stiffness: 340, damping: 32, mass: 0.8, opacity: { duration: 0.22 } }}
      style={{ zIndex: present ? 1 : 0, pointerEvents: present ? "auto" : "none" }}
    >
      {children}
    </motion.div>
  );
}

export function WorkspaceTransition({ view, children }: { view: ViewId; children: ReactNode }) {
  return (
    <div className="service-console-stage">
      {/* The view frame stays still. Only view changes animate, never log/metric updates. */}
      <AnimatePresence initial={false}>
        <WorkspaceFrame key={view} view={view}>{children}</WorkspaceFrame>
      </AnimatePresence>
    </div>
  );
}

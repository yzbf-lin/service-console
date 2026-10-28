"use client";

import * as React from "react";
import {
  Group,
  Panel,
  Separator,
  type GroupProps,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels";

import { cn } from "../../lib/cn";

/**
 * Nova resizable primitives over `react-resizable-panels` v4.
 *
 * Two library details shape these wrappers:
 * - `Panel` children must be direct DOM children of `Group`.
 * - `Panel` applies `className` to a nested div that defaults to
 *   `overflow: auto`; we neutralise that so each panel's content owns its own
 *   scrolling, exactly like the surrounding app panels do.
 */
function ResizableGroup({ className, ...props }: GroupProps) {
  return <Group className={cn("min-h-0 min-w-0", className)} {...props} />;
}
ResizableGroup.displayName = "ResizableGroup";

function ResizablePanel({ className, ...props }: PanelProps) {
  return (
    <Panel
      className={cn("flex min-h-0 min-w-0 flex-col overflow-hidden", className)}
      {...props}
    />
  );
}
ResizablePanel.displayName = "ResizablePanel";

type ResizableHandleProps = SeparatorProps & {
  /** Render the Nova grab bar inside the hairline rail. */
  withHandle?: boolean;
};

/**
 * A 1px Nova rail. The library expands the pointer hit area to 10px (fine
 * pointers) / 20px (coarse), so the rail stays visually hairline-thin while
 * remaining easy to grab. State is exposed as `data-separator`, and
 * `aria-orientation` describes the separator's own direction.
 */
function ResizableHandle({ className, withHandle = true, children, ...props }: ResizableHandleProps) {
  return (
    <Separator
      className={cn(
        "group relative flex shrink-0 items-center justify-center bg-border outline-none transition-colors",
        "data-[separator=hover]:bg-foreground/25 data-[separator=active]:bg-primary",
        "focus-visible:ring-3 focus-visible:ring-ring/50",
        "aria-[orientation=vertical]:w-px aria-[orientation=vertical]:cursor-col-resize",
        "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:cursor-row-resize",
        className,
      )}
      {...props}
    >
      {children}
      {withHandle ? (
        <span
          aria-hidden="true"
          className={cn(
            "z-10 rounded-lg bg-border transition-colors",
            "group-data-[separator=hover]:bg-foreground/25 group-data-[separator=active]:bg-primary",
            "group-aria-[orientation=vertical]:h-6 group-aria-[orientation=vertical]:w-1",
            "group-aria-[orientation=horizontal]:h-1 group-aria-[orientation=horizontal]:w-6",
          )}
        />
      ) : null}
    </Separator>
  );
}
ResizableHandle.displayName = "ResizableHandle";

export { ResizableGroup, ResizableHandle, ResizablePanel };
export type { ResizableHandleProps };

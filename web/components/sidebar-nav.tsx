"use client";

import { Network, ServerCog, Settings, Workflow } from "lucide-react";
import { motion } from "motion/react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { ViewId } from "@/lib/types";

interface SidebarNavProps {
  activeView: ViewId;
  updateAvailable?: boolean;
  onViewChange: (view: ViewId) => void;
}

interface NavigationItem {
  id: ViewId;
  label: string;
  icon: typeof ServerCog;
}

const primaryItems: NavigationItem[] = [
  { id: "services", label: "服务控制", icon: ServerCog },
  { id: "ports", label: "端口进程", icon: Network },
  { id: "jenkins", label: "Jenkins", icon: Workflow },
];

const secondaryItems: NavigationItem[] = [
  { id: "settings", label: "设置", icon: Settings },
];

function NavigationButton({
  activeView,
  id,
  label,
  icon: Icon,
  showUpdateIndicator = false,
  onViewChange,
}: SidebarNavProps & NavigationItem & {
  showUpdateIndicator?: boolean;
}) {
  const active = activeView === id;
  const accessibleLabel = `${label}${showUpdateIndicator ? "，有可用更新" : ""}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          className={cn(
            "group relative flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none",
            "hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/80",
            "max-[767px]:h-full max-[767px]:w-auto max-[767px]:min-h-0 max-[767px]:min-w-0 max-[767px]:flex-1 max-[767px]:basis-0 max-[767px]:flex-col max-[767px]:gap-1 max-[767px]:rounded-lg max-[767px]:px-1 max-[767px]:py-1.5 max-[767px]:text-[10px]",
            active && "text-primary-foreground hover:bg-transparent hover:text-primary-foreground",
          )}
          type="button"
          data-view={id}
          aria-controls={`${id}View`}
          aria-current={active ? "page" : undefined}
          aria-label={accessibleLabel}
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.96 }}
          transition={{ type: "spring", stiffness: 520, damping: 34 }}
          onClick={() => onViewChange(id)}
        >
          {active ? (
            <motion.span
              className="absolute inset-0 rounded-md bg-primary shadow-[0_6px_18px_color-mix(in_srgb,var(--primary)_24%,transparent)] max-[767px]:rounded-lg"
              layoutId="active-navigation-surface"
              transition={{ type: "spring", stiffness: 480, damping: 38 }}
              aria-hidden="true"
            />
          ) : null}
          <Icon className="relative z-[1] size-[18px] shrink-0" strokeWidth={1.8} aria-hidden="true" />
          <span className="relative z-[1] hidden leading-none max-[767px]:block">{label}</span>
          {showUpdateIndicator ? (
            <span
              className="absolute top-1 right-1 size-1.5 rounded-full bg-destructive shadow-[0_0_0_2px_var(--sidebar)] max-[767px]:shadow-[0_0_0_2px_var(--card)]"
              data-update-indicator
              aria-hidden="true"
            />
          ) : null}
        </motion.button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="hidden min-[768px]:block">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function SidebarNav({ activeView, updateAvailable = false, onViewChange }: SidebarNavProps) {
  return (
    <TooltipProvider delayDuration={250} skipDelayDuration={100}>
      <aside
        className={cn(
          "flex min-h-0 flex-col border-r bg-[var(--sidebar)]",
          "max-[767px]:fixed max-[767px]:inset-x-2 max-[767px]:bottom-[max(8px,env(safe-area-inset-bottom))] max-[767px]:z-50",
          "max-[767px]:h-[58px] max-[767px]:flex-row max-[767px]:rounded-xl max-[767px]:border max-[767px]:bg-card/95 max-[767px]:p-1 max-[767px]:shadow-[var(--shadow-menu)] max-[767px]:backdrop-blur-xl",
        )}
        aria-label="主功能"
        data-rail="icon-only"
      >
        <nav className="flex min-h-0 flex-1 flex-col max-[767px]:flex-row" aria-label="功能导航">
          <div
            className="flex shrink-0 flex-col items-center gap-1 p-1.5 max-[767px]:min-w-0 max-[767px]:flex-[3] max-[767px]:flex-row max-[767px]:gap-0 max-[767px]:p-0"
            data-nav-section="primary"
          >
            {primaryItems.map((item) => (
              <NavigationButton key={item.id} {...item} activeView={activeView} onViewChange={onViewChange} />
            ))}
          </div>

          <div
            className="mt-auto flex shrink-0 flex-col items-center gap-1 border-t p-1.5 max-[767px]:mt-0 max-[767px]:min-w-0 max-[767px]:flex-1 max-[767px]:flex-row max-[767px]:gap-0 max-[767px]:border-t-0 max-[767px]:p-0"
            data-nav-section="secondary"
          >
            {secondaryItems.map((item) => (
              <NavigationButton
                key={item.id}
                {...item}
                activeView={activeView}
                showUpdateIndicator={item.id === "settings" && updateAvailable}
                onViewChange={onViewChange}
              />
            ))}
          </div>
        </nav>
      </aside>
    </TooltipProvider>
  );
}

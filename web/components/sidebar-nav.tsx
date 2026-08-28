"use client";

import { Network, ServerCog, Settings } from "lucide-react";

import { cn } from "@/lib/cn";
import type { ViewId } from "@/lib/types";

interface SidebarNavProps {
  activeView: ViewId;
  onViewChange: (view: ViewId) => void;
}

interface NavigationItem {
  id: ViewId;
  label: string;
  icon: typeof ServerCog;
}

const primaryItems: NavigationItem[] = [
  { id: "services" as const, label: "服务控制", icon: ServerCog },
  { id: "ports" as const, label: "端口进程", icon: Network },
];

const secondaryItems: NavigationItem[] = [
  { id: "settings" as const, label: "设置", icon: Settings },
];

function NavigationButton({
  activeView,
  id,
  label,
  icon: Icon,
  onViewChange,
}: SidebarNavProps & NavigationItem) {
  const active = activeView === id;
  return (
    <button
      className={cn(
        "group relative flex min-h-14 w-full flex-col items-center justify-center gap-1 rounded-lg px-2 py-2 text-[11px] font-semibold text-muted-foreground outline-none transition-colors",
        "hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
        "max-[767px]:h-full max-[767px]:min-h-0 max-[767px]:min-w-0 max-[767px]:flex-1 max-[767px]:basis-0 max-[767px]:px-1 max-[767px]:py-1.5",
        active && "bg-accent text-accent-foreground shadow-sm",
      )}
      type="button"
      data-view={id}
      aria-controls={`${id}View`}
      aria-current={active ? "page" : undefined}
      title={label}
      onClick={() => onViewChange(id)}
    >
      <span
        className={cn(
          "absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-transparent",
          "max-[767px]:inset-x-3 max-[767px]:top-auto max-[767px]:bottom-0 max-[767px]:h-0.5 max-[767px]:w-auto max-[767px]:rounded-t-full max-[767px]:rounded-r-none",
          active && "bg-primary",
        )}
        aria-hidden="true"
      />
      <Icon className="size-[18px] shrink-0" strokeWidth={1.8} aria-hidden="true" />
      <span className="leading-none min-[768px]:max-[1023px]:sr-only">{label}</span>
    </button>
  );
}

export function SidebarNav({ activeView, onViewChange }: SidebarNavProps) {
  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col border-r bg-card/80 p-2 backdrop-blur-xl",
        "max-[767px]:fixed max-[767px]:inset-x-2 max-[767px]:bottom-[max(8px,env(safe-area-inset-bottom))] max-[767px]:z-50",
        "max-[767px]:h-[60px] max-[767px]:flex-row max-[767px]:rounded-xl max-[767px]:border max-[767px]:p-1 max-[767px]:shadow-2xl",
      )}
      aria-label="主功能"
    >
      <nav
        className="flex min-h-0 flex-1 flex-col gap-1 max-[767px]:flex-row"
        aria-label="功能导航"
      >
        <div
          className="flex flex-col gap-1 max-[767px]:min-w-0 max-[767px]:flex-[2] max-[767px]:flex-row"
          data-nav-section="primary"
        >
          {primaryItems.map((item) => (
            <NavigationButton
              key={item.id}
              {...item}
              activeView={activeView}
              onViewChange={onViewChange}
            />
          ))}
        </div>
        <div
          className="mt-auto flex flex-col gap-1 max-[767px]:mt-0 max-[767px]:min-w-0 max-[767px]:flex-1 max-[767px]:flex-row"
          data-nav-section="secondary"
        >
          {secondaryItems.map((item) => (
            <NavigationButton
              key={item.id}
              {...item}
              activeView={activeView}
              onViewChange={onViewChange}
            />
          ))}
        </div>
      </nav>
    </aside>
  );
}

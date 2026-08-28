"use client";

import type { ReactNode } from "react";
import { Network, ServerCog, Settings } from "lucide-react";

import { cn } from "@/lib/cn";
import type { ViewId } from "@/lib/types";

interface SidebarNavProps {
  activeView: ViewId;
  children?: ReactNode;
  updateAvailable?: boolean;
  onViewChange: (view: ViewId) => void;
}

interface NavigationItem {
  id: ViewId;
  label: string;
  description: string;
  icon: typeof ServerCog;
}

const primaryItems: NavigationItem[] = [
  { id: "services", label: "服务控制", description: "进程与实时日志", icon: ServerCog },
  { id: "ports", label: "端口进程", description: "监听端口与占用", icon: Network },
];

const secondaryItems: NavigationItem[] = [
  { id: "settings", label: "设置", description: "外观、更新与连接偏好", icon: Settings },
];

function NavigationButton({
  activeView,
  id,
  label,
  description,
  icon: Icon,
  showUpdateIndicator = false,
  onViewChange,
}: Omit<SidebarNavProps, "children" | "updateAvailable"> & NavigationItem & {
  showUpdateIndicator?: boolean;
}) {
  const active = activeView === id;
  return (
    <button
      className={cn(
        "group relative flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-medium text-muted-foreground outline-none transition-colors",
        "hover:bg-accent/70 hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/80",
        "max-[767px]:h-full max-[767px]:min-h-0 max-[767px]:min-w-0 max-[767px]:flex-1 max-[767px]:basis-0 max-[767px]:flex-col max-[767px]:justify-center max-[767px]:gap-1 max-[767px]:px-1 max-[767px]:py-1.5 max-[767px]:text-center max-[767px]:text-[10px]",
        active && "bg-accent text-accent-foreground",
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
      <Icon className={cn("size-4 shrink-0", active && "text-primary")} strokeWidth={1.8} aria-hidden="true" />
      <span className="min-w-0 flex-1 max-[767px]:flex-none">
        <span className="block truncate leading-none">{label}</span>
        <span className="mt-1 block truncate text-[9px] font-normal text-muted-foreground max-[767px]:hidden">{description}</span>
      </span>
      {showUpdateIndicator ? (
        <>
          <span
            className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary shadow-[0_0_0_2px_var(--sidebar)] max-[767px]:shadow-[0_0_0_2px_var(--card)]"
            data-update-indicator
            aria-hidden="true"
          />
          <span className="sr-only">有可用更新</span>
        </>
      ) : null}
    </button>
  );
}

export function SidebarNav({
  activeView,
  children,
  updateAvailable = false,
  onViewChange,
}: SidebarNavProps) {
  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col border-r bg-[var(--sidebar)]",
        "max-[767px]:fixed max-[767px]:inset-x-2 max-[767px]:bottom-[max(8px,env(safe-area-inset-bottom))] max-[767px]:z-50",
        "max-[767px]:h-[58px] max-[767px]:flex-row max-[767px]:rounded-xl max-[767px]:border max-[767px]:bg-card/95 max-[767px]:p-1 max-[767px]:shadow-[var(--shadow-menu)] max-[767px]:backdrop-blur-xl",
      )}
      aria-label="主功能"
    >
      <nav className="flex min-h-0 flex-1 flex-col max-[767px]:flex-row" aria-label="功能导航">
        <div className="shrink-0 space-y-1 p-2 max-[767px]:flex max-[767px]:min-w-0 max-[767px]:flex-[2] max-[767px]:space-y-0 max-[767px]:p-0" data-nav-section="primary">
          <p className="mb-1 px-2 text-[10px] font-medium text-muted-foreground max-[767px]:hidden">工作区</p>
          {primaryItems.map((item) => (
            <NavigationButton key={item.id} {...item} activeView={activeView} onViewChange={onViewChange} />
          ))}
        </div>

        {children ? (
          <div className="flex min-h-0 flex-1 flex-col border-t max-[767px]:hidden" data-nav-content="services">
            {children}
          </div>
        ) : null}

        <div
          className="mt-auto shrink-0 border-t p-2 max-[767px]:mt-0 max-[767px]:flex max-[767px]:min-w-0 max-[767px]:flex-1 max-[767px]:border-t-0 max-[767px]:p-0"
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
  );
}

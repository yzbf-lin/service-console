"use client";

import { Toast } from "radix-ui";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";

import { cn } from "@/lib/cn";

type ToastKind = "success" | "error" | "info";

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  kind: ToastKind;
}

interface ToastContextValue {
  notify: (title: string, description?: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const notify = useCallback((title: string, description?: string, kind: ToastKind = "info") => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setItems((current) => [...current, { id, title, description, kind }]);
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      <Toast.Provider swipeDirection="right" duration={5000}>
        {children}
        {items.map((item) => {
          const Icon = item.kind === "success" ? CheckCircle2 : item.kind === "error" ? CircleAlert : Info;
          return (
            <Toast.Root
              key={item.id}
              className={cn(
                "grid w-[min(380px,calc(100vw-24px))] grid-cols-[auto_1fr_auto] items-start gap-2 rounded-lg border bg-popover p-3 text-popover-foreground shadow-2xl",
                "data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
                item.kind === "error" && "border-destructive/40",
                item.kind === "success" && "border-success/40",
              )}
              onOpenChange={(open) => {
                if (!open) setItems((current) => current.filter((candidate) => candidate.id !== item.id));
              }}
            >
              <Icon
                className={cn(
                  "mt-0.5 size-4 text-primary",
                  item.kind === "error" && "text-destructive",
                  item.kind === "success" && "text-success",
                )}
                aria-hidden="true"
              />
              <div className="min-w-0">
                <Toast.Title className="text-xs font-bold">{item.title}</Toast.Title>
                {item.description ? (
                  <Toast.Description className="mt-0.5 break-words text-[11px] text-muted-foreground">
                    {item.description}
                  </Toast.Description>
                ) : null}
              </div>
              <Toast.Close
                className="rounded p-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="关闭通知"
              >
                <X className="size-3.5" />
              </Toast.Close>
            </Toast.Root>
          );
        })}
        <Toast.Viewport className="fixed top-3 right-3 z-[100] flex max-h-screen w-[min(380px,calc(100vw-24px))] flex-col gap-2 outline-none" />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}

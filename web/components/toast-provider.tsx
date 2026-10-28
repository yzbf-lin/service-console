"use client";

import { Toast } from "radix-ui";
import { type ReactNode } from "react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { cn } from "@/lib/cn";
import { useToastStore, type ToastItem } from "@/stores/toast-store";

const TOAST_ICONS = {
  success: CheckCircle2,
  error: CircleAlert,
  info: Info,
} as const;

/**
 * Nova toast surface. The Radix primitive owns swipe/escape handling and
 * accessibility, while Motion owns enter/exit so toasts animate consistently
 * with the rest of the shell (`MotionConfig reducedMotion="user"` upstream).
 */
function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const Icon = TOAST_ICONS[item.kind];

  return (
    <Toast.Root
      asChild
      duration={5000}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <motion.li
        layout="position"
        initial={{ opacity: 0, x: 24, scale: 0.98 }}
        animate={{ opacity: 1, x: 0, scale: 1 }}
        exit={{ opacity: 0, x: 24, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 460, damping: 34, mass: 0.6 }}
        className={cn(
          "grid w-[min(380px,calc(100vw-24px))] grid-cols-[auto_1fr_auto] items-start gap-2",
          "rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg shadow-black/10",
          item.kind === "error" && "border-destructive/40",
          item.kind === "success" && "border-success/40",
        )}
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
      </motion.li>
    </Toast.Root>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const items = useToastStore((state) => state.items);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <Toast.Provider swipeDirection="right">
      {children}
      <Toast.Viewport asChild>
        <ol className="fixed top-3 right-3 z-[100] flex max-h-screen w-[min(380px,calc(100vw-24px))] list-none flex-col gap-2 outline-none">
          <AnimatePresence initial={false}>
            {items.map((item) => (
              <ToastCard key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
            ))}
          </AnimatePresence>
        </ol>
      </Toast.Viewport>
    </Toast.Provider>
  );
}

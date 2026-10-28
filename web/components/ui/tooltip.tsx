import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { motion } from "motion/react";

import { cn } from "../../lib/cn";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content ref={ref} sideOffset={sideOffset} asChild {...props}>
      <motion.div
        data-slot="tooltip-content"
        className={cn(
          "z-50 inline-flex max-w-xs items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground",
          className,
        )}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.1, ease: "easeOut" }}
      >
        {children}
      </motion.div>
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };

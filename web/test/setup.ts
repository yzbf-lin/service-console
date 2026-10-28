import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import { resetConsoleUiStore } from "@/stores/console-ui-store";
import { resetServiceStore } from "@/stores/service-store";
import { useToastStore } from "@/stores/toast-store";

afterEach(() => {
  cleanup();
  useToastStore.getState().reset();
  resetServiceStore();
  resetConsoleUiStore();
});

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}

// jsdom does not implement hit testing, which dnd-kit drag targets rely on.
if (!document.elementFromPoint) {
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    writable: true,
    value: () => null,
  });
}

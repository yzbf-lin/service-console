import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { XtermLogViewer } from "@/components/xterm-log-viewer";

const xtermMocks = vi.hoisted(() => ({
  clearDecorations: vi.fn(),
  dispose: vi.fn(),
  findNext: vi.fn(() => true),
  findPrevious: vi.fn(() => true),
  reset: vi.fn(),
  selection: "",
  selectionDispose: vi.fn(),
  selectionListener: null as null | (() => void),
  write: vi.fn((_value: string, callback?: () => void) => callback?.()),
}));

vi.mock("@/hooks/use-auto-scroll-preference", () => ({
  useAutoScrollPreference: () => [true, vi.fn()] as const,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    options: Record<string, unknown> = {};
    rows = 24;

    clearSelection() {}
    dispose() { xtermMocks.dispose(); }
    getSelection() { return xtermMocks.selection; }
    hasSelection() { return Boolean(xtermMocks.selection); }
    loadAddon() {}
    onSelectionChange(listener: () => void) {
      xtermMocks.selectionListener = listener;
      return { dispose: xtermMocks.selectionDispose };
    }
    open() {}
    refresh() {}
    reset() { xtermMocks.reset(); }
    scrollToBottom() {}
    write(value: string, callback?: () => void) { xtermMocks.write(value, callback); }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class MockSearchAddon {
    clearDecorations = xtermMocks.clearDecorations;
    findNext = xtermMocks.findNext;
    findPrevious = xtermMocks.findPrevious;
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}));

type ViewerProps = ComponentProps<typeof XtermLogViewer>;

function renderViewer(overrides: Partial<ViewerProps> = {}) {
  let props: ViewerProps = {
    active: true,
    appendRevision: 0,
    appendText: "",
    ariaLabel: "Jenkins 构建 #42 日志",
    onCopyError: vi.fn(),
    onCopySuccess: vi.fn(),
    resetKey: "jenkins:job:42",
    text: "first line\r\nsecond line\r\n",
    theme: "dark",
    ...overrides,
  };
  const result = render(<XtermLogViewer {...props} />);
  return {
    ...result,
    get props() { return props; },
    rerenderViewer(next: Partial<ViewerProps>) {
      props = { ...props, ...next };
      result.rerender(<XtermLogViewer {...props} />);
    },
  };
}

async function waitForTerminal() {
  const searchButton = screen.getByRole("button", { name: "搜索 Jenkins 日志" }) as HTMLButtonElement;
  await waitFor(() => expect(searchButton.disabled).toBe(false));
}

describe("XtermLogViewer", () => {
  const writeText = vi.fn<(text: string) => Promise<void>>();

  beforeEach(() => {
    xtermMocks.clearDecorations.mockReset();
    xtermMocks.dispose.mockReset();
    xtermMocks.findNext.mockReset().mockReturnValue(true);
    xtermMocks.findPrevious.mockReset().mockReturnValue(true);
    xtermMocks.reset.mockReset();
    xtermMocks.selection = "";
    xtermMocks.selectionDispose.mockReset();
    xtermMocks.selectionListener = null;
    xtermMocks.write.mockClear();
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("opens search with Cmd/Ctrl+F and supports incremental navigation and close", async () => {
    renderViewer();
    await waitForTerminal();

    const terminalHelper = document.createElement("textarea");
    screen.getByRole("log", { name: "Jenkins 构建 #42 日志" }).append(terminalHelper);
    expect(fireEvent.keyDown(terminalHelper, { ctrlKey: true, key: "f" })).toBe(false);
    const input = await screen.findByRole("textbox", { name: "搜索 Jenkins 日志" });
    fireEvent.change(input, { target: { value: "error" } });

    expect(xtermMocks.findNext).toHaveBeenCalledWith("error", { caseSensitive: false });
    fireEvent.click(screen.getByRole("button", { name: "上一个匹配" }));
    expect(xtermMocks.findPrevious).toHaveBeenCalledWith("error", { caseSensitive: false });
    fireEvent.click(screen.getByRole("button", { name: "下一个匹配" }));
    expect(xtermMocks.findNext).toHaveBeenLastCalledWith("error", { caseSensitive: false });

    fireEvent.click(screen.getByRole("button", { name: "关闭日志搜索" }));
    expect(xtermMocks.clearDecorations).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox", { name: "搜索 Jenkins 日志" })).toBeNull();
  });

  it("copies xterm selection by button and always leaves Cmd/Ctrl+C to xterm or the browser", async () => {
    renderViewer();
    await waitForTerminal();
    const terminalHost = screen.getByRole("log", { name: "Jenkins 构建 #42 日志" });

    expect(fireEvent.keyDown(terminalHost, { key: "c", metaKey: true })).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    xtermMocks.selection = "selected output";
    act(() => xtermMocks.selectionListener?.());
    const selectionButton = screen.getByRole("button", { name: "复制选中的 Jenkins 日志" }) as HTMLButtonElement;
    expect(selectionButton.disabled).toBe(false);

    expect(fireEvent.keyDown(terminalHost, { key: "c", ctrlKey: true })).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(selectionButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("selected output"));
    expect(screen.getByRole("status").textContent).toBe("已复制选中内容");
  });

  it("copies complete plain text and reports clipboard rejection", async () => {
    const onCopyError = vi.fn();
    const onCopySuccess = vi.fn();
    renderViewer({
      onCopyError,
      onCopySuccess,
      text: "plain \u001b[31mred\u001b[0m\u001b]52;c;hidden\u0007\r\n",
    });
    await waitForTerminal();
    const copyAllButton = screen.getByRole("button", { name: "复制全部 Jenkins 日志" });

    fireEvent.click(copyAllButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("plain red\r\n"));
    expect(onCopySuccess).toHaveBeenCalledWith("已复制全部日志");
    expect(screen.getByRole("status").textContent).toBe("已复制全部日志");

    writeText.mockRejectedValueOnce(new Error("clipboard permission denied"));
    fireEvent.click(copyAllButton);
    await waitFor(() => expect(onCopyError).toHaveBeenCalledWith("clipboard permission denied"));
    expect(screen.getByRole("status").textContent).toContain("复制失败：clipboard permission denied");
  });

  it("reports when the Clipboard API is unavailable", async () => {
    const onCopyError = vi.fn();
    renderViewer({ onCopyError });
    await waitForTerminal();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });

    fireEvent.click(screen.getByRole("button", { name: "复制全部 Jenkins 日志" }));
    await waitFor(() => expect(onCopyError).toHaveBeenCalledWith("当前系统未提供剪贴板写入能力"));
    expect(screen.getByRole("status").textContent).toContain("复制失败：当前系统未提供剪贴板写入能力");
  });

  it("appends consecutive sliding-window chunks without resetting search or selection", async () => {
    const initialText = `header\n${"x".repeat(5_000)}`;
    const chunkOne = "\nchunk one";
    const nextText = `[truncated]\n${initialText.slice(-4_096)}${chunkOne}`;
    const chunkTwo = "\nchunk two";
    const finalText = `[truncated]\n${nextText.slice(-4_096)}${chunkTwo}`;
    const view = renderViewer({ appendRevision: 0, appendText: "", text: initialText });
    await waitForTerminal();
    await waitFor(() => expect(xtermMocks.write).toHaveBeenCalledWith(initialText, expect.any(Function)));
    expect(xtermMocks.reset).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "搜索 Jenkins 日志" }));
    xtermMocks.selection = "selected output";
    act(() => xtermMocks.selectionListener?.());

    view.rerenderViewer({ appendRevision: 1, appendText: chunkOne, text: nextText });
    await waitFor(() => expect(xtermMocks.write).toHaveBeenCalledWith(chunkOne, expect.any(Function)));
    view.rerenderViewer({ appendRevision: 2, appendText: chunkTwo, text: finalText });
    await waitFor(() => expect(xtermMocks.write).toHaveBeenCalledWith(chunkTwo, expect.any(Function)));

    expect(xtermMocks.reset).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "搜索 Jenkins 日志" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "复制选中的 Jenkins 日志" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disposes xterm and its selection listener on unmount", async () => {
    const view = renderViewer();
    await waitForTerminal();
    view.unmount();
    expect(xtermMocks.selectionDispose).toHaveBeenCalledOnce();
    expect(xtermMocks.dispose).toHaveBeenCalledOnce();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SettingsView } from "@/components/settings-view";
import type { AppUpdateStatus } from "@/lib/types";

function updateStatus(
  state: AppUpdateStatus["state"],
  overrides: Partial<AppUpdateStatus> = {},
): AppUpdateStatus {
  return {
    state,
    current_version: "0.1.0",
    latest_version: "0.2.0",
    release_url: "https://github.com/yzbf-lin/service-console/releases/tag/v0.2.0",
    published_at: null,
    notes: "支持安全自动更新。",
    platform: "darwin-arm64",
    platform_supported: true,
    can_install: true,
    reason: null,
    error: null,
    downloaded_bytes: 0,
    total_bytes: 1_000,
    download_progress: 0,
    downloaded: state === "downloaded" || state === "restarting",
    restart_required: false,
    ...overrides,
  };
}

function renderSettings(status: AppUpdateStatus, handlers = {
  onCheckForUpdates: vi.fn(),
  onDownloadUpdate: vi.fn(),
  onInstallUpdate: vi.fn(),
}) {
  render(
    <SettingsView
      preference="system"
      resolvedTheme="light"
      updateStatus={status}
      updateOperation={null}
      mcpStatus={null}
      mcpOperation={null}
      onPreferenceChange={vi.fn()}
      onInstallMcp={vi.fn()}
      onRefreshMcp={vi.fn()}
      onTestMcp={vi.fn()}
      onCopyMcpConfig={vi.fn()}
      onRemoveMcp={vi.fn()}
      {...handlers}
    />,
  );
  return handlers;
}

describe("SettingsView app updates", () => {
  it("offers the signed release download when automatic installation is unavailable", () => {
    renderSettings(updateStatus("unsupported", {
      platform_supported: false,
      can_install: false,
      reason: "当前平台需要手动下载安装包。",
    }));

    expect(screen.getByText("需要手动更新")).toBeTruthy();
    expect(screen.getByText("v0.1.0")).toBeTruthy();
    expect(screen.getByText("v0.2.0")).toBeTruthy();
    const releaseLink = screen.getByRole("link", { name: /打开 Release 下载页/ });
    expect(releaseLink.getAttribute("href")).toBe(
      "https://github.com/yzbf-lin/service-console/releases/tag/v0.2.0",
    );
  });

  it("keeps release notes available when automatic installation is supported", () => {
    renderSettings(updateStatus("available"));

    const releaseLink = screen.getByRole("link", { name: /查看发布说明/ });
    expect(releaseLink.getAttribute("href")).toBe(
      "https://github.com/yzbf-lin/service-console/releases/tag/v0.2.0",
    );
    expect(screen.getByText("发现新版本").closest("[role=status]")).toBeTruthy();
  });

  it("shows download progress from byte counts", () => {
    renderSettings(updateStatus("downloading", {
      downloaded_bytes: 250,
      total_bytes: 1_000,
      download_progress: 0.25,
    }));

    const progress = screen.getByRole("progressbar", { name: "更新下载进度" });
    expect(progress.getAttribute("aria-valuenow")).toBe("25");
    expect(progress.getAttribute("aria-valuetext")).toContain("25%");
    expect(progress.parentElement?.getAttribute("aria-live")).toBeNull();
    expect(screen.getByText(/25%/)).toBeTruthy();
  });

  it("treats a backend transition as busy even without a local operation", () => {
    renderSettings(updateStatus("downloading", {
      downloaded_bytes: 250,
      download_progress: 25,
    }));

    expect(screen.getByRole("button", { name: "检查更新" }).hasAttribute("disabled")).toBe(true);
  });

  it("offers a direct download retry after a failed download", () => {
    const handlers = renderSettings(updateStatus("error", {
      error: "下载连接已中断",
      downloaded: false,
    }));

    fireEvent.click(screen.getByRole("button", { name: "重试下载" }));
    expect(handlers.onDownloadUpdate).toHaveBeenCalledOnce();
  });

  it("offers a direct install retry when the verified package is still cached", () => {
    const handlers = renderSettings(updateStatus("error", {
      error: "替换应用失败",
      downloaded: true,
    }));

    fireEvent.click(screen.getByRole("button", { name: "重试安装" }));
    fireEvent.click(screen.getByRole("button", { name: "安装并重启" }));
    expect(handlers.onInstallUpdate).toHaveBeenCalledOnce();
  });

  it("requires confirmation before installing and explains the managed-service shutdown", () => {
    const handlers = renderSettings(updateStatus("downloaded"));

    fireEvent.click(screen.getByRole("button", { name: "安装并重启" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/停止当前由它管理的服务/)).toBeTruthy();

    const confirmButtons = screen.getAllByRole("button", { name: "安装并重启" });
    fireEvent.click(confirmButtons.at(-1) as HTMLElement);
    expect(handlers.onInstallUpdate).toHaveBeenCalledOnce();
  });

  it("closes the install confirmation when another update operation starts", () => {
    const props = {
      preference: "system" as const,
      resolvedTheme: "light" as const,
      updateStatus: updateStatus("downloaded"),
      updateOperation: null,
      mcpStatus: null,
      mcpOperation: null,
      onPreferenceChange: vi.fn(),
      onCheckForUpdates: vi.fn(),
      onDownloadUpdate: vi.fn(),
      onInstallUpdate: vi.fn(),
      onInstallMcp: vi.fn(),
      onRefreshMcp: vi.fn(),
      onTestMcp: vi.fn(),
      onCopyMcpConfig: vi.fn(),
      onRemoveMcp: vi.fn(),
    };
    const { rerender } = render(<SettingsView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "安装并重启" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    rerender(
      <SettingsView
        {...props}
        updateStatus={updateStatus("checking")}
        updateOperation="checking"
      />,
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

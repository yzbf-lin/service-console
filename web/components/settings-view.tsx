"use client";

import {
  Check,
  Cloud,
  Download,
  ExternalLink,
  Monitor,
  Moon,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Sun,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { isSupabaseConfigured } from "@/lib/supabase";
import { formatBytes } from "@/lib/service-logic";
import type { AppUpdateStatus, ResolvedTheme, ThemePreference } from "@/lib/types";
import { cn } from "@/lib/cn";
import type { AppUpdateOperation } from "@/hooks/use-app-update";

interface SettingsViewProps {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  updateStatus: AppUpdateStatus | null;
  updateOperation: AppUpdateOperation | null;
  onPreferenceChange: (preference: ThemePreference) => void;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
}

const themes = [
  { value: "system" as const, label: "跟随系统", description: "随 macOS 外观自动切换", icon: Monitor },
  { value: "light" as const, label: "浅色", description: "始终使用明亮界面", icon: Sun },
  { value: "dark" as const, label: "深色", description: "始终使用低亮度界面", icon: Moon },
];

const updateLabels = {
  idle: "尚未检查",
  checking: "正在检查",
  up_to_date: "已是最新版",
  available: "发现新版本",
  unsupported: "需要手动更新",
  downloading: "正在下载",
  downloaded: "等待安装",
  installing: "正在安装",
  restarting: "即将重启",
  error: "更新失败",
} as const;

function releasePageUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function updateProgress(status: AppUpdateStatus | null): number {
  if (!status) return 0;
  if (status.total_bytes && status.total_bytes > 0) {
    return Math.min(100, Math.max(0, status.downloaded_bytes / status.total_bytes * 100));
  }
  const raw = status.download_progress ?? 0;
  return Math.min(100, Math.max(0, raw <= 1 ? raw * 100 : raw));
}

export function SettingsView({
  preference,
  resolvedTheme,
  updateStatus,
  updateOperation,
  onPreferenceChange,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdate,
}: SettingsViewProps) {
  const cloudConfigured = isSupabaseConfigured();
  const updateState = updateStatus?.state ?? "idle";
  const releaseUrl = releasePageUrl(updateStatus?.release_url);
  const progress = updateProgress(updateStatus);
  const hasNewVersion = Boolean(
    updateStatus?.latest_version
      && updateStatus.latest_version !== updateStatus.current_version,
  );
  const updateAvailable = [
    "available",
    "unsupported",
    "downloading",
    "downloaded",
    "installing",
    "restarting",
  ].includes(updateState) || (updateState === "error" && hasNewVersion);
  const showProgress = updateState === "downloading" || updateOperation === "downloading";
  const backendBusy = ["checking", "downloading", "installing", "restarting"].includes(updateState);
  const operationBusy = updateOperation !== null || backendBusy;
  const installReady = updateState === "downloaded"
    || (updateState === "error" && Boolean(updateStatus?.downloaded));
  const canDownload = Boolean(
    updateStatus?.can_install
      && (
        updateState === "available"
        || (
          updateState === "error"
          && hasNewVersion
          && updateStatus.platform_supported
          && !updateStatus.downloaded
        )
      ),
  );
  const canInstall = Boolean(updateStatus?.can_install && installReady);
  const badgeVariant = updateState === "error"
    ? "destructive"
    : updateAvailable
      ? "warning"
      : updateState === "up_to_date"
        ? "success"
        : "secondary";

  return (
    <main id="settingsView" className="no-visible-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto bg-background" aria-labelledby="settingsHeading">
      <header className="flex min-h-16 items-center border-b bg-card/75 px-5">
        <div>
          <h2 id="settingsHeading" className="text-[14px] font-semibold tracking-tight">设置</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">调整本机工作台的外观、更新与可选连接。</p>
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl space-y-6 px-5 py-6 max-[620px]:px-3 max-[620px]:py-4">
        <section aria-labelledby="appearanceHeading">
          <div className="mb-2">
            <h3 id="appearanceHeading" className="text-[12px] font-semibold">外观</h3>
            <p className="mt-0.5 text-[10px] text-muted-foreground">主题偏好保存在本机，重新打开应用后仍然生效。</p>
          </div>

          <RadioGroup
            className="divide-y overflow-hidden rounded-lg border bg-card"
            value={preference}
            aria-label="主题偏好"
            onValueChange={(value) => onPreferenceChange(value as ThemePreference)}
          >
            {themes.map(({ value, label, description, icon: Icon }) => {
              const selected = preference === value;
              return (
                <label
                  key={value}
                  className={cn(
                    "relative flex min-h-14 cursor-pointer items-center gap-3 px-3 py-2 outline-none transition-colors hover:bg-accent/45 focus-within:z-[1] focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/80",
                    selected && "bg-accent/65",
                  )}
                >
                  <RadioGroupItem className="sr-only" value={value} />
                  <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground", selected && "bg-primary text-primary-foreground")}>
                    <Icon className="size-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block text-[12px] font-medium">{label}</strong>
                    <small className="mt-0.5 block text-[10px] text-muted-foreground">{description}</small>
                  </span>
                  <span className={cn("grid size-5 shrink-0 place-items-center rounded-full border text-transparent", selected && "border-primary bg-primary text-primary-foreground")}>
                    <Check className="size-3" />
                  </span>
                </label>
              );
            })}
          </RadioGroup>
          <p className="mt-2 text-[10px] text-muted-foreground" aria-live="polite">
            当前实际使用：{resolvedTheme === "dark" ? "深色主题" : "浅色主题"}
          </p>
        </section>

        <section aria-labelledby="updateHeading">
          <div className="mb-2">
            <h3 id="updateHeading" className="text-[12px] font-semibold">应用更新</h3>
            <p className="mt-0.5 text-[10px] text-muted-foreground">启动后自动发现 GitHub Releases 中的新版本，安装前校验发布清单签名与更新包完整性。</p>
          </div>

          <div className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-start gap-3 px-3 py-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground">
                <PackageCheck className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-[12px] font-medium">Service Console</strong>
                  <Badge
                    className="rounded-md px-1.5 py-0.5 text-[9px]"
                    role="status"
                    aria-live="polite"
                    aria-atomic="true"
                    variant={badgeVariant}
                  >
                    {updateLabels[updateState]}
                  </Badge>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 rounded-md bg-secondary/55 p-2.5 text-[10px] max-[460px]:grid-cols-1">
                  <p>
                    <span className="block text-muted-foreground">当前版本</span>
                    <strong className="mt-0.5 block font-mono font-medium">v{updateStatus?.current_version || "—"}</strong>
                  </p>
                  <p>
                    <span className="block text-muted-foreground">最新版本</span>
                    <strong className="mt-0.5 block font-mono font-medium">{updateStatus?.latest_version ? `v${updateStatus.latest_version}` : "—"}</strong>
                  </p>
                </div>

                {showProgress ? (
                  <div className="mt-3">
                    <div className="mb-1.5 flex items-center justify-between gap-3 text-[10px]">
                      <span className="text-muted-foreground">正在下载更新包</span>
                      <span className="font-mono tabular-nums">
                        {formatBytes(updateStatus?.downloaded_bytes ?? 0)}
                        {updateStatus?.total_bytes ? ` / ${formatBytes(updateStatus.total_bytes)}` : ""}
                        {` · ${Math.round(progress)}%`}
                      </span>
                    </div>
                    <div
                      className="h-1.5 overflow-hidden rounded-full bg-secondary"
                      role="progressbar"
                      aria-label="更新下载进度"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(progress)}
                      aria-valuetext={`${Math.round(progress)}%，已下载 ${formatBytes(updateStatus?.downloaded_bytes ?? 0)}${updateStatus?.total_bytes ? `，共 ${formatBytes(updateStatus.total_bytes)}` : ""}`}
                    >
                      <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                ) : null}

                {updateStatus?.notes && updateAvailable ? (
                  <p className="mt-3 line-clamp-3 whitespace-pre-line text-[10px] leading-relaxed text-muted-foreground">{updateStatus.notes}</p>
                ) : null}

                {updateStatus?.error ? (
                  <p className="mt-3 rounded-md bg-destructive/10 px-2.5 py-2 text-[10px] leading-relaxed text-destructive" role="alert">
                    {updateStatus.error}
                  </p>
                ) : updateStatus?.reason ? (
                  <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">{updateStatus.reason}</p>
                ) : null}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={operationBusy}
                    onClick={onCheckForUpdates}
                  >
                    <RefreshCw className={cn("size-3.5", updateOperation === "checking" && "animate-spin")} aria-hidden="true" />
                    {updateOperation === "checking" ? "检查中" : "检查更新"}
                  </Button>

                  {canDownload ? (
                    <Button size="sm" disabled={operationBusy} onClick={onDownloadUpdate}>
                      <Download className="size-3.5" aria-hidden="true" />
                      {updateState === "error" ? "重试下载" : "下载更新"}
                    </Button>
                  ) : null}

                  {canInstall ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button size="sm" disabled={operationBusy}>
                          <RotateCcw className="size-3.5" aria-hidden="true" />
                          {updateState === "error" ? "重试安装" : "安装并重启"}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>安装 v{updateStatus?.latest_version || "新版本"} 并重启？</AlertDialogTitle>
                          <AlertDialogDescription>
                            安装会关闭 Service Console，并停止当前由它管理的服务。应用重新打开后，已设置为自动启动的服务会恢复运行。
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>暂不安装</AlertDialogCancel>
                          <AlertDialogAction
                            disabled={operationBusy || !installReady}
                            onClick={onInstallUpdate}
                          >
                            安装并重启
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}

                  {releaseUrl ? (
                    <Button asChild size="sm" variant="secondary">
                      <a href={releaseUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="size-3.5" aria-hidden="true" />
                        {updateAvailable && !updateStatus?.can_install ? "打开 Release 下载页" : "查看发布说明"}
                        <span className="sr-only">（在新窗口打开）</span>
                      </a>
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="connectionHeading">
          <div className="mb-2">
            <h3 id="connectionHeading" className="text-[12px] font-semibold">远程连接</h3>
            <p className="mt-0.5 text-[10px] text-muted-foreground">可选适配器不会影响本机离线控制。</p>
          </div>

          <div className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-start gap-3 px-3 py-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground"><Cloud className="size-4" aria-hidden="true" /></span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <strong className="text-[12px] font-medium">Supabase 云端连接</strong>
                  <Badge className="rounded-md px-1.5 py-0.5 text-[9px]" variant={cloudConfigured ? "success" : "secondary"}>{cloudConfigured ? "已配置" : "未配置"}</Badge>
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                  本机的启动、停止、日志和端口操作始终直接连接 FastAPI 控制器。构建时提供 Supabase URL 和匿名密钥后，才启用远程认证与状态同步。
                </p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

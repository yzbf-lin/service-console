"use client";

import { Check, Cloud, Monitor, Moon, Sun } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { isSupabaseConfigured } from "@/lib/supabase";
import type { ResolvedTheme, ThemePreference } from "@/lib/types";
import { cn } from "@/lib/cn";

interface SettingsViewProps {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  onPreferenceChange: (preference: ThemePreference) => void;
}

const themes = [
  { value: "system" as const, label: "跟随系统", description: "随 macOS 外观自动切换", icon: Monitor },
  { value: "light" as const, label: "浅色", description: "始终使用明亮界面", icon: Sun },
  { value: "dark" as const, label: "深色", description: "始终使用低亮度界面", icon: Moon },
];

export function SettingsView({ preference, resolvedTheme, onPreferenceChange }: SettingsViewProps) {
  const cloudConfigured = isSupabaseConfigured();

  return (
    <main id="settingsView" className="no-visible-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto bg-background" aria-labelledby="settingsHeading">
      <header className="flex min-h-16 items-center border-b bg-card/75 px-5">
        <div>
          <h2 id="settingsHeading" className="text-[14px] font-semibold tracking-tight">设置</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">调整本机工作台的外观与可选连接。</p>
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
